// Toast queue across screen changes (popups.ts): read toasts are not replayed, stale ones are dropped. Owner: O7.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOAST_NARROW, createToasts, type ToastArea } from '../../src/ui/popups';

let root: HTMLElement;
let area: ToastArea;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  document.body.innerHTML = '<div id="r"></div>';
  root = document.getElementById('r')!;
  // happy-dom has no layout: a root with a height, so that the area's max count is what decides the room
  Object.defineProperty(root, 'clientHeight', { configurable: true, value: 800 });
  area = { x0: 0, x1: 300, bottom: 600, limit: 100, max: 2 };
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

const texts = (): string[] => [...root.querySelectorAll('.toast')].map((e) => e.textContent ?? '');

describe('toasts', () => {
  it('a toast that was on screen for a while and loses its room on a relayout is dropped, not replayed', () => {
    const t = createToasts(root, () => area);
    t.show('A');
    t.show('B');
    expect(texts()).toEqual(['A', 'B']);
    vi.advanceTimersByTime(1500);
    area = { ...area, max: 1 };
    t.refresh();
    expect(texts()).toEqual(['A']);
    expect(t.pending()).toBe(0);
    vi.advanceTimersByTime(3000); // A expires; B does not come back
    expect(texts()).toEqual([]);
  });

  it('one that only just appeared waits for room instead', () => {
    const t = createToasts(root, () => area);
    t.show('A');
    t.show('B');
    vi.advanceTimersByTime(300);
    area = { ...area, max: 1 };
    t.refresh();
    expect(texts()).toEqual(['A']);
    expect(t.pending()).toBe(1);
    vi.advanceTimersByTime(2700); // A expires -> B shows
    expect(texts()).toEqual(['B']);
  });

  it('a toast that waited more than 8 s for room is dropped', () => {
    area = { ...area, max: 0 };
    const t = createToasts(root, () => area);
    t.show('A');
    expect(texts()).toEqual([]);
    expect(t.pending()).toBe(1);
    vi.advanceTimersByTime(9000);
    area = { ...area, max: 3 };
    t.refresh();
    expect(texts()).toEqual([]);
    expect(t.pending()).toBe(0);
  });

  it('one at a time (tall HUD, landscape phones): a burst of four drains in order, none dropped as stale', () => {
    area = { ...area, max: 1 };
    const t = createToasts(root, () => area);
    for (const x of ['A', 'B', 'C', 'D']) t.show(x);
    const seen: string[][] = [];
    for (const ms of [0, 2900, 2900, 2900, 2900]) {
      vi.advanceTimersByTime(ms);
      seen.push(texts());
    }
    // 2.9 s each: D shows 8.7 s after it was queued (past the plain 8 s limit, inside 8 s + 2 × 2.9 s).
    expect(seen).toEqual([['A'], ['B'], ['C'], ['D'], []]);
    expect(t.pending()).toBe(0);
    // A toast that waited for room longer than that is still dropped.
    area = { ...area, max: 0 };
    t.show('E');
    vi.advanceTimersByTime(14000);
    area = { ...area, max: 1 };
    t.refresh();
    expect(texts()).toEqual([]);
    expect(t.pending()).toBe(0);
  });

  it('drop(kind) removes the visible and waiting toasts of that kind and lets the others in', () => {
    const t = createToasts(root, () => area);
    t.show('badge A', 'badge');
    t.show('badge B', 'badge');
    t.show('world 3', 'info');
    t.show('badge C', 'badge');
    expect(texts()).toEqual(['badge A', 'badge B']);
    expect(t.pending()).toBe(2);
    t.drop('badge');
    expect(texts()).toEqual(['world 3']);
    expect(t.pending()).toBe(0);
  });

  it("'skin' toasts look like 'info' and drop('skin') takes only them (a finished run's unlocks)", () => {
    const t = createToasts(root, () => ({ ...area, max: 3 }));
    t.show('Skin unlocked', 'skin');
    t.show('World 3', 'info');
    const els = [...root.querySelectorAll('.toast')];
    expect(els.map((e) => e.className)).toEqual(['toast toast--info', 'toast toast--info']);
    expect(els[0]!.querySelector('svg')!.outerHTML).toBe(els[1]!.querySelector('svg')!.outerHTML);
    t.drop('skin');
    expect(texts()).toEqual(['World 3']);
  });

  it('a stack narrower than a whole ja phrase is marked data-narrow (no phrase-keeping breaks there)', () => {
    const t = createToasts(root, () => area);
    const box = root.querySelector('.yp-toasts')!;
    area = { ...area, x0: 413, x1: 413 + TOAST_NARROW - 55 };   // 568x320: the corner beside the force bar
    t.show('A');
    expect(box.hasAttribute('data-narrow')).toBe(true);
    area = { ...area, x0: 400, x1: 657 };   // 667x375: beside the results card
    t.refresh();
    expect(box.hasAttribute('data-narrow')).toBe(false);
  });
});
