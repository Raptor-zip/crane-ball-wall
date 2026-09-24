// The スキン screen and its entry points (GAME_DESIGN.md §7.14): i18n for every catalog entry and rule, the tabs and the
// radio group of cards (keyboard too), NEW marks, try-on, the title / settings buttons, the thumbnails and the share
// card's ball colour. Owner: O7.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SaveV1, Store } from '../../src/store/save';
import { defaultSave, defaultLevelProgress } from '../../src/store/save';
import type { UI, UiAction } from '../../src/ui/ui';
import { BUNDLED_LEVELS, createUI } from '../../src/ui/ui';
import type { SkinsView, UiContext } from '../../src/ui/context';
import { ja } from '../../src/ui/i18n/ja';
import { en } from '../../src/ui/i18n/en';
import { setLang, t } from '../../src/ui/i18n/format';
import { SKINS, type SkinPart } from '../../src/core/skins';
import { buildSkinsView } from '../../src/core/skinState';
import { partLook, type SkinLook } from '../../src/render/skinLooks';
import { TRY_BAND, conditionText } from '../../src/ui/screens/skins';
import { computeLayout } from '../../src/ui/layout';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { skinThumb } from '../../src/ui/skinthumb';
import { drawShareCard } from '../../src/ui/sharecard';
import { installRecorder, parseColour, recorderOf } from '../render/recorder';

const PARTS: SkinPart[] = ['ball', 'crane', 'trail', 'stage'];
const env = { levels: () => BUNDLED_LEVELS };

describe('i18n (§7.14)', () => {
  it('every catalog id has a name and a blurb, every set a name, in ja and en', () => {
    for (const s of SKINS) {
      for (const k of [`skin.${s.id}.name`, `skin.${s.id}.blurb`, `skin.set.${s.set}`]) {
        expect((ja as Record<string, string>)[k], k).toBeTruthy();
        expect((en as Record<string, string>)[k], k).toBeTruthy();
      }
    }
    for (const p of PARTS) expect(ja[`skins.tab.${p}` as keyof typeof ja]).toBeTruthy();
  });

  it('every rule reads as a sentence with its numbers in both languages (no {slot} left)', () => {
    for (const lang of ['ja', 'en'] as const) {
      setLang(lang);
      for (const s of SKINS) {
        const txt = conditionText(s.rule, 3, 7, env);
        expect(txt, s.id).toBeTruthy();
        expect(txt, `${lang} ${s.id}`).not.toMatch(/[{}]|undefined|NaN/);
      }
    }
    setLang('ja');
    expect(conditionText({ k: 'fails', n: 50 }, 12, 50, env)).toBe('しくじり 50回（12/50）');
    expect(conditionText({ k: 'level', id: '2-2' }, 0, 1, env)).toBe('2\u2060-\u20602「原典：いれる」をクリア');   // no break at the hyphen
    // やさしさ exists only on 2-2 and 3-2: the condition names them (and keeps 12.34 N on one line).
    expect(conditionText({ k: 'badge', id: 'yasashisa' }, 0, 1, env)).toBe('バッジ「やさしさ」をとる（2\u2060-\u20602か3\u2060-\u20602を12.34\u00a0N以下でクリア）');
    expect(conditionText({ k: 'badge', id: 'hashidon' }, 0, 1, env)).toBe(`バッジ「${t('badge.hashidon')}」をとる（${t('badge.hashidon.desc')}）`);
    setLang('en');
    expect(conditionText({ k: 'badge', id: 'yasashisa' }, 0, 1, env)).toBe('Earn the "Gentle" badge (clear 2\u2060-\u20602 or 3\u2060-\u20602 at 12.34\u00a0N or less)');
    setLang('ja');
    expect(conditionText({ k: 'crowns', n: 1 }, 0, 1, env)).toBe('王冠を1個とる（AIに勝つ）');
    expect(conditionText({ k: 'streak', n: 7 }, 3, 7, env)).toBe('今日の5球を7日連続（いま3日）');
  });
});

describe('thumbnails', () => {
  it('draw every catalog entry as an SVG from its look (no undefined / NaN in the markup)', () => {
    const c: Pick<SkinLook, 'ball' | 'crane' | 'trail' | 'stage'> = {
      ball: partLook('ball', 'ball.red'), crane: partLook('crane', 'crane.yellow'), trail: partLook('trail', 'trail.ink'), stage: partLook('stage', 'stage.note'),
    };
    const seen = new Set<string>();
    for (const s of SKINS) {
      const svg = skinThumb(s.part, partLook(s.part, s.id), c);
      expect(svg.tagName.toLowerCase()).toBe('svg');
      expect(svg.outerHTML, s.id).not.toMatch(/undefined|NaN/);
      seen.add(svg.innerHTML.replace(/skt\d+/g, 'id'));
    }
    expect(seen.size).toBe(SKINS.length);   // every skin looks different
  });
});

// ---------------------------------------------------------------- the screen

let root: HTMLElement;
let ui: UI;
let save: SaveV1;
let previews: (Partial<Record<SkinPart, string>> | null)[];
let shown: boolean[];
/** Every skinsShown call: open, the sheet's top edge, the top of the attract's frame. */
let shownArgs: [boolean, number | undefined, number | undefined][];
const got: { a: UiAction; p: unknown }[] = [];

function mount(ctxExtra: Partial<UiContext> = {}, withSkins = true, size: [number, number] = [390, 844]): void {
  document.body.innerHTML = '<div id="app"></div>';
  root = document.getElementById('app')!;
  resize(size[0], size[1]);
  const store: Store = { persistent: true, data: () => save, update: (fn) => fn(save), flush: () => undefined };
  const ctx: UiContext = {
    store,
    ...(withSkins ? {
      skins: (): SkinsView => buildSkinsView(save, BUNDLED_LEVELS),
      skinPreview: (ids) => { previews.push(ids); },
      skinsShown: (open, top, frame) => { shown.push(open); shownArgs.push([open, top, frame]); },
    } : {}),
    ...ctxExtra,
  };
  ui = createUI(ctx);
  ui.mount(root);
  got.length = 0;
  for (const a of ['settingsChanged', 'select'] as UiAction[]) ui.on(a, (p) => got.push({ a, p }));
}

beforeEach(() => {
  setLang('ja');
  save = defaultSave('ja');
  save.levels['1-1'] = { ...defaultLevelProgress('h'), cleared: true, attempts: 3 };
  save.skins = { owned: ['trail.pencil', 'ball.steel'], seen: ['trail.pencil'], bestStreak: 0 };
  previews = [];
  shown = [];
  shownArgs = [];
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** The UI root's size (a rotation when the layout kind changes: the UI listens to window resize). */
function resize(w: number, h: number): void {
  Object.defineProperty(root, 'clientWidth', { configurable: true, value: w });
  Object.defineProperty(root, 'clientHeight', { configurable: true, value: h });
}

const q = <T extends HTMLElement = HTMLElement>(sel: string): T | null => root.querySelector<T>(sel);
const screenId = (): string | undefined => q('.yp')!.dataset.screen;
const key = (el: Element, k: string): KeyboardEvent => {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e;
};

describe('entry points', () => {
  it('the title has a スキン button with a NEW dot while skins wait unseen; none without the skins data', () => {
    mount();
    ui.show({ id: 'title' });
    const b = q('.title-skins')!;
    expect(b).not.toBeNull();
    expect(b.querySelector('.skin-dot')).not.toBeNull();
    expect(b.getAttribute('aria-label')).toBe(t('title.skinsNew'));
    save.skins!.seen.push('ball.steel');
    ui.show({ id: 'title' });
    expect(q('.title-skins .skin-dot')).toBeNull();
    mount({}, false);
    ui.show({ id: 'title' });
    expect(q('.title-skins')).toBeNull();
  });

  it('settings: a skins row over the menus, none over the pause menu or a results card', () => {
    mount();
    ui.show({ id: 'select', world: 1 });
    ui.show({ id: 'settings' });
    expect(q('.set-skins')).not.toBeNull();
    q('.set-skins')!.click();
    expect(screenId()).toBe('skins');
    ui.show({ id: 'pause' });
    ui.show({ id: 'settings' });
    expect(q('.set-skins')).toBeNull();
  });
});

describe('the sheet', () => {
  it('opens on the tab with the new skin, marks it seen, keeps its NEW label for this visit', () => {
    mount();
    ui.show({ id: 'title' });
    q('.title-skins')!.click();
    expect(shown).toEqual([true]);
    expect(q('[role="tab"][aria-selected="true"]')!.dataset.part).toBe('ball');
    expect(save.skins!.seen).toEqual(['trail.pencil', 'ball.steel']);
    expect(q('[data-skin="ball.steel"] .newdot')).not.toBeNull();
    // Locked cards: true-colour thumbnail, lock badge, condition in words (and progress when need > 1).
    const lapis = q('[data-skin="ball.lapis"]')!;
    expect(lapis.classList.contains('is-locked')).toBe(true);
    expect(lapis.querySelector('.skin-badge--lock')).not.toBeNull();
    expect(lapis.querySelector('.skin-cond')!.textContent).toBe(conditionText({ k: 'crowns', n: 'all' }, 0, 18, env));
    expect(lapis.querySelector('.skin-bar[role="progressbar"]')!.getAttribute('aria-valuemax')).toBe('18');
    expect(q('[data-skin="ball.red"]')!.getAttribute('aria-checked')).toBe('true');
    expect(q('.skins-egg')).not.toBeNull();   // ball tab: the egg note
  });

  it('tapping an unlocked card equips it (settings.skin + settingsChanged); a locked one is tried on after 150 ms', () => {
    vi.useFakeTimers();
    mount();
    ui.show({ id: 'title' });
    ui.show({ id: 'skins' });
    q('[data-skin="ball.steel"]')!.click();
    expect(save.settings.skin).toEqual({ ball: 'ball.steel' });
    expect(got.find((g) => g.a === 'settingsChanged')!.p).toMatchObject({ skin: { ball: 'ball.steel' } });
    q('[data-skin="ball.point"]')!.click();
    expect(previews).toEqual([]);
    vi.advanceTimersByTime(160);
    expect(previews).toEqual([{ ball: 'ball.point' }]);
    expect(q<HTMLElement>('.skins-try')!.hidden).toBe(false);
    expect(q('[data-skin="ball.point"]')!.classList.contains('is-trying')).toBe(true);
    // The same card again ends the try-on; so does equipping something (at once, in the same look).
    q('[data-skin="ball.point"]')!.click();
    vi.advanceTimersByTime(160);
    expect(previews.at(-1)).toBeNull();
    expect(q<HTMLElement>('.skins-try')!.hidden).toBe(true);
    q('[data-skin="ball.lapis"]')!.click();
    vi.advanceTimersByTime(160);
    q('[data-skin="ball.red"]')!.click();
    expect(previews.at(-1)).toBeNull();
    expect(save.settings.skin).toEqual({ ball: 'ball.red' });
  });

  it('closing (× or Escape) goes back to the opener and ends the try-on; the attract is released', () => {
    vi.useFakeTimers();
    mount();
    ui.show({ id: 'title' });
    ui.show({ id: 'skins' });
    q('[data-skin="ball.wrecker"]')!.click();
    vi.advanceTimersByTime(160);
    key(q('[data-skin="ball.wrecker"]')!, 'Escape');
    expect(screenId()).toBe('title');
    expect(previews.at(-1)).toBeNull();
    expect(shown).toEqual([true, false]);
    ui.show({ id: 'skins' });
    q('.skins-close')!.click();
    expect(screenId()).toBe('title');
    // Closing right after ending a try-on (its end still in the 150 ms debounce) still ends it.
    ui.show({ id: 'skins' });
    q('[data-skin="ball.lapis"]')!.click();
    vi.advanceTimersByTime(160);
    q('[data-skin="ball.lapis"]')!.click();
    q('.skins-close')!.click();
    expect(previews.at(-1)).toBeNull();
  });

  it('keyboard: ← → move between tabs, ↑ ↓ pick the next card; stray keys stay on the sheet', () => {
    vi.useFakeTimers();
    mount();
    ui.show({ id: 'title' });
    ui.show({ id: 'skins', part: 'crane' });
    const tab = q('#skins-tab-crane')!;
    key(tab, 'ArrowRight');
    expect(q('[role="tab"][aria-selected="true"]')!.dataset.part).toBe('trail');
    expect(document.activeElement).toBe(q('#skins-tab-trail'));
    key(q('#skins-tab-trail')!, 'End');
    expect(q('[role="tab"][aria-selected="true"]')!.dataset.part).toBe('stage');
    key(q('#skins-tab-stage')!, 'ArrowLeft');
    key(q('#skins-tab-trail')!, 'ArrowLeft');
    key(q('#skins-tab-crane')!, 'ArrowLeft');
    expect(q('[role="tab"][aria-selected="true"]')!.dataset.part).toBe('ball');
    // Cards: a roving tab stop on the equipped card; the arrows move and pick.
    const cards = [...root.querySelectorAll<HTMLElement>('.skin-card')];
    expect(cards.filter((c) => c.tabIndex === 0).map((c) => c.dataset.skin)).toEqual(['ball.red']);
    cards[0]!.focus();
    key(cards[0]!, 'ArrowDown');
    // The pick shows at once; it is stored (and repainted in core) once the keys settle.
    expect(q('[data-skin="ball.steel"]')!.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(q('[data-skin="ball.steel"]'));
    expect(save.settings.skin).toBeUndefined();
    vi.advanceTimersByTime(160);
    expect(save.settings.skin).toEqual({ ball: 'ball.steel' });
    key(q('[data-skin="ball.steel"]')!, 'ArrowDown');
    vi.advanceTimersByTime(160);
    expect(previews.at(-1)).toEqual({ ball: 'ball.wrecker' });
    const stray = key(q('[data-skin="ball.wrecker"]')!, 'a');
    expect(stray.defaultPrevented).toBe(true);
    expect(key(q('[data-skin="ball.wrecker"]')!, 'F5').defaultPrevented).toBe(false);
  });

  it('holding an arrow key runs through the cards; only the card it stops on is stored and repainted', () => {
    vi.useFakeTimers();
    save.skins!.owned.push('stage.diazo', 'stage.site');
    mount();
    ui.show({ id: 'title' });
    ui.show({ id: 'skins', part: 'stage' });
    const n0 = got.filter((g) => g.a === 'settingsChanged').length;
    q('[data-skin="stage.note"]')!.focus();
    for (let i = 0; i < 6; i++) {
      key(document.activeElement!, 'ArrowDown');
      vi.advanceTimersByTime(40);   // key repeat
    }
    expect(got.filter((g) => g.a === 'settingsChanged').length).toBe(n0);
    const stop = (document.activeElement as HTMLElement).dataset.skin!;
    vi.advanceTimersByTime(160);
    const it = SKINS.find((x) => x.id === stop)!;
    const changes = got.filter((g) => g.a === 'settingsChanged');
    if (save.skins!.owned.includes(stop) || stop === 'stage.note') {
      expect(changes.length).toBe(n0 + 1);
      expect(save.settings.skin).toEqual({ stage: stop });
    } else {
      expect(it.part).toBe('stage');
      expect(previews.at(-1)).toEqual({ stage: stop });
    }
    // Closing with a pick still waiting stores it.
    q('[data-skin="stage.note"]')!.focus();
    key(q('[data-skin="stage.note"]')!, 'Home');
    key(q('[data-skin="stage.note"]')!, 'ArrowDown');
    q('.skins-close')!.click();
    expect(save.settings.skin).toEqual({ stage: 'stage.diazo' });
  });

  it('Enter / Space away from a control do nothing (the title behind the sheet never starts)', () => {
    mount();
    ui.show({ id: 'title' });
    ui.show({ id: 'skins' });
    const reached: string[] = [];
    const spy = (e: KeyboardEvent): void => { reached.push(e.key); };
    window.addEventListener('keydown', spy);
    try {
      const panel = q('.skins-panel')!;
      const enter = key(panel, 'Enter');
      expect(enter.defaultPrevented).toBe(true);
      const space = key(panel, ' ');
      expect(space.defaultPrevented).toBe(false);   // the list still scrolls
      key(q('.yp-layer') ?? panel, 'Enter');
      key(q('.skins-note')!, ' ');
      expect(reached).toEqual([]);
      expect(got.some((g) => g.a === 'select')).toBe(false);
      expect(screenId()).toBe('skins');
      // On a card, Enter / Space are the card's own (native activation), kept from the game too.
      key(q('[data-skin="ball.steel"]')!, 'Enter');
      expect(reached).toEqual([]);
    } finally {
      window.removeEventListener('keydown', spy);
    }
  });

  it('keyboard: a card picked with ↑ ↓ is scrolled into view (the list only); a tap leaves the list where it is', () => {
    vi.useFakeTimers();
    mount();
    ui.show({ id: 'title' });
    ui.show({ id: 'skins', part: 'ball' });
    const panel = q('.skins-panel')!;
    let scrolled = 0;   // a browser keeps scrollTop >= 0
    Object.defineProperty(panel, 'scrollTop', { configurable: true, get: () => scrolled, set: (v: number) => { scrolled = Math.max(0, v); } });
    // A laid-out list: 200 px tall at y 600, cards 84 px tall 92 px apart, moving with the list's scroll.
    const rect = (top: number, h: number): DOMRect => ({ top, bottom: top + h, height: h, left: 0, right: 300, width: 300, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('skins-panel')) return rect(600, 200);
      if (this.classList.contains('skin-card')) return rect(602 + [...this.parentElement!.children].indexOf(this) * 92 - panel.scrollTop, 84);
      return rect(0, 0);
    });
    const inView = (el: Element): boolean => {
      const r = el.getBoundingClientRect();
      return r.top >= 600 + 8 && r.bottom <= 800 - 8;
    };
    q('[data-skin="ball.red"]')!.focus();
    for (let i = 0; i < 3; i++) key(document.activeElement!, 'ArrowDown');
    expect((document.activeElement as HTMLElement).dataset.skin).toBe('ball.point');
    expect(inView(document.activeElement!)).toBe(true);
    expect(panel.scrollTop).toBe(170);
    // ↑ from the first card wraps to the last one, which comes into view too.
    key(document.activeElement!, 'Home');
    expect(panel.scrollTop).toBe(0);
    key(document.activeElement!, 'ArrowUp');
    expect((document.activeElement as HTMLElement).dataset.skin).toBe('ball.lapis');
    expect(inView(document.activeElement!)).toBe(true);
    // A tap on a half-hidden card picks it without moving the list.
    panel.scrollTop = 0;
    q<HTMLElement>('[data-skin="ball.wrecker"]')!.click();
    expect(panel.scrollTop).toBe(0);
  });

  it('Tab stays in the sheet: the roving cards and tabs are one stop each, the last one wraps to the first stop', () => {
    mount();
    ui.show({ id: 'title' });
    ui.show({ id: 'skins', part: 'ball' });
    const red = q('[data-skin="ball.red"]')!;
    red.focus();
    const tab = key(red, 'Tab');
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(q('.skins-close'));
    const back = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    q('.skins-close')!.dispatchEvent(back);
    expect(back.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(red);   // the equipped card (the group's stop), not the last card
    // A locked card on trial (not a Tab stop) is after every stop: Tab wraps (to the try-on tag's ×, now the first
    // stop); Shift+Tab goes back natively.
    const point = q('[data-skin="ball.point"]')!;
    point.focus();
    point.click();
    const onTrial = q('[data-skin="ball.point"]')!;
    expect(document.activeElement).toBe(onTrial);
    expect(key(onTrial, 'Tab').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(q('.skins-try-stop'));
    onTrial.focus();
    const up = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    onTrial.dispatchEvent(up);
    expect(up.defaultPrevented).toBe(false);
  });

  it('a rotation (tall ↔ wide) rebuilds the sheet with the same tab, the try-on and the list where it was', () => {
    vi.useFakeTimers();
    mount();
    ui.show({ id: 'title' });
    q('.title-skins')!.click();
    q('#skins-tab-stage')!.click();
    q('[data-skin="stage.textbook"]')!.click();
    vi.advanceTimersByTime(160);
    expect(previews.at(-1)).toEqual({ stage: 'stage.textbook' });
    q('.skins-panel')!.scrollTop = 120;
    resize(844, 390);
    window.dispatchEvent(new Event('resize'));
    expect(q('.yp')!.dataset.layout).toBe('wide');
    expect(q('[role="tab"][aria-selected="true"]')!.dataset.part).toBe('stage');
    expect(q<HTMLElement>('.skins-try')!.hidden).toBe(false);
    expect(q('[data-skin="stage.textbook"]')!.classList.contains('is-trying')).toBe(true);
    expect(q('.skins-panel')!.scrollTop).toBe(120);
    // The old sheet ended the try-on and the new one sends it again at once (no 150 ms without it).
    expect(previews.slice(-2)).toEqual([null, { stage: 'stage.textbook' }]);
    expect(shown).toEqual([true, false, true]);
    // Closing ends it; opening the sheet again starts afresh.
    q('.skins-close')!.click();
    expect(previews.at(-1)).toBeNull();
    q('.title-skins')!.click();
    expect(q('[role="tab"][aria-selected="true"]')!.dataset.part).toBe('ball');
    expect(q<HTMLElement>('.skins-try')!.hidden).toBe(true);
  });

  it('tall: the sheet hands core its top edge and the top of the attract\'s frame, under the try-on tag', () => {
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(360);
    mount();
    ui.show({ id: 'title' });
    ui.show({ id: 'skins' });
    expect(TRY_BAND).toBeGreaterThanOrEqual(10 + 56);   // the tag: 10 px down, 56 px tall
    expect(shownArgs[0]).toEqual([true, 0, TRY_BAND]);
    // wide: core frames nothing around the side panel.
    mount({}, true, [1280, 720]);
    ui.show({ id: 'title' });
    ui.show({ id: 'skins' });
    expect(shownArgs.at(-1)).toEqual([true, undefined, undefined]);
  });

  it('tall: the sheet keeps room for two cards and more on short phones, and 390x844 keeps its sheet (styles.css)', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/ui/styles.css'), 'utf8');
    const m = /\.yp\[data-layout="tall"\] \.skins-sheet \{[^}]*height: min\(62%, max\(calc\(var\(--deck-h\) \+ var\(--bench-h\) - 8px - var\(--safe-b\)\), ([\d.]+)rem\)\);/.exec(css);
    expect(m).not.toBeNull();
    const floor = Number(m![1]) * 16;
    // Heading, note and tabs take 156 px; two 84 px cards with their gap under them.
    expect(floor - 156).toBeGreaterThanOrEqual(2 * 84 + 8);
    // 390x844 and taller phones: the sheet is the deck and bench band (its top edge on the floor's front edge) as before.
    for (const [w, h] of [[390, 844], [393, 852], [412, 915], [430, 932]] as const) {
      const l = computeLayout(w, h, 3);
      expect(l.deck!.h + (l.bench ?? 0) - 8, `${w}x${h}`).toBeGreaterThanOrEqual(floor);
    }
  });

  it('landscape phones: the try-on tag names the skin only; its condition is a part the short layout hides', () => {
    vi.useFakeTimers();
    mount({}, true, [568, 320]);
    ui.show({ id: 'title' });
    ui.show({ id: 'skins', part: 'crane' });
    expect(q('.yp')!.dataset.short).toBe('1');
    q('[data-skin="crane.lineart"]')!.click();
    const body = q('.skins-try-text > span')!;
    const cond = conditionText({ k: 'badge', id: 'yasashisa' }, 0, 1, env);
    expect(body.textContent).toBe(`${t('skin.crane.lineart.name' as never)} — ${cond}`);
    expect(body.querySelector('.skins-try-cond')!.textContent).toBe(` — ${cond}`);
    const css = readFileSync(resolve(process.cwd(), 'src/ui/styles.css'), 'utf8');
    expect(css).toMatch(/\.yp\[data-short="1"\] \.skins-try-cond \{\s*display: none;/);
  });

  it('a finished set gets the そろった stamp; the tab shows owned / total', () => {
    save.skins!.owned.push('crane.wood', 'stage.diazo');
    mount();
    ui.show({ id: 'skins', part: 'trail' });
    expect(q('[data-skin="trail.pencil"] .skin-stamp')!.textContent).toBe(t('skins.setDone'));
    expect(q('[data-skin="trail.wire"] .skin-stamp')).toBeNull();
    expect(q('#skins-tab-ball b')!.textContent).toBe('2/7');
  });
});

describe('share card', () => {
  let undo: () => void = () => undefined;
  beforeAll(() => { undo = installRecorder(); });
  afterAll(() => undo());

  it('follows the run ball colour (ballFill); the default card is unchanged', () => {
    const lv = BUNDLED_LEVELS.find((l) => l.id === '2-2')!;
    const data = {
      level: lv, ok: true, score: 314, parSub: 324, pbSub: null, wrSub: null, medal: 3 as const, crown: false, nextMedalSub: null,
      gapMm: 6, aiGapMm: 20, peakF: 38, aiPeakF: 40, badges: [], failReason: null, rank: null, aiBeaten: null, replay: null,
      strobe: new Float32Array([0, 0.25, 0.5, 0.3, 1.2, 0.9, 1.63, 0.25]),
    };
    const fills = (fill?: string): string => JSON.stringify(recorderOf(drawShareCard({ ...data, ballFill: fill }, null)).log);
    const lapis = JSON.stringify(parseColour('#23408A'));
    expect(fills()).not.toContain(lapis);
    expect(fills()).toBe(fills(undefined));
    expect(fills('#23408A')).toContain(lapis);
  });
});
