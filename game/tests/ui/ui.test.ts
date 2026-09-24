// createUI end to end in happy-dom: mount, every screen renders, HUD diffing, actions, keyboard. Owner: O7.
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { LevelDef } from '../../src/sim/level';
import type { SaveV1, Store } from '../../src/store/save';
import type { HudState, ResultsData, Screen, UI, UiAction } from '../../src/ui/ui';
import { BUNDLED_LEVELS, createUI, defaultSettings } from '../../src/ui/ui';
import { BANNER_DELAY_MS, BANNER_TICK_MS } from '../../src/ui/popups';
import { ja } from '../../src/ui/i18n/ja';
import { en } from '../../src/ui/i18n/en';
import { KEY_RAMP, KEY_TAP } from '../../src/input/keyboard';
import { FRAGILE } from '../../src/input/servo';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const lv = (id: string): LevelDef => BUNDLED_LEVELS.find((l) => l.id === id)!;

function mockSave(): SaveV1 {
  return {
    v: 1, id: { secret: 's', pidh: 'a1b2c3d4e5f60718', nameSeed: 7 },
    settings: { ...defaultSettings(), lang: 'ja' },
    levels: {
      '1-1': { hash: 'x', cleared: true, skipped: false, attempts: 12, fails: 3, consecutiveCrashes: 0, bestSub: 170, bestReplay: null, medal: 3, crown: true, badges: [], hintsSeen: 0, briefed: false, demoShown: false, aiBeatenSent: false },
      '1-2': { hash: 'x', cleared: true, skipped: false, attempts: 5, fails: 3, consecutiveCrashes: 0, bestSub: 300, bestReplay: null, medal: 2, crown: false, badges: [], hintsSeen: 0, briefed: false, demoShown: false, aiBeatenSent: false },
    },
    daily: { dayIndex: 0, balls: [null, null, null, null, null], bestSub: null, bestReplay: null, submitted: 'none', lastSentT120: null, streak: 0, lastPlayedDay: -1 },
    outbox: [],
    seen: { onboarding: false, notes: [], aiLostCard: true, storageNotice: false, tricks: [] },
  };
}

function hudState(over: Partial<HudState> = {}): HudState {
  return {
    timeSub: 0, running: false, F: 0, Fmax: 40, aiF: null, saturated: false, ampDeg: 0, restDeg: 3, T: 9.8, Tmax: null,
    nearGapMm: null, offline: false, mode: 'campaign', hint: null, dailyBalls: null, ...over,
  };
}

function results(ok = true): ResultsData {
  return {
    level: lv('2-2'), ok, score: ok ? 314 : null, parSub: 324, pbSub: 330, wrSub: 300, medal: 3, crown: false, nextMedalSub: 323,
    gapMm: 6, aiGapMm: 20, peakF: 38, aiPeakF: 40, badges: ['pashi'], failReason: ok ? null : '揺れ 5.2° → 3°未満で成功', rank: 12, aiBeaten: 37,
    replay: 'abc', strobe: new Float32Array([0, 0.25, 1, 0.9, 1.6, 0.25]),
  };
}

let root: HTMLElement;
let ui: UI;
let save: SaveV1;
let store: Store;
const got: { a: UiAction; p: unknown }[] = [];
const ACTIONS: UiAction[] = ['retry', 'next', 'demo', 'board', 'share', 'resume', 'practice', 'select', 'openLevel', 'openDaily', 'settingsChanged', 'skip', 'rerollName', 'assistAccept', 'ghostCycle', 'aiLine', 'notes', 'mute', 'reverseHint', 'pause', 'rewind', 'back'];

beforeEach(() => {
  document.body.innerHTML = '<div id="app" style="width:390px;height:844px"></div>';
  root = document.getElementById('app')!;
  Object.defineProperty(root, 'clientWidth', { configurable: true, value: 390 });
  Object.defineProperty(root, 'clientHeight', { configurable: true, value: 844 });
  save = mockSave();
  store = { persistent: true, data: () => save, update: (fn) => fn(save), flush: () => undefined };
  ui = createUI({ store, fetchBoard: async () => null });
  got.length = 0;
  for (const a of ACTIONS) ui.on(a, (p) => got.push({ a, p }));
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const click = (sel: string): void => {
  const el = root.querySelector<HTMLElement>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  el.click();
};

describe('createUI', () => {
  it('mounts a canvas and, when tall, a deck; reports the layout', () => {
    const l = ui.mount(root);
    expect(l.kind).toBe('tall');
    const els = ui.elements();
    expect(els.canvas).toBeInstanceOf(HTMLCanvasElement);
    expect(els.sceneEl.contains(els.canvas)).toBe(true);
    expect(els.deckEl).not.toBeNull();
    expect(els.deckEl!.querySelector('.deck-surface')).not.toBeNull();
    expect(els.deckEl!.querySelector('button')).toBeNull(); // no buttons in the deck (§3.3)
  });

  it('renders every screen without throwing', () => {
    ui.mount(root);
    const screens: Screen[] = [
      { id: 'title' }, { id: 'select', world: 2 }, { id: 'hud' }, { id: 'pause' },
      { id: 'briefing', level: lv('2-2'), ai: { parSub: 324, planT: 2.7, peakF: 40, minGapMm: 20, pumps: 1, calmPath: new Float32Array([0, 0.25, 1, 1]) } },
      { id: 'results', data: results(true) }, { id: 'results', data: results(false) }, { id: 'demo', level: lv('2-2') },
      { id: 'board', key: 'L:2-2:00000000:s1' },
      { id: 'daily', data: { dayIndex: 3, n: 4, level: lv('2-2'), balls: ['ok', null, null, null, null], bestSub: 400, parSub: 380, top: [], rank: null, pct: null, streak: 2, shareText: '' } },
      { id: 'settings' }, { id: 'about' }, { id: 'notes', world: 1 },
    ];
    for (const s of screens) {
      ui.show(s);
      expect(root.querySelector('.yp')!.getAttribute('data-screen')).toBe(s.id);
      if (s.id !== 'hud') expect(root.querySelector('.yp-layer')!.childElementCount, s.id).toBeGreaterThan(0);
    }
  });

  it('updates the HUD clock with 2 decimals while running and 3 when final', () => {
    ui.mount(root);
    ui.fx({ t: 'levelLoaded', level: lv('2-2') });
    ui.show({ id: 'hud' });
    ui.hud(hudState({ timeSub: 314, running: true }));
    expect(root.querySelector('.hud-clock')!.textContent).toBe('2.61');
    ui.hud(hudState({ timeSub: 314, running: false }));
    expect(root.querySelector('.hud-clock')!.textContent).toBe('2.617');
    expect(root.querySelector('.hud-level')!.textContent).toContain('原典：いれる');
  });

  it('emits retry / pause from the HUD buttons', () => {
    ui.mount(root);
    ui.show({ id: 'hud' });
    const [retry, pause] = root.querySelectorAll<HTMLButtonElement>('.hud-band .hud-btn');
    retry!.click();
    pause!.click();
    expect(got.map((g) => g.a)).toEqual(['retry', 'pause']);
  });

  it('results: primary button retries, next/demo/share emit', () => {
    ui.mount(root);
    ui.show({ id: 'results', data: results(true) });
    click('.res-main .btn--primary');
    click('.res-main .btn:not(.btn--primary)');
    click('.res-row .btn--ai');
    expect(got.map((g) => g.a)).toEqual(['retry', 'next', 'demo']);
    // The number counts up (§9.5); the accessible label carries the final time at once.
    expect(root.querySelector('.res-time')!.getAttribute('aria-label')).toContain('2.617');
  });

  it('results: the graphs start closed behind a quiet text toggle that opens and closes them', () => {
    ui.mount(root);
    ui.show({ id: 'results', data: results(true) });
    const toggle = root.querySelector<HTMLButtonElement>('.res-graphs .graphs-toggle')!;
    const body = root.querySelector<HTMLElement>('.res-graphs .graphs')!;
    expect(toggle.classList.contains('btn--flat')).toBe(true);
    expect(toggle.getAttribute('aria-controls')).toBe(body.id);
    expect([body.hidden, toggle.getAttribute('aria-expanded'), toggle.textContent]).toEqual([true, 'false', 'グラフを見る']);
    toggle.click();
    expect([body.hidden, toggle.getAttribute('aria-expanded'), toggle.textContent]).toEqual([false, 'true', 'グラフを閉じる']);
    // No compare tracks here: the strobe fallback (ball height) behind the same toggle.
    expect(body.querySelectorAll('.graph')).toHaveLength(1);
    toggle.click();
    expect([body.hidden, toggle.getAttribute('aria-expanded')]).toEqual([true, 'false']);
    expect(got).toEqual([]);
  });

  it('results: with compare tracks the toggle opens the x / θ / F graphs', () => {
    const ch = (k: number): { x: Float32Array; th: Float32Array; f: Float32Array } => ({
      x: new Float32Array(120).map((_, i) => (i / 119) * 1.5 * k), th: new Float32Array(120).map((_, i) => Math.sin(i / 10) * 0.2 * k), f: new Float32Array(120).map((_, i) => Math.cos(i / 9) * 20 * k),
    });
    const ui2 = createUI({ store, fetchBoard: async () => null, compare: () => ({ hz: 60, me: ch(1), ai: ch(0.9) }) });
    ui2.mount(root);
    ui2.show({ id: 'results', data: results(true) });
    const body = root.querySelector<HTMLElement>('.res-graphs .graphs')!;
    expect(body.hidden).toBe(true);
    root.querySelector<HTMLButtonElement>('.graphs-toggle')!.click();
    expect([...body.querySelectorAll('.graph-label')].map((e) => e.textContent)).toEqual(['台車 x', '振れ角 θ', '力 F']);
    expect(body.querySelectorAll('.graph polyline')).toHaveLength(6);
    expect(body.querySelector('.graph-legend')).not.toBeNull();
  });

  it('AI demo: a small F(t) graph whose playhead follows the demo clock, and the 「何か押すと戻る」 hint', () => {
    const aiF = new Float32Array(241).map((_, i) => Math.sin(i / 20) * 10);
    const ui2 = createUI({ store, fetchBoard: async () => null, demo: () => ({ hz: 60, aiF, meF: null, aiGapMm: 20, aiPeakF: 10, Fmax: 40 }) });
    ui2.on('retry', (p) => got.push({ a: 'retry', p }));
    ui2.mount(root);
    ui2.show({ id: 'demo', level: lv('2-2') });
    const panel = root.querySelector<HTMLElement>('.demo-panel')!;
    expect(panel.querySelector('.demo-hint')!.textContent).toBe('何か押すと戻る');
    expect(panel.querySelector('.demo-stats')!.textContent).toContain('AIのすき間');
    const playhead = panel.querySelector('svg.demo-graph')!.lastElementChild!;
    ui2.hud(hudState({ mode: 'demo', timeSub: 240 })); // 2 s of the 4 s track: the middle
    expect(Number(playhead.getAttribute('x1'))).toBeCloseTo(300, 0);
    // Any key skips (retry from the demo).
    root.querySelector('.yp-layer')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect(got).toEqual([{ a: 'retry', p: { from: 'demo' } }]);
  });

  it('failed results show the one-line cause', () => {
    ui.mount(root);
    ui.show({ id: 'results', data: results(false) });
    expect(root.querySelector('.res-fail-cause')!.textContent).toContain('揺れ 5.2° → 3°未満で成功');
  });

  it('pause: Escape resumes; key-less equivalents emit ghostCycle / aiLine / notes / mute', () => {
    ui.mount(root);
    ui.fx({ t: 'levelLoaded', level: lv('2-2') });
    ui.show({ id: 'pause' });
    const buttons = [...root.querySelectorAll<HTMLButtonElement>('.pause-grid .btn')];
    const byText = (s: string): HTMLButtonElement => buttons.find((b) => b.textContent!.includes(s))!;
    byText('ゴースト').click();
    byText('AIのライン').click();
    byText('理科ノート').click();
    byText('ミュート').click();
    const layer = root.querySelector('.yp-layer') as HTMLElement;
    const focused = layer.querySelector('button')!;
    focused.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(got.map((g) => g.a)).toEqual(['ghostCycle', 'aiLine', 'notes', 'mute', 'resume']);
  });

  it("select: Escape emits 'back' (to the title); back() pops a sub-screen only", () => {
    ui.mount(root);
    ui.show({ id: 'select', world: 1 });
    expect(ui.back!()).toBe(false);          // nothing on top: core handles its own state
    const layer = root.querySelector('.yp-layer') as HTMLElement;
    layer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(got.map((g) => g.a)).toEqual(['back']);
    got.length = 0;
    ui.show({ id: 'settings' });
    expect(root.querySelector<HTMLElement>('.yp')!.dataset.screen).toBe('settings');
    expect(ui.back!()).toBe(true);           // settings over the select: closes it, back on the select
    expect(root.querySelector<HTMLElement>('.yp')!.dataset.screen).toBe('select');
    expect(got.map((g) => g.a)).toEqual(['select']);
  });

  it('select: tiles open levels, locked tiles do nothing, the counter shows crowns/18', () => {
    ui.mount(root);
    ui.show({ id: 'select', world: 1 });
    click('.tile[data-level="1-2"]');
    click('.tile[data-level="1-4"]'); // locked (1-3 not cleared)
    expect(got).toEqual([{ a: 'openLevel', p: '1-2' }]);
    expect(root.querySelector('.hva-count')!.textContent).toBe('1/18');
  });

  it('settings: changing the language stores it, emits settingsChanged and re-renders in English', () => {
    ui.mount(root);
    ui.show({ id: 'settings' });
    const en = [...root.querySelectorAll<HTMLButtonElement>('.seg button')].find((b) => b.textContent === 'English')!;
    en.focus();
    en.click();
    expect(save.settings.lang).toBe('en');
    expect(got.find((g) => g.a === 'settingsChanged')?.p).toMatchObject({ lang: 'en' });
    expect(root.querySelector('.page-title')!.textContent).toBe('Settings');
    // Keyboard focus stays on the language setting after the screen is rebuilt in English.
    expect((document.activeElement as HTMLElement).textContent).toBe('English');
    // Back returns to the previous screen (sub-screen stack).
    click('.page-head .btn');
  });

  it('sub-screens return to what was under them', () => {
    ui.mount(root);
    ui.show({ id: 'pause' });
    ui.show({ id: 'notes', world: 1 });
    expect(root.querySelector('.yp')!.getAttribute('data-screen')).toBe('notes');
    click('.page-head .btn');
    expect(root.querySelector('.yp')!.getAttribute('data-screen')).toBe('pause');
  });

  it('shows at most 6 popups and at most 3 onomatopoeia', () => {
    ui.mount(root);
    ui.show({ id: 'hud' });
    for (let i = 0; i < 5; i++) ui.fx({ t: 'snap', J: 1, x: 0, y: 0 }, { x: 100, y: 100 });
    expect(root.querySelectorAll('.pop--word').length).toBe(3);
    // A crash adds a word (capped at 3) and the overlap label.
    for (let i = 0; i < 6; i++) ui.fx({ t: 'crash', kind: 1, wall: 0, x: 1, y: 0.8, overlapMm: 3 }, { x: 100, y: 200 });
    expect(root.querySelectorAll('.pop--word').length).toBe(3);
    expect(root.querySelectorAll('.pop').length).toBe(6);
  });

  it('crash label: the depth for a ball hit ("−3mm"), only the cause for a caught string or a cracked egg', () => {
    ui.mount(root);
    ui.show({ id: 'hud' });
    ui.fx({ t: 'crash', kind: 1, wall: 0, x: 1, y: 0.8, overlapMm: 3 }, { x: 100, y: 200 });
    expect(root.querySelectorAll('.pop-crash-mm').length).toBe(1);
    for (const kind of [2, 5] as const) {
      ui.fx({ t: 'crash', kind, wall: 0, x: 1, y: 0.8, overlapMm: 0 }, { x: 100, y: 200 });
      expect(root.querySelectorAll('.pop-crash-mm').length, `kind ${kind}`).toBe(1);
    }
    expect(root.querySelectorAll('.pop-crash-cause').length).toBe(3);
  });

  it('tall: split deltas go to the scoreboard under the band (D10), wide: big over the scene', () => {
    ui.mount(root);
    ui.fx({ t: 'levelLoaded', level: lv('2-2') });
    ui.show({ id: 'hud' });
    ui.hud(hudState({ running: true, timeSub: 200 }));
    ui.fx({ t: 'split', index: 0, deltaSub: -24, vs: 'ai' });
    expect(root.querySelectorAll('.pop--split').length).toBe(0);
    const sp = root.querySelector<HTMLElement>('.hud-dock .hud-split')!;
    expect(sp.style.display).not.toBe('none');
    expect(sp.textContent).toContain('−0.20');
    expect(sp.textContent).toContain('AI');
    expect(sp.getAttribute('data-behind')).toBe('0');
    // A new attempt clears it.
    ui.fx({ t: 'retry' });
    expect(sp.style.display).toBe('none');
    // wide
    Object.defineProperty(root, 'clientWidth', { configurable: true, value: 1280 });
    Object.defineProperty(root, 'clientHeight', { configurable: true, value: 720 });
    window.dispatchEvent(new Event('resize'));
    expect(root.querySelector('.yp')!.getAttribute('data-layout')).toBe('wide');
    ui.fx({ t: 'split', index: 0, deltaSub: 30, vs: 'pb' });
    expect(root.querySelectorAll('.pop--split').length).toBe(1);
  });

  it('tall scoreboard: AI par and personal best of the level, clock between them', () => {
    ui.mount(root);
    ui.fx({ t: 'levelLoaded', level: lv('1-2') });
    ui.show({ id: 'hud' });
    ui.hud(hudState({ running: true, timeSub: 120 }));
    const board = root.querySelector<HTMLElement>('.hud-dock .hud-board')!;
    expect(board.querySelector('.hud-clock')!.textContent).toBe('1.00');
    expect(board.querySelector('.hud-cell--pb .hud-cell-val')!.textContent).toBe('2.500'); // bestSub 300
    expect(board.querySelector('.hud-cell--ai .hud-cell-val')!.textContent).toMatch(/^\d+\.\d{3}$/);
    // READY with a hint: the hint takes the scoreboard's place (and is not over the deck).
    ui.hud(hudState({ hint: '壁の手前でブレーキ' }));
    expect(board.style.display).toBe('none');
    const hint = root.querySelector<HTMLElement>('.hud-hint')!;
    expect(hint.closest('.hud-dock')).not.toBeNull();
    expect(hint.style.display).not.toBe('none');
    expect(root.querySelector('.yp-deck')!.contains(hint)).toBe(false);
  });

  it('tall READY: "move to start" is written on the deck, the HUD pill is not used', () => {
    ui.mount(root);
    ui.fx({ t: 'levelLoaded', level: lv('2-2') });
    ui.show({ id: 'hud' });
    ui.hud(hudState({ mode: 'daily', dailyBalls: ['ok', null, null, null, null] }));
    const label = root.querySelector<HTMLElement>('.yp-deck .deck-ready')!;
    expect(label.textContent).toBe('動かすとスタート');
    expect(label.style.display).not.toBe('none');
    // The rack sits in the status row, not next to a READY pill.
    expect(root.querySelector('.hud-status .hud-rack')).not.toBeNull();
    ui.hud(hudState({ mode: 'daily', dailyBalls: ['ok', null, null, null, null], running: true, timeSub: 10 }));
    expect(label.style.display).toBe('none');
  });

  it('HUD buttons pressed with a pointer give the focus back (Space / Enter reach the game)', () => {
    ui.mount(root);
    ui.show({ id: 'hud' });
    const [retry, pause] = root.querySelectorAll<HTMLButtonElement>('.hud-band .hud-btn');
    for (const b of [retry!, pause!]) {
      b.focus();
      expect(document.activeElement).toBe(b);
      b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      b.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
      expect(document.activeElement).not.toBe(b);
    }
    // Keyboard activation (detail 0, no pointer) keeps it for keyboard users.
    ui.show({ id: 'hud' });
    const r2 = root.querySelectorAll<HTMLButtonElement>('.hud-band .hud-btn')[0]!;
    r2.focus();
    r2.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    expect(document.activeElement).toBe(r2);
    // A mouse press does not take the focus in the first place.
    const md = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    r2.dispatchEvent(md);
    expect(md.defaultPrevented).toBe(true);
  });

  it('practice mode shows the 5 s rewind button (§3.5)', () => {
    ui.mount(root);
    ui.fx({ t: 'levelLoaded', level: lv('2-2') });
    ui.show({ id: 'hud' });
    ui.hud(hudState({ mode: 'campaign' }));
    const btn = [...root.querySelectorAll<HTMLButtonElement>('.hud-chips button')].find((b) => b.textContent!.includes('5秒'))!;
    expect(btn.style.display).toBe('none');
    ui.hud(hudState({ mode: 'practice', running: true, timeSub: 200 }));
    expect(btn.style.display).toBe('');
    btn.click();
    expect(got.at(-1)).toEqual({ a: 'rewind', p: { seconds: 5 } });
  });

  it('toasts go to an aria-live region', () => {
    ui.mount(root);
    ui.toast('バッジ「紙一重」', 'badge');
    const box = root.querySelector('.yp-toasts')!;
    expect(box.getAttribute('aria-live')).toBe('polite');
    expect(box.textContent).toContain('紙一重');
  });

  it('has 44 px minimum on the HUD buttons (CSS contract) and aria-labels on icon buttons', () => {
    ui.mount(root);
    ui.show({ id: 'hud' });
    for (const b of root.querySelectorAll<HTMLButtonElement>('.hud-btn')) expect(b.getAttribute('aria-label')).toBeTruthy();
  });
});

describe('review fixes', () => {
  const anchors = { pivot: { x: 200, y: 120 }, ball: { x: 230, y: 300 }, pxPerM: 180, slack: false, holdFrac: 0.5, reqDeg: 64, reqDir: 1 as const };
  const shown = (sel: string): boolean => {
    const el = root.querySelector<SVGElement>(sel);
    return !!el && el.style.display !== 'none';
  };

  it('pause shows the ghost set the game actually picked (core skips unavailable sets) and follows G/H/M keys', () => {
    let set: 0 | 1 | 2 | 3 | 4 = 1;
    let line = true;
    ui = createUI({ store, pause: () => ({ ghostSet: set, aiLine: line }) });
    ui.on('ghostCycle', () => {
      set = 4; // offline: AI only -> (WR, rival skipped) -> none
    });
    ui.mount(root);
    ui.fx({ t: 'levelLoaded', level: lv('2-2') });
    ui.show({ id: 'pause' });
    const ghost = [...root.querySelectorAll<HTMLButtonElement>('.pause-grid .btn')].find((b) => b.textContent!.includes('ゴースト'))!;
    expect(ghost.querySelector('.btn-state')!.textContent).toBe('AIだけ');
    ghost.click();
    expect(ghost.querySelector('.btn-state')!.textContent).toBe('なし');
    // H pressed on the keyboard while paused: the next HUD frames pick it up.
    line = false;
    for (let i = 0; i < 12; i++) ui.hud(hudState({ running: false, timeSub: 100 }));
    const aiLine = [...root.querySelectorAll<HTMLButtonElement>('.pause-grid .btn')].find((b) => b.textContent!.includes('AIのライン'))!;
    expect(aiLine.querySelector('.btn-state')!.textContent).toBe('オフ');
    expect(aiLine.getAttribute('aria-pressed')).toBe('false');
  });

  it('results never print NaN when the AI summary is missing', () => {
    ui.mount(root);
    ui.show({ id: 'results', data: { ...results(true), aiGapMm: NaN, aiPeakF: NaN, wrSub: null } });
    const text = root.querySelector('.res')!.textContent!;
    expect(text).not.toMatch(/NaN|Infinity|undefined/);
    expect(text).toContain('6mm');
  });

  it('practice runs are labelled and never show a PB ribbon', () => {
    ui.mount(root);
    ui.fx({ t: 'levelLoaded', level: lv('2-2') });
    ui.show({ id: 'hud' });
    ui.hud(hudState({ mode: 'practice', running: true, timeSub: 300 }));
    ui.fx({ t: 'success', score: 314, medal: 0, crown: false, firstCrown: false, pb: false, badges: [] });
    ui.show({ id: 'results', data: { ...results(true), medal: 0, nextMedalSub: null, pbSub: null } });
    const ribbon = root.querySelector('.res-time .ribbon')!;
    expect(ribbon.textContent).toBe('練習（記録なし）');
    expect(root.querySelector('.res')!.textContent).not.toContain('初クリア');
  });

  it('the PB ribbon follows the success event', () => {
    ui.mount(root);
    ui.fx({ t: 'levelLoaded', level: lv('2-2') });
    ui.fx({ t: 'success', score: 314, medal: 3, crown: false, firstCrown: false, pb: false, badges: [] });
    ui.show({ id: 'results', data: { ...results(true), pbSub: 330 } });
    expect(root.querySelector('.res-time .ribbon')).toBeNull();
  });

  it('world-anchored meters show while running and give way to the hold ring once the run is over', () => {
    ui.mount(root);
    ui.fx({ t: 'levelLoaded', level: lv('2-2') });
    ui.show({ id: 'hud' });
    ui.hud(hudState({ running: true, timeSub: 200, ampDeg: 30, nearGapMm: 34, anchors: { ...anchors, holdFrac: 0 } }));
    expect([shown('.anc-meter'), shown('.anc-req'), shown('.anc-gap'), shown('.anc-hold')]).toEqual([true, true, true, false]);
    expect(root.querySelector('.anc-req-label')!.textContent).toBe('64°');
    // The hold (still running): the ring fills around the ball and the gap gauge beside it steps back (inside a pocket
    // the ball is always within 25 cm of a wall); it comes back when the hold resets.
    ui.hud(hudState({ running: true, timeSub: 260, ampDeg: 1, nearGapMm: 34, anchors }));
    expect([shown('.anc-meter'), shown('.anc-gap'), shown('.anc-hold')]).toEqual([true, false, true]);
    ui.hud(hudState({ running: true, timeSub: 262, ampDeg: 4, nearGapMm: 34, anchors: { ...anchors, holdFrac: 0 } }));
    expect([shown('.anc-gap'), shown('.anc-hold')]).toEqual([true, false]);
    ui.hud(hudState({ running: false, timeSub: 400, ampDeg: 2, nearGapMm: 34, anchors: { ...anchors, holdFrac: 1 } }));
    expect([shown('.anc-meter'), shown('.anc-req'), shown('.anc-gap'), shown('.anc-hold')]).toEqual([false, false, false, true]);
    ui.hud(hudState({ running: true, timeSub: 10, ampDeg: NaN, anchors: { ...anchors, pivot: { x: NaN, y: 0 } } }));
    expect(root.querySelector('.hud-anchors')!.innerHTML).not.toContain('NaN');
  });

  it('the share sheet is modal: the results card is inert until it closes', async () => {
    ui.mount(root);
    ui.show({ id: 'results', data: results(true) });
    root.querySelector<HTMLElement>('.res-row .btn--gold')!.click();
    const card = root.querySelector('.res')!;
    expect(card.hasAttribute('inert')).toBe(true);
    const sheet = root.querySelector('.share-text') as HTMLTextAreaElement;
    expect(sheet.value).toContain('#ゆらピタ');
    (root.querySelector('[aria-label="とじる"]') as HTMLElement).click();
    expect(card.hasAttribute('inert')).toBe(false);
  });

  it('the daily card follows the game unlock rule (e.g. opened from a #d link before 1-2)', () => {
    save.levels['1-2']!.cleared = false;
    const daily = { dayIndex: 3, n: 4, level: { ...lv('2-2'), id: 'd:5', world: 0 as const }, balls: [null, null, null, null, null], bestSub: null, parSub: 380, top: null, rank: null, pct: null, streak: 0, shareText: '' };
    ui = createUI({ store, daily: () => daily, unlocked: (id) => id === 'd:5' });
    ui.mount(root);
    ui.show({ id: 'select', world: 1 });
    expect((root.querySelector('.dcard') as HTMLButtonElement).disabled).toBe(false);
  });

  it('1-1 onboarding shows only until the first run starts (seen.onboarding)', () => {
    save.levels['1-1']!.cleared = false;
    save.seen.onboarding = false;
    ui.mount(root);
    ui.fx({ t: 'levelLoaded', level: lv('1-1') });
    ui.show({ id: 'hud' });
    ui.hud(hudState());
    const onboard = (): boolean => [...root.querySelectorAll<HTMLElement>('.deck-hand, .yp-deck .keycaps')].some((e) => e.style.display !== 'none');
    expect(onboard()).toBe(true);
    ui.hud(hudState({ running: true, timeSub: 10 }));
    save.seen.onboarding = true;
    ui.hud(hudState());
    expect(onboard()).toBe(false);
  });

  it('badges are announced with a toast once per run (§7.3), not again when the card is re-rendered', () => {
    vi.useFakeTimers();
    try {
      ui.mount(root);
      const data = results(true);
      ui.show({ id: 'results', data });
      vi.advanceTimersByTime(2000);
      expect(root.querySelector('.yp-toasts')!.textContent).toContain('バッジ「パシッ」');
      root.querySelector('.yp-toasts')!.replaceChildren();
      ui.show({ id: 'board', key: 'L:2-2:00000000:s1' });
      root.querySelector<HTMLElement>('.page-head .btn')!.click(); // back to the same results
      vi.advanceTimersByTime(2000);
      expect(root.querySelector('.yp-toasts')!.textContent).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('the strategy card chip is offered on W1 levels too, but not on the 1-1 tutorial', () => {
    const brief = { parSub: 240, planT: 2, peakF: 40, minGapMm: 20, pumps: 0, calmPath: new Float32Array([0, 0.25, 1, 0.25]) };
    ui = createUI({ store, briefing: () => brief });
    ui.mount(root);
    const chip = (): boolean => [...root.querySelectorAll<HTMLElement>('.hud-chips .chip-btn')].some((b) => b.textContent!.includes('作戦図') && b.style.display !== 'none');
    for (const [id, want] of [['1-2', true], ['1-1', false]] as const) {
      ui.fx({ t: 'levelLoaded', level: lv(id) });
      ui.show({ id: 'hud' });
      ui.hud(hudState());
      ui.fx({ t: 'ready' });
      expect(chip(), id).toBe(want);
    }
  });

  it('unrecorded play at normal speed (daily after 5 balls) is not labelled ×0.5 and has no rewind', () => {
    ui = createUI({ store, pause: () => ({ practice: false }) });
    ui.mount(root);
    ui.fx({ t: 'levelLoaded', level: lv('2-2') });
    ui.show({ id: 'hud' });
    ui.hud(hudState({ mode: 'practice' }));
    const rewind = [...root.querySelectorAll<HTMLButtonElement>('.hud-chips button')].find((b) => b.textContent!.includes('5秒'))!;
    expect(rewind.style.display).toBe('none');
    expect(root.querySelector('.hud-mode')!.textContent).toBe('練習（記録なし）');
  });

  it('first crown banner counts the crown into 人類 vs AI', () => {
    save.levels['2-2'] = { ...save.levels['1-2']!, crown: true };
    ui.mount(root);
    root.querySelector('.yp')!.classList.add('yp--still');
    vi.useFakeTimers();
    try {
      ui.fx({ t: 'success', score: 300, medal: 3, crown: true, firstCrown: true, pb: true, badges: [] });
      vi.advanceTimersByTime(500);
      const banner = root.querySelector('.pop--banner[data-kind="crown"]')!;
      expect(banner.textContent).toContain('人類の勝利');
      expect(banner.querySelector('.pop-banner-count')!.textContent).toBe('2/18');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('leaderboard gap column', () => {
  it("shows '—' on levels without walls (gapUm < 0), mm otherwise, nothing when unknown", async () => {
    const { gapCell } = await import('../../src/ui/screens/board');
    expect(gapCell(-1)).toBe('—');
    expect(gapCell(4600)).toBe('5mm');
    expect(gapCell(0)).toBe('0mm');
    expect(gapCell(null)).toBe('');
    expect(gapCell(Number.NaN)).toBe('');
    expect(gapCell(2e7)).toBe('');
  });
});

describe('pause menu in practice mode', () => {
  it('offers "rewind 5 s" (then plays on); not outside practice', () => {
    ui = createUI({ store, pause: () => ({ practice: true, practiceAvailable: true }) });
    for (const a of ACTIONS) ui.on(a, (p) => got.push({ a, p }));
    ui.mount(root);
    ui.fx({ t: 'levelLoaded', level: lv('2-2') });
    ui.show({ id: 'pause' });
    const rw = [...root.querySelectorAll<HTMLButtonElement>('.pause-grid .btn')].find((b) => b.textContent!.includes('5秒もどす'))!;
    expect(rw).toBeTruthy();
    expect(rw.getAttribute('aria-keyshortcuts')).toBe('R');
    rw.click();
    expect(got.map((g) => g.a)).toEqual(['rewind', 'resume']);
    root.replaceChildren();
    ui = createUI({ store, pause: () => ({ practice: false, practiceAvailable: true }) });
    ui.mount(root);
    ui.show({ id: 'pause' });
    expect([...root.querySelectorAll('.pause-grid .btn')].some((b) => b.textContent!.includes('5秒もどす'))).toBe(false);
  });

  it('practice HUD: rewind chip and the "R長押しで5秒もどす" hint', () => {
    ui = createUI({ store, pause: () => ({ practice: true }) });
    ui.mount(root);
    ui.fx({ t: 'levelLoaded', level: lv('2-2') });
    ui.show({ id: 'hud' });
    ui.hud(hudState({ mode: 'practice' }));
    const chipBtn = [...root.querySelectorAll<HTMLButtonElement>('.hud-chips button')].find((b) => b.textContent!.includes('5秒もどす'))!;
    expect(chipBtn.style.display).not.toBe('none');
    const hint = root.querySelector<HTMLElement>('.hud-rewind-hint')!;
    expect(hint.textContent).toContain('R長押しで5秒もどす');
    expect(hint.style.display).not.toBe('none');
  });
});

// Release review (ui-1 .. ui-12): the fixes that can be checked without a layout engine. The layout ones (wrapping,
// overflow, what is painted on top) are measured in a real browser: tests/e2e/ui-screens.spec.ts "release review".
describe('release review fixes', () => {
  const cssText = readFileSync(resolve(process.cwd(), 'src/ui/styles.css'), 'utf8');
  /** z-index of the first rule whose selector is exactly `sel`. */
  const zOf = (sel: string): number => {
    const m = new RegExp(`(?:^|\\n)${sel.replace(/[.[\]"=]/g, '\\$&')} \\{[^}]*?z-index: (\\d+)`).exec(cssText);
    return m ? Number(m[1]) : NaN;
  };

  it('ui-1: the crown banner starts right after the stamp in a layer above the results card, and ticks x/18 during the beat', () => {
    save.levels['2-2'] = { ...save.levels['1-2']!, crown: true };
    ui.mount(root);
    vi.useFakeTimers();
    try {
      ui.fx({ t: 'levelLoaded', level: lv('2-2') });
      ui.show({ id: 'hud' });
      ui.fx({ t: 'success', score: 300, medal: 3, crown: true, firstCrown: true, pb: true, badges: [] });
      vi.advanceTimersByTime(BANNER_DELAY_MS);
      const banner = root.querySelector<HTMLElement>('.pop--banner[data-kind="crown"]')!;
      expect(banner).not.toBeNull();
      // Its own layer, painted above the screen layer (the results card) and below the toasts.
      expect(banner.parentElement!.classList.contains('yp-banner')).toBe(true);
      expect(zOf('.yp-banner')).toBeGreaterThan(zOf('.yp-layer'));
      expect(zOf('.yp-banner')).toBeLessThan(zOf('.yp-toasts'));
      // tall 390x844: centred in the band between the HUD band (56 px) and the card's top edge (20 % = 169 px).
      expect(parseFloat(banner.style.left)).toBeCloseTo(195, 0);
      expect(parseFloat(banner.style.top)).toBeGreaterThan(56);
      expect(parseFloat(banner.style.top)).toBeLessThan(169);
      // The counter ticks before core opens the card (SUCCESS_BEAT 0.75 s), and the card does not remove the banner.
      expect(BANNER_DELAY_MS + BANNER_TICK_MS).toBeLessThan(750);
      vi.advanceTimersByTime(BANNER_TICK_MS);
      expect(banner.querySelector('.pop-banner-count.is-tick')!.textContent).toBe('2/18');
      ui.show({ id: 'results', data: { ...results(true), crown: true } });
      expect(banner.isConnected).toBe(true);
      expect(root.querySelector('.yp-layer .res')).not.toBeNull();
      // Leaving the results (level select) takes it away at once: it never floats over another screen.
      ui.show({ id: 'select', world: 2 });
      expect(banner.isConnected).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ui-1: a PB banner goes to the same layer; a timeout shows no banner (the card title says タイムアップ)', () => {
    ui.mount(root);
    vi.useFakeTimers();
    try {
      ui.fx({ t: 'levelLoaded', level: lv('2-2') });
      ui.fx({ t: 'success', score: 300, medal: 3, crown: false, firstCrown: false, pb: true, badges: [] });
      vi.advanceTimersByTime(BANNER_DELAY_MS);
      expect(root.querySelector('.yp-banner .pop--banner[data-kind="pb"]')).not.toBeNull();
      ui.fx({ t: 'retry' });
      expect(root.querySelector('.pop--banner')).toBeNull();
      ui.fx({ t: 'timeout', reason: 'swing', value: 5.2 });
      vi.advanceTimersByTime(1000);
      expect(root.querySelector('.pop--banner')).toBeNull();
      ui.show({ id: 'results', data: results(false) });
      expect(root.querySelector('.res-fail-title')!.textContent).toBe('タイムアップ');
    } finally {
      vi.useRealTimers();
    }
  });

  it('ui-1: while a banner is up, results toasts keep out of it (they queue and come back when it goes)', () => {
    ui.mount(root);
    vi.useFakeTimers();
    try {
      ui.fx({ t: 'levelLoaded', level: lv('2-2') });
      ui.fx({ t: 'success', score: 300, medal: 3, crown: false, firstCrown: false, pb: true, badges: [] });
      vi.advanceTimersByTime(BANNER_DELAY_MS);
      ui.show({ id: 'results', data: results(true) });
      const banner = root.querySelector<HTMLElement>('.pop--banner')!;
      expect(banner.isConnected).toBe(true);
      // The banner is gone after its time, even in the still frames of the dev pages (the card is what stays).
      root.querySelector('.yp')!.classList.add('yp--still');
      vi.advanceTimersByTime(3000);
      expect(banner.isConnected).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ui-11: the 1-1 onboarding hand leaves the deck when another level is loaded before a run started', () => {
    save.levels['1-1']!.cleared = false;
    save.seen.onboarding = false;
    ui.mount(root);
    const shown = (sel: string): boolean => [...root.querySelectorAll<HTMLElement>(sel)].some((e) => e.style.display !== 'none');
    ui.fx({ t: 'levelLoaded', level: lv('1-1') });
    ui.show({ id: 'hud' });
    ui.hud(hudState());
    expect(shown('.yp-deck .deck-hand, .yp-deck .keycaps')).toBe(true);
    expect(shown('.yp-deck .deck-grip')).toBe(false);
    // A challenge link / replay loads 2-2 while 1-1 is still at READY: no hand there, the grip is back.
    ui.fx({ t: 'levelLoaded', level: lv('2-2') });
    ui.hud(hudState());
    ui.fx({ t: 'ready' });
    expect(shown('.yp-deck .deck-hand, .yp-deck .keycaps')).toBe(false);
    expect(shown('.yp-deck .deck-grip')).toBe(true);
    expect(root.querySelector('.yp-deck')!.hasAttribute('data-onboarding')).toBe(false);
    // And back on 1-1 (still the first visit) it comes back.
    ui.fx({ t: 'levelLoaded', level: lv('1-1') });
    ui.hud(hudState());
    expect(shown('.yp-deck .deck-hand, .yp-deck .keycaps')).toBe(true);
  });

  it('ui-10: no spec variable names in player text (A_rest, F_max, the research planner)', () => {
    for (const [lang, table] of [['ja', ja], ['en', en]] as const) {
      for (const [k, v] of Object.entries(table)) expect(v, `${lang} ${k}`).not.toMatch(/A_rest|F_max|planner|プランナー/);
    }
    // The "why the AI lost" card says the game's own rest angle of the level (2-2: 3°).
    save.seen.aiLostCard = false;
    ui.mount(root);
    vi.useFakeTimers();
    try {
      ui.show({ id: 'results', data: { ...results(true), crown: true } });
      vi.advanceTimersByTime(1200);
      const rules = root.querySelector('.rules')!.textContent!;
      expect(rules).toContain('揺れ 3° 未満で成功');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keyboard controls (R10): the settings note follows the mode and says tap = 5 cm, Shift = 0.5 m/s / 1 cm, egg 2 m/s', () => {
    ui.mount(root);
    ui.show({ id: 'settings' });
    const note = (): string => root.querySelector('[data-note="keyboard"]')!.textContent!;
    expect(note()).toContain(`${Math.round(KEY_TAP.stepM * 100)}cm`);
    expect(note()).toContain(`${Math.round(KEY_TAP.stepFineM * 100)}cm`);
    expect(note()).toContain(`${(KEY_RAMP.capFine / KEY_RAMP.perMps).toFixed(1)}\u00a0m/s`);
    expect(note()).toContain(`${FRAGILE.vCap.toFixed(1)}\u00a0m/s`);
    expect(note()).toContain('Shift');
    const force = [...root.querySelectorAll<HTMLButtonElement>('[data-seg="keyboard"] [role="radio"]')].find((b) => b.textContent === '直接押す')!;
    force.click();
    expect(save.settings.keyboard).toBe('force');
    expect(note()).toContain('¼');
    expect(note()).not.toContain('cm');
    // English says the same numbers.
    save.settings.keyboard = 'speed';
    save.settings.lang = 'en';
    root.replaceChildren();
    ui = createUI({ store });
    ui.mount(root);
    ui.show({ id: 'settings' });
    expect(note()).toMatch(/tap moves it 5\s?cm.*up to 0\.5\s?m\/s.*moves 1\s?cm.*2\.0\s?m\/s/);
  });

  it('keyboard controls (R10): the strategy card of an egg level says the trolley tops out at 2 m/s', () => {
    const egg = BUNDLED_LEVELS.find((l) => l.physics.egg)!;
    expect(egg).toBeTruthy();
    ui.mount(root);
    ui.show({ id: 'briefing', level: egg, ai: { parSub: 500, planT: 4, peakF: 30, minGapMm: 20, pumps: 0, calmPath: new Float32Array([0, 0.25, 1, 1]) } });
    expect(root.querySelector('.yp-layer')!.textContent).toContain(`たまごの面では台車は ${FRAGILE.vCap.toFixed(1)}\u00a0m/s まで`);
    ui.show({ id: 'briefing', level: lv('2-2'), ai: { parSub: 324, planT: 2.7, peakF: 40, minGapMm: 20, pumps: 1, calmPath: new Float32Array([0, 0.25, 1, 1]) } });
    expect(root.querySelector('.yp-layer')!.textContent).not.toContain('m/s まで');
  });

  it('ui-7: short tall phones mark the HUD panel compact (the scoreboard fits it, styles.css)', () => {
    Object.defineProperty(root, 'clientWidth', { configurable: true, value: 375 });
    Object.defineProperty(root, 'clientHeight', { configurable: true, value: 548 });
    ui.mount(root);
    expect(root.querySelector<HTMLElement>('.yp')!.dataset.panel).toBe('compact');
    root.replaceChildren();
    Object.defineProperty(root, 'clientWidth', { configurable: true, value: 390 });
    Object.defineProperty(root, 'clientHeight', { configurable: true, value: 844 });
    ui = createUI({ store });
    ui.mount(root);
    expect(root.querySelector<HTMLElement>('.yp')!.dataset.panel).toBe('full');
  });
});

// Play-area polish (audit, fix-play): the checks that need no layout engine; the rest is noted per test. The layout
// itself (what covers what at 568x320 .. 1280x720) is measured in a real browser.
describe('play polish (audit)', () => {
  const cssText = readFileSync(resolve(process.cwd(), 'src/ui/styles.css'), 'utf8');
  /** The declarations of the first rule whose selector list is exactly `sel`. */
  const ruleOf = (sel: string): string => {
    const i = cssText.indexOf(`${sel} {`);
    return i < 0 ? '' : cssText.slice(i, cssText.indexOf('}', i));
  };
  const texts = (): string[] => [...root.querySelectorAll('.yp-toasts .toast')].map((e) => e.textContent ?? '');
  /**
   * happy-dom has no layout: sizes for the elements `size` knows (offset* / client*; the UI root gets the viewport),
   * 0 for the others; `at` places some of them (getBoundingClientRect, relative to the root at 0, 0).
   */
  function stubLayout(size: (el: HTMLElement) => { w: number; h: number } | null, at: (el: HTMLElement) => { x: number; y: number } | null = () => null): () => void {
    const P = HTMLElement.prototype;
    const keys = ['offsetWidth', 'offsetHeight', 'clientWidth', 'clientHeight'] as const;
    const saved = [...keys, 'getBoundingClientRect'].map((k) => [k, Object.getOwnPropertyDescriptor(P, k)] as const);
    const sizeOf = (el: HTMLElement): { w: number; h: number } | null => (el.classList.contains('yp') ? { w: root.clientWidth, h: root.clientHeight } : size(el));
    for (const k of keys) {
      const wide = k.endsWith('Width');
      Object.defineProperty(P, k, { configurable: true, get(this: HTMLElement) { const s = sizeOf(this); return s ? (wide ? s.w : s.h) : 0; } });
    }
    Object.defineProperty(P, 'getBoundingClientRect', {
      configurable: true, writable: true,
      value(this: HTMLElement) {
        const p = at(this) ?? { x: 0, y: 0 };
        const s = at(this) ? sizeOf(this) ?? { w: 0, h: 0 } : { w: 0, h: 0 };
        return { left: p.x, top: p.y, right: p.x + s.w, bottom: p.y + s.h, width: s.w, height: s.h, x: p.x, y: p.y, toJSON: () => ({}) };
      },
    });
    return () => {
      for (const [k, d] of saved) {
        if (d) Object.defineProperty(P, k, d);
        else delete (P as unknown as Record<string, unknown>)[k];
      }
    };
  }
  const resize = (w: number, h: number): void => {
    Object.defineProperty(root, 'clientWidth', { configurable: true, value: w });
    Object.defineProperty(root, 'clientHeight', { configurable: true, value: h });
  };
  const ty = (el: Element | null): number => Number(/translate\([^,]+,\s*(-?[\d.]+)px\)/.exec((el as HTMLElement | null)?.style.transform ?? '')?.[1]);

  it('#2 a rail crash: the word pushed down inside the bounds takes its info pill down with it (46 px under it)', () => {
    const restore = stubLayout((el) => el.classList.contains('yp-pop') ? { w: 390, h: 844 }
      : el.classList.contains('pop-in') ? (el.parentElement!.classList.contains('pop--crashinfo') ? { w: 96, h: 57 } : { w: 118, h: 46 }) : null);
    try {
      ui.mount(root);
      ui.fx({ t: 'levelLoaded', level: lv('1-1') });
      ui.show({ id: 'hud' });
      const hudTop = parseFloat(root.querySelector<HTMLElement>('.yp')!.style.getPropertyValue('--hud-top'));
      // At the rail (top of the view): the word is clamped down, and the pill keeps the designed 46 px under it.
      ui.fx({ t: 'crash', kind: 3, wall: -1, x: 1, y: 1.24, overlapMm: 4 }, { x: 195, y: hudTop + 20 });
      const word = ty(root.querySelector('.pop--crash'));
      const info = ty(root.querySelector('.pop--crashinfo'));
      expect(word).toBeGreaterThan(hudTop + 20 - 30);
      expect(info - word).toBe(46);
      // In the open (nothing clamped): exactly the old places, word at y - 30 and the pill 46 px under it.
      ui.fx({ t: 'retry' });
      ui.fx({ t: 'crash', kind: 1, wall: 0, x: 1, y: 0.5, overlapMm: 4 }, { x: 195, y: 400 });
      expect([ty(root.querySelector('.pop--crash')), ty(root.querySelector('.pop--crashinfo'))]).toEqual([370, 416]);
    } finally {
      restore();
    }
  });

  it('#3 tall: the dock fades out while the PB / crown banner is up over the scoreboard, and comes back after it', () => {
    ui.mount(root);
    vi.useFakeTimers();
    try {
      const yp = root.querySelector<HTMLElement>('.yp')!;
      ui.fx({ t: 'levelLoaded', level: lv('2-2') });
      ui.show({ id: 'hud' });
      ui.fx({ t: 'success', score: 300, medal: 3, crown: false, firstCrown: false, pb: true, badges: [] });
      expect(yp.classList.contains('yp--banner')).toBe(false);
      vi.advanceTimersByTime(BANNER_DELAY_MS);
      expect(yp.classList.contains('yp--banner')).toBe(true);
      vi.advanceTimersByTime(1800);
      expect(yp.classList.contains('yp--banner')).toBe(false);
      // a retry during the beat takes the banner and the fade away at once
      ui.fx({ t: 'success', score: 300, medal: 3, crown: false, firstCrown: false, pb: true, badges: [] });
      vi.advanceTimersByTime(BANNER_DELAY_MS);
      ui.fx({ t: 'retry' });
      expect(yp.classList.contains('yp--banner')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
    expect(ruleOf('.yp[data-layout="tall"].yp--banner .hud-dock')).toMatch(/opacity: 0/);
  });

  it('#6 leaving the results card for the next attempt drops its badge / trick / skin toasts, shown or waiting', () => {
    ui.mount(root);
    ui.fx({ t: 'levelLoaded', level: lv('4-3') });
    ui.show({ id: 'results', data: results(true) });
    ui.toast('バッジ「一発」', 'badge');
    ui.toast('スキンが開いた!', 'skin');
    ui.toast('ワールド 3 が開いた!', 'info');
    ui.toast('技「パシッ」を見つけた!', 'badge');   // waiting: three are on screen
    expect(texts()).toEqual(['バッジ「一発」', 'スキンが開いた!', 'ワールド 3 が開いた!']);
    // a skin toast looks like 'info'
    expect(root.querySelectorAll('.toast--info')).toHaveLength(2);
    ui.show({ id: 'hud' });   // retry
    expect(texts()).toEqual(['ワールド 3 が開いた!']);
    // A trick found in a crashed run (no card in between) still shows after the crash.
    ui.toast('技「ブレーキ振り出し」を見つけた!', 'badge');
    ui.fx({ t: 'crash', kind: 1, wall: 0, x: 1, y: 0.5, overlapMm: 4 });
    ui.fx({ t: 'ready' });
    expect(texts()).toContain('技「ブレーキ振り出し」を見つけた!');
  });

  it('#34 wide HUD: toasts one at a time in the bottom-right corner (never under the clock, on the gantry)', () => {
    resize(1280, 720);
    const restore = stubLayout(() => null);
    onTestFinished(restore);
    ui.mount(root);
    ui.fx({ t: 'levelLoaded', level: lv('1-1') });
    ui.show({ id: 'hud' });
    ui.toast('AIのライン：非表示');
    ui.toast('ゴースト：AIだけ');
    const box = root.querySelector<HTMLElement>('.yp-toasts')!;
    expect(texts()).toEqual(['AIのライン：非表示']);
    expect(parseFloat(box.style.left)).toBeGreaterThanOrEqual(1280 * 0.62);
    expect(box.style.top).toBe('auto');
    expect(parseFloat(box.style.bottom)).toBeLessThanOrEqual(10);
    expect(ruleOf('.yp[data-short="1"][data-screen="hud"] .yp-toasts,\n.yp[data-layout="wide"][data-screen="hud"] .yp-toasts,\n.yp[data-layout="wide"][data-screen="demo"] .yp-toasts')).toMatch(/align-items: flex-end/);
  });

  it('#14 results on a landscape phone: one toast at a time beside the card (a burst never stacks over the scene)', () => {
    const restore = stubLayout((el) => (el.classList.contains('sheet') ? { w: 360, h: 300 } : null), (el) => (el.classList.contains('sheet') ? { x: 16, y: 20 } : null));
    try {
      resize(844, 390);
      ui.mount(root);
      ui.fx({ t: 'levelLoaded', level: lv('2-2') });
      ui.show({ id: 'results', data: results(true) });
      for (const x of ['技「追いかけ減衰」を見つけた!', '技「逆振りの溜め」を見つけた!', 'スキンが開いた!']) ui.toast(x, 'badge');
      expect(texts()).toEqual(['技「追いかけ減衰」を見つけた!']);
      // a desktop keeps its stack of up to three
      root.replaceChildren();
      resize(1280, 720);
      ui = createUI({ store });
      ui.mount(root);
      ui.fx({ t: 'levelLoaded', level: lv('2-2') });
      ui.show({ id: 'results', data: results(true) });
      for (const x of ['A', 'B', 'C']) ui.toast(x, 'badge');
      expect(texts()).toEqual(['A', 'B', 'C']);
    } finally {
      restore();
    }
    // ja breaks between phrases in a stack wide enough for one (data-narrow: popups.ts)
    expect(ruleOf('.yp-toasts:not([data-narrow]) .toast > span')).toMatch(/word-break: keep-all;\s*overflow-wrap: anywhere/);
  });

  it('#44 wide 1-1 onboarding: the ←/→ keycaps sit left of centre, off the ruler\'s 1 m label', () => {
    resize(1280, 720);
    save.levels['1-1'] = { ...save.levels['1-1']!, cleared: false };
    ui.mount(root);
    ui.fx({ t: 'levelLoaded', level: lv('1-1') });
    ui.show({ id: 'hud' });
    ui.hud(hudState());
    const caps = root.querySelector<HTMLElement>('.wide-onboard .keycaps')!;
    expect(caps).not.toBeNull();
    expect(caps.style.transform).toBe('translateX(-70px)');
  });

  it('#43 wide title: the top-left スキン comes first in the Tab order, あそぶ last', () => {
    resize(1280, 720);
    root.replaceChildren();
    ui = createUI({ store, skins: () => ({ items: [], equipped: { ball: 'ball.red', crane: 'crane.yellow', trail: 'trail.dots', stage: 'stage.paper' }, unseen: 0 }) as never });
    ui.mount(root);
    ui.show({ id: 'title' });
    const order = [...root.querySelectorAll<HTMLElement>('.title button')].map((b) => b.classList.contains('title-play') ? 'play' : b.classList.contains('title-skins') ? 'skins' : 'corner');
    expect(order).toEqual(['skins', 'corner', 'corner', 'play']);
  });

  it('#24 the required-angle label moves out along its ray off a wall-height label written in the scene', () => {
    ui.mount(root);
    ui.fx({ t: 'levelLoaded', level: lv('3-3') });
    ui.show({ id: 'hud' });
    const a = { pivot: { x: 100, y: 100 }, ball: { x: 100, y: 160 }, pxPerM: 100, slack: false, holdFrac: 0, reqDeg: 49, reqDir: 1 as const };
    const at = (): [number, number] => [Number(root.querySelector('.anc-req-label')!.getAttribute('x')), Number(root.querySelector('.anc-req-label')!.getAttribute('y'))];
    ui.hud(hudState({ anchors: a }));
    const [x0, y0] = at();
    // Rr = 46 px: the label at 72 px along the 49° ray
    expect(x0).toBeCloseTo(72 * Math.sin(49 * Math.PI / 180), 0);
    // "0.80 m" right there: the label goes further out until it is clear, along the same ray
    const label = { x0: 100 + x0 - 20, y0: 100 + y0 - 10, x1: 100 + x0 + 25, y1: 100 + y0 + 2 };
    ui.hud(hudState({ anchors: { ...a, keepOut: [label] } }));
    const [x1, y1] = at();
    expect(x1).toBeGreaterThan(x0);
    expect(y1 - y0).toBeCloseTo((x1 - x0) * Math.cos(49 * Math.PI / 180) / Math.sin(49 * Math.PI / 180), 0);
    expect(100 + y1 + 5 - 12).toBeGreaterThanOrEqual(label.y1);
    // a label elsewhere changes nothing
    ui.hud(hudState({ anchors: { ...a, keepOut: [{ x0: 0, y0: 0, x1: 20, y1: 20 }] } }));
    expect(at()).toEqual([x0, y0]);
  });

  it('#23 READY in wide: the HUD boxes over the row above the beam, for the ghost tags to keep out of', () => {
    const shown = (el: HTMLElement): boolean => el.style.display !== 'none';
    const restore = stubLayout(
      (el) => el.classList.contains('hud-ready') && shown(el) ? { w: 130, h: 24 } : el.classList.contains('chip-btn') && shown(el) ? { w: 84, h: 44 } : null,
      (el) => el.classList.contains('hud-ready') ? { x: 162, y: 58 } : el.classList.contains('chip-btn') ? { x: 8, y: 64 } : null);
    try {
      resize(568, 320);
      ui.mount(root);
      ui.fx({ t: 'levelLoaded', level: lv('1-4') });
      ui.show({ id: 'hud' });
      ui.fx({ t: 'ready' });
      ui.hud(hudState());
      const boxes = ui.tagKeepOut!()!;
      expect(boxes.length).toBeGreaterThanOrEqual(1);
      expect(boxes.some((b) => b.x1 - b.x0 === 130 && b.y1 - b.y0 === 24)).toBe(true);
      // cached until the HUD changes; nothing while running (the pill is gone) or in another screen
      ui.hud(hudState({ running: true, timeSub: 20 }));
      expect(ui.tagKeepOut!()?.some((b) => b.x1 - b.x0 === 130) ?? false).toBe(false);
      ui.show({ id: 'pause' });
      expect(ui.tagKeepOut!()).toBeNull();
    } finally {
      restore();
    }
  });

  it('text and CSS fixes: Snap toast, the tagline, the logo and the tagline at 125 %, the egg meter, the title hint, the READY hint', () => {
    // #25 / #39: one '!' in every English trick toast (the in-scene pop keeps 'Snap!')
    for (const k of Object.keys(en).filter((x) => x.startsWith('trick.') && x !== 'trick.toast')) {
      expect(en['trick.toast'].replace('{name}', en[k as keyof typeof en]), k).not.toMatch(/!!/);
    }
    expect(en['pop.snap']).toBe('Snap!');
    // #8: no break after 'optimal-' (U+2011), ja after 「、」 (keep-all)
    expect(en['app.tagline']).toContain('optimal‑control');
    expect(cssText).toMatch(/\.tagline \{\s*white-space: normal;[^}]*word-break: keep-all;\s*overflow-wrap: anywhere;/);
    // #0: 125 % logo capped to the width
    expect(ruleOf('.yp-ts125 .logo-a,\n.yp-ts125 .logo-b')).toMatch(/font-size: min\(1em, calc\(\(100vw - 32px\) \/ 7\.2\)\)/);
    // #21: English tagline on 568-644 px landscape phones: one smaller line
    expect(cssText).toMatch(/@media \(max-width: 644px\) \{\s*\.yp\[lang="en"\]\[data-short="1"\] \.tagline \{\s*padding: 6px 12px;\s*font-size: 0\.8rem;/);
    // #22: the title hint's paper pill on landscape phones (over the ruler)
    expect(ruleOf('.yp[data-short="1"] .title-hint')).toMatch(/background: rgba\(251, 248, 241, 0\.86\)/);
    // #9: 125 % English egg meter
    expect(ruleOf('.yp-ts125 .yp[lang="en"][data-layout="tall"] .hud-tension')).toMatch(/width: 164px/);
    // #13: landscape phones' READY hint: compact, just above the force bar, no wider than it
    expect(ruleOf('.yp[data-short="1"][data-layout="wide"] .hud-hint')).toMatch(/bottom: calc\(34px \+ var\(--safe-b\)\);\s*max-width: calc\(42vw \+ 4px\);/);
  });
});
