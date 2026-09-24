// Screens that must fit small and short screens without a redesign: the results card, the pause menu, the briefing, the
// level select, the daily hub, the ranking's pinned row, landscape phones (GAME_DESIGN.md §9.4). happy-dom has no layout
// engine: the geometry helpers get stubbed rects, and what only CSS does is checked in the stylesheet itself. The pixels
// are measured in a real browser by tests/e2e/ui-screens.spec.ts (landscape phone 844x390, world rank, ui-3).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { LevelDef } from '../../src/sim/level';
import type { SaveV1, Store } from '../../src/store/save';
import type { ResultsData, UI } from '../../src/ui/ui';
import { BUNDLED_LEVELS, createUI, defaultSettings } from '../../src/ui/ui';
import { BANNER_DELAY_MS } from '../../src/ui/popups';
import { resultsSide, revealRow, stampFollower } from '../../src/ui/results';
import { boardTable, nameWithTag } from '../../src/ui/screens/board';
import { scrollToTiles } from '../../src/ui/screens/select';

const css = readFileSync(resolve(process.cwd(), 'src/ui/styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const lv = (id: string): LevelDef => BUNDLED_LEVELS.find((l) => l.id === id)!;
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Bodies of the rules whose selector list is exactly `sel` (in `text`: the sheet or one block), joined; '' for none. */
function ruleBody(sel: string, text = css): string {
  return [...text.matchAll(new RegExp(`(?:^|[}{\\n])\\s*${esc(sel)}\\s*\\{([^}]*)\\}`, 'g'))].map((m) => m[1]!).join('\n');
}
/** Text of the first `@media` / `@container` block whose prelude is exactly `prelude`. */
function block(prelude: string): string {
  const at = css.indexOf(`${prelude} {`);
  if (at < 0) return '';
  let depth = 0;
  for (let i = css.indexOf('{', at); i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(at, i + 1);
  }
  return '';
}
const px = (v: string | undefined): number => Number(/(-?\d+(?:\.\d+)?)px/.exec(v ?? '')?.[1] ?? NaN);
const prop = (body: string, name: string): string | undefined => new RegExp(`(?:^|[;\\s])${esc(name)}:\\s*([^;]+);`).exec(body)?.[1]?.trim();

/** A fixed rect for happy-dom (getBoundingClientRect is all zeros there). */
function rect(el: Element, top: number, bottom: number): void {
  vi.spyOn(el, 'getBoundingClientRect').mockImplementation(() => ({ top, bottom, left: 0, right: 100, width: 100, height: bottom - top, x: 0, y: top, toJSON: () => ({}) }) as DOMRect);
}

describe('ranking: the pinned 「あなた」 row rests near the bottom edge (findings 4, 19)', () => {
  it('its sticky offset cancels .page-body\'s bottom padding and does not count the safe area twice', () => {
    const pad = prop(ruleBody('.page-body'), 'padding')!;
    // padding: top right bottom left; the bottom is calc(var(--safe-b) + 28px)
    const bottomPad = /calc\(var\(--safe-b\) \+ (\d+)px\)\s+calc\(var\(--safe-l\)/.exec(pad);
    expect(bottomPad).not.toBeNull();
    const pin = ruleBody('.board-pin');
    expect(prop(pin, 'position')).toBe('sticky');
    const bottom = prop(pin, 'bottom')!;
    expect(bottom).not.toContain('safe-b');
    // 10 px above the safe area (the gap the row was written for), not 38 px
    expect(Number(bottomPad![1]) + px(bottom)).toBe(10);
  });
});

describe('results card', () => {
  it('the four medal slots never shrink under their coins (320 px, finding 10)', () => {
    expect(prop(ruleBody('.res-slots'), 'flex-shrink')).toBe('0');
    // `.res-medal > div` still lets the text column shrink
    expect(prop(ruleBody('.res-medal > div'), 'min-width')).toBe('0');
  });

  it('a landscape card of 340 px or less drops the medal slots so the next-medal line stays whole (finding 27)', () => {
    const b = block('@container res (max-width: 340px)');
    expect(prop(ruleBody('.yp[data-layout="wide"] .res-slots', b), 'display')).toBe('none');
    // portrait keeps them
    expect(b).not.toMatch(/\n\s*\.res-slots\s*\{/);
  });

  it('wide: as tall as its content up to 16 px above the bottom; landscape phones down to 8 px, fail card too (findings 12, 31)', () => {
    const wide = ruleBody('.yp[data-layout="wide"] .res');
    expect(prop(wide, 'bottom')).toBeUndefined();
    expect(prop(wide, 'max-height')).toBe('calc(100% - var(--safe-t) - var(--safe-b) - 86px)');
    const short = ruleBody('.yp[data-short="1"][data-layout="wide"] .res');
    expect(prop(short, 'top')).toBe('calc(var(--safe-t) + 8px)');
    expect(prop(short, 'max-height')).toBe('calc(100% - var(--safe-t) - var(--safe-b) - 16px)');
    // no later fail-card rule puts the 70 + 16 px of the tall-enough layout back on a short screen
    expect(css).not.toMatch(/\.yp\[data-layout="wide"\] \.res\[data-fail\]\s*\{/);
  });

  it('a mouse window 366-416 px wide gives each G / H / ? / M toggle its own row (「AIの…」「ミュ…」, finding 41)', () => {
    const b = block('@container res (max-width: 416px)');
    expect(prop(ruleBody('.yp:not([data-pointer="coarse"]) .res-keys', b), 'grid-template-columns')).toBe('minmax(0, 1fr)');
  });

  it('landscape phones: the HUD band does not peek out around the card, ≡ stays clear of a card on the right (finding 28)', () => {
    const hidden = /([^{}]+)\{\s*visibility: hidden;\s*\}/g;
    const sels: string[] = [];
    for (const m of css.matchAll(hidden)) sels.push(...m[1]!.split(',').map((s) => s.trim()));
    const S = '.yp[data-short="1"][data-layout="wide"]';
    expect(sels).toContain(`${S}[data-screen="results"] .hud-center`);
    expect(sels).toContain(`${S}[data-screen="results"] .hud-right .chip--offline`);
    expect(sels).toContain(`${S}[data-screen="results"]:has(.res[data-side="left"]) .hud-band > .hud-btn:first-child`);
    expect(sels).toContain(`${S}[data-screen="pause"] .hud-band`);
    // never the ≡ (the only way from a success card to the level select): a right card moves in by its width instead
    expect(sels.some((s) => s.includes('hud-btn--pause') || s.endsWith('.hud-btn:last-child'))).toBe(false);
    expect(prop(ruleBody(`${S} .res[data-side="right"]`), 'right')).toBe('calc(var(--safe-r) + 64px)');
    // the levels whose card goes right (goal on the left) exist, so the rule is not dead
    expect(BUNDLED_LEVELS.some((l) => resultsSide(l) === 'right')).toBe(true);
  });
});

describe('results card: scrolling (findings 26, 42)', () => {
  const box = (top: number, bottom: number): HTMLElement => {
    const el = document.createElement('div');
    rect(el, top, bottom);
    return el;
  };

  it('revealRow: at 568x320 it scrolls the level name fully out instead of leaving it sliced at the top edge', () => {
    // .res-scroll 10..191, the header 22..50, the rank row 145..207 (numbers measured at 568x320 before the reveal)
    const scroll = box(10, 191);
    const head = box(22, 50);
    head.className = 'res-head';
    scroll.append(head);
    const row = box(145, 207);
    const by: number[] = [];
    scroll.scrollBy = ((o: ScrollToOptions) => by.push(o.top!)) as typeof scroll.scrollBy;
    revealRow(scroll, row, false);
    expect(by).toEqual([40]);             // not 24: that left 「2-2 原典：いれる」 half hidden
  });

  it('revealRow: no change where the header stays whole (568x340) or nothing is below the fold', () => {
    const scroll = box(10, 211);
    const head = box(22, 50);
    head.className = 'res-head';
    scroll.append(head);
    const by: number[] = [];
    scroll.scrollBy = ((o: ScrollToOptions) => by.push(o.top!)) as typeof scroll.scrollBy;
    revealRow(scroll, box(145, 207), false);
    expect(by).toEqual([4]);
    revealRow(scroll, box(100, 160), false);
    expect(by).toEqual([4]);
  });

  it('revealRow: never pushes the row\'s own top out to hide the header', () => {
    const scroll = box(10, 100);
    const head = box(22, 50);
    head.className = 'res-head';
    scroll.append(head);
    const by: number[] = [];
    scroll.scrollBy = ((o: ScrollToOptions) => by.push(o.top!)) as typeof scroll.scrollBy;
    revealRow(scroll, box(45, 110), false);    // needs 18; the header would need 40; the row's top allows 27
    expect(by).toEqual([27]);
  });

  it('stampFollower: the ピタッ stamp stays in its corner until the row under the time reaches it, then leaves with it', () => {
    const scroll = document.createElement('div');
    let st = 0;
    Object.defineProperty(scroll, 'scrollTop', { configurable: true, get: () => st });
    const stamp = document.createElement('div');
    const next = document.createElement('div');
    // the stamp is 181..245 on screen (unlifted), the medal row starts at 314 - scrollTop
    let lift = 0;
    vi.spyOn(stamp, 'getBoundingClientRect').mockImplementation(() => ({ top: 181 - lift, bottom: 245 - lift }) as DOMRect);
    vi.spyOn(next, 'getBoundingClientRect').mockImplementation(() => ({ top: 314 - st, bottom: 366 - st }) as DOMRect);
    const on = stampFollower(scroll, stamp, () => next);
    const at = (s: number): string => {
      st = s;
      on();
      lift = -Number(/translateY\((-?[\d.]+)px\)/.exec(stamp.style.transform)?.[1] ?? 0);
      return stamp.style.transform;
    };
    expect(at(0)).toBe('');
    expect(at(60)).toBe('');                        // the medal row is still below it
    expect(at(120)).toBe('translateY(-51px)');      // 245 - (314 - 120)
    expect(at(183)).toBe('translateY(-114px)');
    expect(at(10)).toBe('');                        // back up: back in its corner
  });

  it('stampFollower: never moves faster than the content (a row already under it at rest does not push it)', () => {
    const scroll = document.createElement('div');
    let st = 0;
    Object.defineProperty(scroll, 'scrollTop', { configurable: true, get: () => st });
    const stamp = document.createElement('div');
    const next = document.createElement('div');
    vi.spyOn(stamp, 'getBoundingClientRect').mockImplementation(() => ({ top: 10, bottom: 74 }) as DOMRect);
    vi.spyOn(next, 'getBoundingClientRect').mockImplementation(() => ({ top: 60 - st, bottom: 100 - st }) as DOMRect);
    const on = stampFollower(scroll, stamp, () => next);
    on();
    expect(stamp.style.transform).toBe('');
    st = 5;
    on();
    expect(stamp.style.transform).toBe('translateY(-5px)');
  });
});

// ---------------------------------------------------------------- createUI (happy-dom)

function mockSave(): SaveV1 {
  return {
    v: 1, id: { secret: 's', pidh: 'a1b2c3d4e5f60718', nameSeed: 7 },
    settings: { ...defaultSettings(), lang: 'ja' },
    levels: {},
    daily: { dayIndex: 0, balls: [null, null, null, null, null], bestSub: null, bestReplay: null, submitted: 'none', lastSentT120: null, streak: 0, lastPlayedDay: -1 },
    outbox: [],
    seen: { onboarding: true, notes: [], aiLostCard: true, storageNotice: false, tricks: [] },
  };
}

function results(level: LevelDef, ok = true): ResultsData {
  return {
    level, ok, score: ok ? 314 : null, parSub: 324, pbSub: 330, wrSub: 300, medal: 3, crown: false, nextMedalSub: 323,
    gapMm: 6, aiGapMm: 20, peakF: 38, aiPeakF: 40, badges: [], failReason: ok ? null : '揺れ 5.2° → 3°未満で成功', rank: 12, aiBeaten: 37,
    replay: 'abc', strobe: new Float32Array([0, 0.25, 1, 0.9, 1.6, 0.25]),
  };
}

let root: HTMLElement;
let ui: UI;
let save: SaveV1;

function mountAt(w: number, hgt: number): void {
  Object.defineProperty(root, 'clientWidth', { configurable: true, value: w });
  Object.defineProperty(root, 'clientHeight', { configurable: true, value: hgt });
  const store: Store = { persistent: true, data: () => save, update: (fn) => fn(save), flush: () => undefined };
  ui = createUI({ store, fetchBoard: async () => null });
  ui.mount(root);
}

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  root = document.getElementById('app')!;
  save = mockSave();
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('results card in the page (findings 28, 42)', () => {
  it('the card listens to its own scroll: the stamp is lifted by the row under the time', () => {
    mountAt(390, 844);
    ui.show({ id: 'results', data: results(lv('2-2')) });
    const scroll = root.querySelector<HTMLElement>('.res-scroll')!;
    const stamp = root.querySelector<HTMLElement>('.res > .res-stamp')!;
    const next = root.querySelector('.res-time')!.nextElementSibling!;
    expect(stamp).not.toBeNull();
    let st = 0;
    Object.defineProperty(scroll, 'scrollTop', { configurable: true, get: () => st, set: (v: number) => { st = v; } });
    vi.spyOn(stamp, 'getBoundingClientRect').mockImplementation(() => ({ top: 181, bottom: 245 }) as DOMRect);
    vi.spyOn(next, 'getBoundingClientRect').mockImplementation(() => ({ top: 314 - st, bottom: 366 - st }) as DOMRect);
    st = 120;
    scroll.dispatchEvent(new Event('scroll'));
    expect(stamp.style.transform).toBe('translateY(-51px)');
  });

  it('landscape phone, card on the right (2-3): the PB banner is placed beside where the card will be (clear of ≡)', () => {
    mountAt(568, 320);
    expect(root.querySelector<HTMLElement>('.yp')!.dataset.short).toBe('1');
    expect(resultsSide(lv('2-3'))).toBe('right');
    vi.useFakeTimers();
    ui.fx({ t: 'levelLoaded', level: lv('2-3') });
    ui.show({ id: 'hud' });
    ui.fx({ t: 'success', score: 300, medal: 3, crown: false, firstCrown: false, pb: true, badges: [] });
    vi.advanceTimersByTime(BANNER_DELAY_MS);
    const banner = root.querySelector<HTMLElement>('.pop--banner[data-kind="pb"]')!;
    expect(banner).not.toBeNull();
    // happy-dom resolves var(--res-w) to 0 px: the free side is [0, 568 - 64] (the card's margin there is 64 px)
    expect(parseFloat(banner.style.left)).toBeCloseTo((568 - 64) / 2, 0);
  });
});

describe('pause menu (findings 20, 40)', () => {
  it('320-340 px tall landscape: tighter margins so a fifth row (practice rewind, assist offer) stays whole', () => {
    const b = block('@media (max-height: 340px)');
    const P = '.yp[data-short="1"][data-screen="pause"]';
    expect(prop(ruleBody(`${P} .center-wrap`, b), 'padding-top')).toBe('calc(var(--safe-t) + 4px)');
    expect(prop(ruleBody(`${P} .center-wrap`, b), 'padding-bottom')).toBe('calc(var(--safe-b) + 4px)');
    expect(prop(ruleBody(`${P} .card-body`, b), 'padding-top')).toBe('6px');
    expect(prop(ruleBody(`${P} .pause-grid`, b), 'row-gap')).toBe('4px');
    // buttons keep their 44 px touch height
    expect(b).not.toMatch(/min-height/);
  });

  it('windows up to 411 px wide hide the key chips (「理科ノー／ト」「リトラ／イ」 with a mouse)', () => {
    const b = block('@media (max-width: 411px)');
    expect(prop(ruleBody('.pause-grid .kbd', b), 'display')).toBe('none');
    expect(block('@media (max-width: 359px)')).not.toContain('.kbd');
  });
});

describe('briefing (finding 30)', () => {
  it('a slash stays with the angle after it: 「64°」「/ 64°」 when the tile wraps, never 「64° /」「64°」', () => {
    mountAt(390, 844);
    ui.show({ id: 'briefing', level: lv('2-2'), ai: { parSub: 324, planT: 2.7, peakF: 40, minGapMm: 20, pumps: 1, calmPath: new Float32Array([0, 0.25, 1, 1]) } });
    const vals = [...root.querySelectorAll('.fact-val')].map((e) => e.textContent);
    expect(vals).toContain('64° / 64°');
    ui.show({ id: 'briefing', level: lv('5-2'), ai: { parSub: 316, planT: 2.6, peakF: 40, minGapMm: 19, pumps: 0, calmPath: new Float32Array([0, 0.25, 1, 1]) } });
    const three = [...root.querySelectorAll('.fact-val')].map((e) => e.textContent).find((v) => v?.includes('°'))!;
    expect(three.split(' ')).toHaveLength(3);                 // two break chances: before each slash
    expect(three).not.toMatch(/\/ /);                          // never a plain space after a slash
  });
});

describe('daily hub (findings 16, 17)', () => {
  it('landscape phones: 「あそぶ」「シェア」 stick to the bottom edge while the figure and the rack scroll', () => {
    const r = ruleBody('.yp[data-short="1"] .daily-card .btnrow');
    expect(prop(r, 'position')).toBe('sticky');
    // flush with the bottom: .page-body's bottom padding is safe-b + 28 px
    expect(px(prop(r, 'bottom'))).toBe(-28);
    expect(prop(r, 'background')).toBe('var(--card)');
    // at rest the band sits where the row was: its padding is taken back by negative margins
    expect(prop(r, 'margin')).toBe('-10px 0 -12px');
    expect(prop(r, 'padding')).toBe('10px 0 12px');
  });

  it('the narrow landscape top 10 drops the gap column and lets a name take two lines', () => {
    expect(prop(ruleBody('.daily-card'), 'container')).toBe('daily / inline-size');
    const b = block('@container daily (max-width: 340px)');
    const W = '.yp[data-layout="wide"] .daily-card .board';
    expect(b).toContain(`${W} th:nth-child(4),\n  ${W} td:nth-child(4) {\n    display: none;`);
    expect(prop(ruleBody(`${W} .b-name`, b), 'white-space')).toBe('normal');
    // the row's pill closes on the time cell
    expect(prop(ruleBody(`${W} td:nth-child(3)`, b), 'border-radius')).toBe('0 10px 10px 0');
    expect(prop(ruleBody(`${W} tr.is-me td:nth-child(3)`, b), 'border-right')).toBe('2px solid var(--ink)');
    expect(ruleBody(`${W} .b-tag::before`, b)).toContain('content: "\\200B"');
  });

  it('names keep their text; the "#1234" tag is its own span (the break point where names wrap)', () => {
    const parts = nameWithTag('Jolly Crane#5974');
    expect(parts[0]).toBe('Jolly Crane');
    expect((parts[1] as HTMLElement).className).toBe('b-tag');
    expect((parts[1] as HTMLElement).textContent).toBe('#5974');
    expect(nameWithTag('NoTag')).toEqual(['NoTag']);
    const table = boardTable([['p1', 7, 330, 6000, 0, 0], ['p2', 8, 340, 9000, 0, 0]], { parSub: 400 });
    const names = [...table.querySelectorAll('.b-name-wrap > span:first-child')];
    expect(names).toHaveLength(2);
    for (const n of names) {
      expect(n.textContent).toMatch(/#\d{4}$/);
      expect(n.querySelector('.b-tag')!.textContent).toMatch(/^#\d{4}$/);
    }
  });
});

describe('level select (findings 18, 29)', () => {
  const at = (el: HTMLElement, top: number, bottom: number): void => rect(el, top, bottom);

  it('scrollToTiles: a first tile cut by the fold brings the world tabs to the top', () => {
    const body = document.createElement('div');
    const tabs = document.createElement('div');
    const tile = document.createElement('div');
    Object.defineProperty(body, 'offsetHeight', { configurable: true, value: 321 });
    at(body, 69, 390);              // 844x390: .page-body
    at(tabs, 203, 269);
    at(tile, 308, 460);
    body.scrollTop = 0;
    scrollToTiles(body, tabs, tile);
    expect(body.scrollTop).toBe(126);   // 203 - 69 - 8: the tab row 8 px under the header's line
  });

  it('scrollToTiles: nothing when the tile is on screen (1280x720, portrait) or there is no open tile', () => {
    const body = document.createElement('div');
    const tabs = document.createElement('div');
    const tile = document.createElement('div');
    Object.defineProperty(body, 'offsetHeight', { configurable: true, value: 651 });
    at(body, 69, 720);
    at(tabs, 203, 269);
    at(tile, 308, 460);
    scrollToTiles(body, tabs, tile);
    expect(body.scrollTop).toBe(0);
    scrollToTiles(body, tabs, null);
    expect(body.scrollTop).toBe(0);
  });

  it('scrollToTiles: measured during the page\'s entry animation (scale 0.985), it scrolls the layout distance', () => {
    const body = document.createElement('div');
    const tabs = document.createElement('div');
    const tile = document.createElement('div');
    Object.defineProperty(body, 'offsetHeight', { configurable: true, value: 400 });
    at(body, 100, 100 + 400 * 0.985);
    at(tabs, 100 + 134 * 0.985, 100 + 200 * 0.985);
    at(tile, 100 + 239 * 0.985, 100 + 450 * 0.985);
    scrollToTiles(body, tabs, tile);
    expect(body.scrollTop).toBeCloseTo(126, 0);
  });

  it('a narrow tile (568-640 px landscape, 320 px portrait) puts the crown in its top-right corner, not across its border', () => {
    expect(prop(ruleBody('.tile'), 'container')).toBe('tile / inline-size');
    const b = block('@container tile (max-width: 120px)');
    const crown = ruleBody('.tile-medals .crown', b);
    expect(prop(crown, 'position')).toBe('absolute');
    expect(prop(crown, 'top')).toBe('10px');
    expect(prop(crown, 'right')).toBe('10px');
    // the same corner as 「スキップ」 on a skipped level (never on a crowned one)
    const skip = ruleBody('.tile-skip');
    expect([prop(skip, 'top'), prop(skip, 'right')]).toEqual(['10px', '10px']);
  });

  it('opens at the world tabs only on a landscape phone, and not while the crown counter pops', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/ui/screens/select.ts'), 'utf8');
    expect(src).toMatch(/if \(!grew && root\.closest\('\.yp'\)\?\.getAttribute\('data-short'\) === '1'\) scrollToTiles\(body, tabRow, firstTile\);/);
  });
});
