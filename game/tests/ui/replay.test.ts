// The ranking's replays in the UI (GAME_DESIGN.md §7.5 item 6, §8.4 item 6, §9.4): the 「1位のリプレイを見る」 button
// and the ▶ column of the ranking, the load (busy, toasts), the return to the row watched, and the demo viewer's replay
// variant (legends, clock, 勝負 / 戻る, keys). Owner: O7.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LevelDef } from '../../src/sim/level';
import type { SaveV1, Store } from '../../src/store/save';
import type { BoardResponse, BoardRow, BootResponse } from '../../src/shared/api';
import type { HudState, UI, UiAction } from '../../src/ui/ui';
import type { ReplayAvail, ReplayLoad, ReplayReq, ReplayView, UiContext } from '../../src/ui/context';
import { BUNDLED_LEVELS, createUI, defaultSettings } from '../../src/ui/ui';
import { boardTable } from '../../src/ui/screens/board';
import { REPLAY_KEY_GUARD_MS } from '../../src/ui/screens/demo';
import { setLang } from '../../src/ui/i18n/format';

const lv = (id: string): LevelDef => BUNDLED_LEVELS.find((l) => l.id === id)!;
const ME = 'a1b2c3d4e5f60718';
const KEY = 'L:2-2:00000000:s1';

function mockSave(): SaveV1 {
  return {
    v: 1, id: { secret: 's', pidh: ME, nameSeed: 7 },
    settings: { ...defaultSettings(), lang: 'ja' },
    levels: {},
    daily: { dayIndex: 22, balls: [null, null, null, null, null], bestSub: null, bestReplay: null, submitted: 'none', lastSentT120: null, streak: 0, lastPlayedDay: -1 },
    outbox: [],
    seen: { onboarding: true, notes: [], aiLostCard: true, storageNotice: true, tricks: [] },
  };
}

/** Rows of a board: t120 = 200 + 3i (ranks 1..n); `meAt` (1-based, 0 = none) is my row. */
function rows(n: number, meAt = 0): BoardRow[] {
  return Array.from({ length: n }, (_, i): BoardRow => [i === meAt - 1 ? ME : `p${String(i).padStart(15, '0')}`, i, 200 + 3 * i, 5000, 0, 1790000000000 - i]);
}
function boot(top = rows(10)): BootResponse {
  return {
    v: 1, sim: 1, now: 0, day: 22, lite: false, readOnly: false,
    boards: { '2-2': { key: KEY, n: 812, aiBeaten: 37, par: 324, cutoff: 497, top, wr: 'WVAB' } },
    daily: { key: 'D:00022:1c0e77aa:s1', n: 0, cleared: 0, aiBeaten: 0, par: 402, top: [], hist: [], wr: null },
  };
}
const full = (over: Partial<BoardResponse> = {}): BoardResponse => ({ key: KEY, n: 1065, aiBeaten: 37, par: 324, cutoff: 497, top: rows(100, 37), ...over });

function hudState(over: Partial<HudState> = {}): HudState {
  return {
    timeSub: 0, running: false, F: 0, Fmax: 40, aiF: null, saturated: false, ampDeg: 0, restDeg: 3, T: 9.8, Tmax: null,
    nearGapMm: null, offline: false, mode: 'demo', hint: null, dailyBalls: null, ...over,
  };
}

function view(over: Partial<ReplayView> = {}): ReplayView {
  const f = new Float32Array(241).map((_, i) => Math.sin(i / 20) * 30);
  return {
    id: `${KEY}|p000000000000002|206`, rank: 3, name: 'しずかなクレーン#1234', t120: 206, kind: 'rival', mine: false, hz: 60,
    f, aiF: f.map((v) => v * 0.8), meF: f.map((v) => v * 0.5), Fmax: 40, gapMm: 12.4, peakF: 31.25, ...over,
  };
}

let root: HTMLElement;
let ui: UI;
let save: SaveV1;
let store: Store;
const got: { a: UiAction; p: unknown }[] = [];

function mount(ctx: Partial<UiContext> = {}): UI {
  ui = createUI({ store, ...ctx });
  for (const a of ['replay', 'raceGhost', 'retry'] as UiAction[]) ui.on(a, (p) => got.push({ a, p }));
  ui.mount(root);
  return ui;
}
const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

beforeEach(() => {
  document.body.innerHTML = '<div id="app" style="width:390px;height:844px"></div>';
  root = document.getElementById('app')!;
  Object.defineProperty(root, 'clientWidth', { configurable: true, value: 390 });
  Object.defineProperty(root, 'clientHeight', { configurable: true, value: 844 });
  save = mockSave();
  store = { persistent: true, data: () => save, update: (fn) => fn(save), flush: () => undefined };
  got.length = 0;
  setLang('ja');
});
afterEach(() => {
  document.body.innerHTML = '';
  setLang('ja');
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** A context whose #1 and my row are ready and the others cost a request; loads answer as `answer` says. */
function replayCtx(answer: (req: ReplayReq) => Promise<ReplayLoad> = (req) => Promise.resolve({ ok: true, id: `${req.key}|${req.pidh}|${req.t120}` })) {
  const avail = vi.fn((_key: string, rank: number, row: BoardRow): ReplayAvail => (rank === 1 || row[0] === ME ? 'ready' : 'fetch'));
  const loadReplay = vi.fn(answer);
  return { replayAvail: avail, loadReplay };
}

describe('ranking: the replay entry points', () => {
  it('opening the ranking loads nothing: #1 button over the table, a ▶ on every watchable row, the AI row without one', async () => {
    const rc = replayCtx();
    mount({ boot: () => boot(), fetchBoard: async () => full(), ...rc });
    ui.show({ id: 'board', key: KEY });
    await flush();
    expect(rc.replayAvail).toHaveBeenCalled();
    expect(rc.loadReplay).not.toHaveBeenCalled();
    const wr = root.querySelector<HTMLButtonElement>('.page-head .board-wr')!;
    expect(wr.textContent).toContain('1位のリプレイを見る');
    expect(wr.textContent).toContain('2.000秒'.replace('2.000', (200 / 120).toFixed(3)));
    expect(root.querySelectorAll('table.board tbody tr[data-rank] .b-play-btn')).toHaveLength(100);
    expect(root.querySelector('table.board tr.is-ai .b-play-btn')).toBeNull();
    expect(root.querySelector('table.board thead th.b-play .sr-only')!.textContent).toBe('リプレイ');
    expect(root.querySelector('tr[data-rank="5"] .b-play-btn')!.getAttribute('aria-label')).toContain('5位');
  });

  it('only watchable rows get a ▶; no #1 button when #1 is not watchable; the daily hub top 10 has no ▶ column', async () => {
    const avail = vi.fn((_k: string, rank: number): ReplayAvail => (rank === 2 ? 'fetch' : null));
    mount({ boot: () => boot(), fetchBoard: async () => full(), replayAvail: avail, loadReplay: vi.fn() });
    ui.show({ id: 'board', key: KEY });
    await flush();
    expect(root.querySelector('.board-wr')).toBeNull();
    expect([...root.querySelectorAll<HTMLElement>('.b-play-btn')].map((b) => b.dataset.rank)).toEqual(['2']);
    expect(root.querySelector('tr[data-rank="3"]')!.classList.contains('is-watch')).toBe(false);
    // without the replay option (the daily hub's top 10): 4 columns as before
    const t = boardTable(rows(10), { parSub: 324 });
    expect(t.querySelector('.b-play')).toBeNull();
    expect(t.querySelector('thead tr')!.children).toHaveLength(4);
  });

  it('without a replay context (single HTML, dev pages): the ranking is as before', async () => {
    mount({ boot: () => boot(), fetchBoard: async () => full() });
    ui.show({ id: 'board', key: KEY });
    await flush();
    expect(root.querySelector('.board-wr')).toBeNull();
    expect(root.querySelector('.b-play')).toBeNull();
  });

  it('a row tap (or its ▶, or the #1 button) loads that row and emits replay {id}', async () => {
    const rc = replayCtx();
    mount({ boot: () => boot(), fetchBoard: async () => full(), ...rc });
    ui.show({ id: 'board', key: KEY });
    await flush();
    root.querySelector<HTMLElement>('tr[data-rank="4"] td.b-name')!.click();
    await flush();
    expect(rc.loadReplay).toHaveBeenCalledWith({ key: KEY, rank: 4, pidh: 'p000000000000003', nameSeed: 3, t120: 209 });
    expect(got).toEqual([{ a: 'replay', p: { id: `${KEY}|p000000000000003|209` } }]);
    got.length = 0;
    ui.show({ id: 'board', key: KEY });
    await flush();
    root.querySelector<HTMLElement>('.board-wr')!.click();
    await flush();
    expect(rc.loadReplay).toHaveBeenLastCalledWith({ key: KEY, rank: 1, pidh: 'p000000000000000', nameSeed: 0, t120: 200 });
    expect(got).toEqual([{ a: 'replay', p: { id: `${KEY}|p000000000000000|200` } }]);
  });

  it('loading: the ▶ is busy (single flight, it survives the full list); a refusal says why and gives the ▶ back', async () => {
    let answer!: (r: ReplayLoad) => void;
    const rc = replayCtx(() => new Promise((res) => { answer = res; }));
    let list!: (b: BoardResponse) => void;
    mount({ boot: () => boot(), fetchBoard: () => new Promise((res) => { list = res; }), ...rc });
    ui.show({ id: 'board', key: KEY });
    root.querySelector<HTMLElement>('tr[data-rank="3"] .b-play-btn')!.click();
    await flush();
    const busy = (): string[] => [...root.querySelectorAll<HTMLElement>('.is-busy')].map((b) => b.dataset.rank!);
    expect(busy()).toEqual(['3']);
    expect(root.querySelector('tr[data-rank="3"] .b-play-btn')!.getAttribute('aria-busy')).toBe('true');
    // taps elsewhere wait for it
    root.querySelector<HTMLElement>('tr[data-rank="5"] .b-play-btn')!.click();
    expect(rc.loadReplay).toHaveBeenCalledTimes(1);
    // the full list replaces the table: row 3's ▶ is still busy
    list(full());
    await flush();
    expect(busy()).toEqual(['3']);
    answer({ ok: false, reason: 'budget' });
    await flush();
    expect(busy()).toEqual([]);
    expect(got).toEqual([]);
    expect(root.querySelector('.yp-toasts')!.textContent).toContain('このセッションで読み込めるリプレイの上限に達しました');
    // and the next tap goes
    root.querySelector<HTMLElement>('tr[data-rank="5"] .b-play-btn')!.click();
    expect(rc.loadReplay).toHaveBeenCalledTimes(2);
  });

  it('every refusal has its toast', async () => {
    const texts: Record<string, string> = {
      offline: 'いまはリプレイを読み込めません', missing: 'この記録はもう見られません', bad: 'このリプレイは再生できませんでした', stale: 'この記録はもう見られません',
    };
    for (const [reason, text] of Object.entries(texts)) {
      document.body.innerHTML = '<div id="app"></div>';
      root = document.getElementById('app')!;
      mount({ boot: () => boot(), fetchBoard: async () => null, ...replayCtx(() => Promise.resolve({ ok: false, reason } as ReplayLoad)) });
      ui.show({ id: 'board', key: KEY });
      root.querySelector<HTMLElement>('tr[data-rank="2"] .b-play-btn')!.click();
      await flush();
      expect(root.querySelector('.yp-toasts')!.textContent, reason).toContain(text);
    }
  });

  it('back from the viewer (focusRank): that row scrolled to and its ▶ focused, my row not flashed again', async () => {
    const scroll = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll });
    try {
      mount({ boot: () => boot(rows(10, 4)), fetchBoard: async () => full({ top: rows(100, 4) }), ...replayCtx() });
      ui.show({ id: 'board', key: KEY, focusRank: 42 });
      // rank 42 is not in the boot top 10: nothing yet (and no jump to my row, no flash)
      expect(scroll).not.toHaveBeenCalled();
      expect(root.querySelector('tr.is-me')!.classList.contains('is-flash')).toBe(false);
      await flush();
      expect(scroll).toHaveBeenCalledTimes(1);
      expect(scroll.mock.instances[0]).toBe(root.querySelector('tr[data-rank="42"]'));
      expect(scroll.mock.calls[0]![0]).toMatchObject({ block: 'center', behavior: 'auto' });
      expect(document.activeElement).toBe(root.querySelector('tr[data-rank="42"] .b-play-btn'));
      expect(root.querySelector('tr.is-me')!.classList.contains('is-flash')).toBe(false);
      // a row of the boot top 10 keeps its focus when the full list replaces the table
      ui.show({ id: 'board', key: KEY, focusRank: 7 });
      expect(document.activeElement).toBe(root.querySelector('tr[data-rank="7"] .b-play-btn'));
      await flush();
      expect(document.activeElement).toBe(root.querySelector('tr[data-rank="7"] .b-play-btn'));
      // #1: its button in the header
      ui.show({ id: 'board', key: KEY, focusRank: 1 });
      await flush();
      expect(document.activeElement).toBe(root.querySelector('.board-wr'));
    } finally {
      delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });
});

describe('the demo viewer: a ranked replay', () => {
  it('legends (the player, the AI, your best), the re-simulation\'s numbers, the clock that stops on the ranked time', () => {
    mount();
    ui.show({ id: 'demo', level: lv('2-2'), replay: view() });
    const top = root.querySelector<HTMLElement>('.demo-top')!;
    expect(top.textContent).toContain('3位');
    expect(top.textContent).toContain('×0.5');
    expect(top.querySelector('.demo-race')!.textContent).toContain('勝負');
    const panel = root.querySelector<HTMLElement>('.demo-panel')!;
    expect([...panel.querySelectorAll('.demo-legend')].map((e) => e.textContent)).toEqual(['3位', 'AI', 'あなた（自己ベスト）']);
    expect(panel.querySelector('.demo-nums')!.textContent).toContain('すき間 12mm');
    expect(panel.querySelector('.demo-nums')!.textContent).toContain('ピーク力 31.3N');
    expect(panel.querySelector('.demo-hint')!.textContent).toBe('何か押すとランキングへ');
    expect(panel.querySelectorAll('svg.demo-graph path')).toHaveLength(3);
    expect(panel.querySelector('svg.demo-graph path:last-of-type')!.getAttribute('class')).toContain('demo-line--rival');
    ui.hud(hudState({ timeSub: 120 }));
    expect(panel.querySelector('.demo-clock')!.textContent).toBe('1.00秒');
    expect(root.querySelector('.demo-race')!.classList.contains('is-done')).toBe(false);
    ui.hud(hudState({ timeSub: 206 }));
    expect(panel.querySelector('.demo-clock')!.textContent).toBe('1.717秒');
    expect(root.querySelector('.demo-race')!.classList.contains('is-done')).toBe(true);
    // the playhead stops on the ranked time
    const x = panel.querySelector('svg.demo-graph line:last-of-type')!.getAttribute('x1');
    ui.hud(hudState({ timeSub: 260 }));
    expect(panel.querySelector('svg.demo-graph line:last-of-type')!.getAttribute('x1')).toBe(x);
  });

  it('#1: the wr line and legend; my own run: no race, no "your best" line', () => {
    mount();
    ui.show({ id: 'demo', level: lv('1-1'), replay: view({ rank: 1, kind: 'wr', mine: true, meF: null, gapMm: null }) });
    expect(root.querySelector('.demo-race')).toBeNull();
    expect(root.querySelectorAll('.demo-legend')).toHaveLength(2);
    expect(root.querySelector('.demo-nums')!.textContent).not.toContain('すき間');
    expect(root.querySelector('.demo-title--replay')!.classList.contains('is-wr')).toBe(true);
  });

  it('keys: Enter on 勝負 presses it; any other key (after the guard) or Escape goes back; 戻る goes back', () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    mount();
    ui.show({ id: 'demo', level: lv('2-2'), replay: view() });
    const layer = root.querySelector<HTMLElement>('.yp-layer')!;
    const race = root.querySelector<HTMLButtonElement>('.demo-race')!;
    // the key that opened the viewer (still held) does not close it
    layer.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect(got).toEqual([]);
    vi.advanceTimersByTime(REPLAY_KEY_GUARD_MS + 10);
    race.focus();
    race.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(got).toEqual([]);             // native activation (a click), not "any key"
    race.click();
    expect(got).toEqual([{ a: 'raceGhost', p: { id: view().id } }]);
    got.length = 0;
    layer.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, repeat: true }));
    expect(got).toEqual([]);
    layer.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect(got).toEqual([{ a: 'retry', p: { from: 'replay' } }]);
    got.length = 0;
    layer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(got).toEqual([{ a: 'retry', p: { from: 'replay' } }]);
    got.length = 0;
    root.querySelector<HTMLButtonElement>('.demo-back')!.click();
    expect(got).toEqual([{ a: 'retry', p: { from: 'replay' } }]);
  });

  it('English', () => {
    setLang('en');
    save.settings.lang = 'en';
    mount();
    ui.show({ id: 'demo', level: lv('2-2'), replay: view({ rank: 12 }) });
    expect(root.querySelector('.demo-top')!.textContent).toContain('#12 replay');
    expect([...root.querySelectorAll('.demo-legend')].map((e) => e.textContent)).toEqual(['#12', 'AI', 'You (best)']);
    expect(root.querySelector('.demo-hint')!.textContent).toBe('Press anything to go back');
  });
});
