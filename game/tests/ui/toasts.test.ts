// Toast queue across screen changes (popups.ts): read toasts are not replayed, stale ones are dropped. Owner: O7.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createToasts, type ToastArea } from '../../src/ui/popups';

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
});
