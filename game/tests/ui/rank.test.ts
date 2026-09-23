// World rank on the results card, the ranking screen and the daily hub (GAME_DESIGN.md §9.4, §7.7 「約」の規則). Owner: O7.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { LevelDef } from '../../src/sim/level';
import type { SaveV1, Store } from '../../src/store/save';
import type { BoardResponse, BoardRow, BootResponse } from '../../src/shared/api';
import type { Standing } from '../../src/shared/rank';
import { LEVEL_HIST_BINS, estimateLevelRank, levelBin, levelPct, trimHist } from '../../src/shared/rank';
import type { DailyView, HudState, ResultsData, UI } from '../../src/ui/ui';
import type { UiContext } from '../../src/ui/context';
import { BUNDLED_LEVELS, createUI, defaultSettings } from '../../src/ui/ui';
import { renderRankRow, standingKey } from '../../src/ui/results';
import { dailyPin, levelPin } from '../../src/ui/screens/board';
import type { BoardView } from '../../src/ui/screens/board';
import { setLang } from '../../src/ui/i18n/format';

const lv = (id: string): LevelDef => BUNDLED_LEVELS.find((l) => l.id === id)!;
const ME = 'a1b2c3d4e5f60718';
const KEY = 'L:2-2:00000000:s1';
const DKEY = 'D:00022:1c0e77aa:s1';

function mockSave(): SaveV1 {
  return {
    v: 1, id: { secret: 's', pidh: ME, nameSeed: 7 },
    settings: { ...defaultSettings(), lang: 'ja' },
    levels: {
      '2-2': { hash: '00000000', cleared: true, skipped: false, attempts: 12, fails: 3, consecutiveCrashes: 0, bestSub: 400, bestReplay: null, medal: 2, crown: false, badges: [], hintsSeen: 0, briefed: true, demoShown: false, aiBeatenSent: false },
    },
    daily: { dayIndex: 22, balls: ['ok', null, null, null, null], bestSub: 396, bestReplay: null, submitted: 'partial', lastSentT120: 396, streak: 1, lastPlayedDay: 22 },
    outbox: [],
    seen: { onboarding: true, notes: [], aiLostCard: true, storageNotice: true, tricks: [] },
  };
}

function hudState(over: Partial<HudState> = {}): HudState {
  return {
    timeSub: 0, running: false, F: 0, Fmax: 40, aiF: null, saturated: false, ampDeg: 0, restDeg: 3, T: 9.8, Tmax: null,
    nearGapMm: null, offline: false, mode: 'campaign', hint: null, dailyBalls: null, ...over,
  };
}

const standing = (over: Partial<Standing> = {}): Standing => ({
  runKey: `${KEY}:314`, forPb: true, rank: null, n: 1065, pct: null, was: null, exact: false, candidate: true, phase: 'local', stamp: null, ...over,
});

function results(st: Standing | null, over: Partial<ResultsData> = {}): ResultsData {
  return {
    level: lv('2-2'), ok: true, score: 314, parSub: 324, pbSub: 330, wrSub: 300, medal: 3, crown: false, nextMedalSub: 323,
    gapMm: 6, aiGapMm: 20, peakF: 38, aiPeakF: 40, badges: [], failReason: null, rank: null, aiBeaten: 37,
    replay: 'abc', strobe: new Float32Array([0, 0.25, 1, 0.9]), standing: st, ...over,
  };
}

/** Rows of a board: t120 = 200 + 3i (ranks 1..n); `meAt` (1-based, 0 = none) is my row. */
function rows(n: number, meAt = 0): BoardRow[] {
  return Array.from({ length: n }, (_, i): BoardRow => [i === meAt - 1 ? ME : `p${String(i).padStart(15, '0')}`, i, 200 + 3 * i, 5000, 0, 1790000000000 - i]);
}

/** A level histogram of `n` players spread from 200 to 1400 t120 (dense 153 bins, trimmed). */
function crowdHist(n: number): number[] {
  const h = new Array<number>(LEVEL_HIST_BINS).fill(0);
  for (let i = 0; i < n; i++) h[levelBin(200 + Math.floor((1200 * i) / n))]! += 1;
  return trimHist(h);
}

function boot(over: Partial<BootResponse['boards'][string]> = {}, daily: Partial<BootResponse['daily']> = {}): BootResponse {
  return {
    v: 1, sim: 1, now: 0, day: 22, lite: false, readOnly: false,
    boards: { '2-2': { key: KEY, n: 812, aiBeaten: 37, par: 324, cutoff: 497, top: rows(10), wr: null, ...over } },
    daily: { key: DKEY, n: 5012, cleared: 3811, aiBeaten: 120, par: 402, top: rows(10), hist: [], wr: null, ...daily },
  };
}

let root: HTMLElement;
let ui: UI;
let save: SaveV1;
let store: Store;

function mount(ctx: Partial<UiContext> = {}): UI {
  ui = createUI({ store, ...ctx });
  ui.mount(root);
  return ui;
}

beforeEach(() => {
  document.body.innerHTML = '<div id="app" style="width:390px;height:844px"></div>';
  root = document.getElementById('app')!;
  Object.defineProperty(root, 'clientWidth', { configurable: true, value: 390 });
  Object.defineProperty(root, 'clientHeight', { configurable: true, value: 844 });
  save = mockSave();
  store = { persistent: true, data: () => save, update: (fn) => fn(save), flush: () => undefined };
  setLang('ja');
});

afterEach(() => {
  document.body.innerHTML = '';
  setLang('ja');
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const rowText = (): string | null => root.querySelector('.res-rank')?.textContent ?? null;
const text = (s: Standing, lang: 'ja' | 'en' = 'ja'): string => {
  setLang(lang);
  const el = document.createElement('div');
  renderRankRow(el, s, null);
  return el.textContent ?? '';
};

describe('results: the rank row (every row of GAME_DESIGN.md §9.4)', () => {
  // [standing, ja, en, exact?]
  const table: [string, Partial<Standing>, string, string, boolean][] = [
    ['stamp in', { rank: 37, exact: true, phase: 'confirmed', stamp: 'in' }, 'ランクイン！37位', 'Top 100!#37', true],
    ['stamp in from ~342', { rank: 37, was: 342, exact: true, phase: 'confirmed', stamp: 'in' }, '約342位から', 'from ~#342', true],
    ['stamp up', { rank: 37, was: 49, exact: true, phase: 'confirmed', stamp: 'up' }, 'ランクアップ！37位↑12', 'Rank up!#37↑12', true],
    ['stamp wr', { rank: 1, was: 4, exact: true, phase: 'confirmed', stamp: 'wr' }, '世界一！1位', 'World #1!#1', true],
    ['stamp wr again', { rank: 1, was: 1, exact: true, phase: 'confirmed', stamp: 'wr' }, '世界記録更新！1位', 'New world record!#1', true],
    ['exact, no stamp', { rank: 37, was: 37, exact: true, phase: 'confirmed' }, '世界 37位1,065人中', 'World #37of 1,065', true],
    ['local <= 100', { rank: 37 }, '世界 約37位1,065人中', 'World ~#37of 1,065', false],
    ['estimate', { rank: 342, pct: 32.2, candidate: false }, '世界 約342位1,065人中・上位32.2%', 'World ~#342of 1,065 · Top 32.2%', false],
    ['estimate, up', { rank: 342, pct: 32.2, was: 400, candidate: false }, '↑約58', '↑~58', false],
    ['confirmed estimate', { rank: 342, pct: 32.2, candidate: false, phase: 'confirmed' }, '世界 約342位', 'World ~#342', false],
    ['pending', { rank: 37, phase: 'pending' }, '約37位の見込み・確認中…', '~#37 expected · checking…', false],
    ['pending range', { phase: 'pending' }, 'ランクイン圏内・確認中…', 'Top-100 range · checking…', false],
    ['queued', { rank: 37, phase: 'queued' }, '約37位・送信待ち', '~#37 · not sent yet', false],
    ['queued, no number', { phase: 'queued' }, '送信待ち', 'Not sent yet', false],
    ['held', { rank: 37, phase: 'held' }, '約37位相当・今日は反映されません', '~#37 · not counted today', false],
    ['out', { candidate: false, n: null }, '100位圏外', 'Outside the top 100', false],
    ['non-PB', { forPb: false, rank: 342, pct: 32.2, candidate: false }, '自己ベスト世界 約342位', 'Your bestWorld ~#342', false],
  ];
  for (const [name, over, ja, en, exact] of table) {
    it(`${name}: ${ja} / ${en}`, () => {
      const s = standing(over);
      const tj = text(s, 'ja');
      const te = text(s, 'en');
      expect(tj).toContain(ja);
      expect(te).toContain(en);
      // 約 / ~ on every number that is not the server's own top-100 rank (§7.7: local estimates included)
      if (exact) {
        expect(tj.replace(/約342位から/, '')).not.toMatch(/約/);
      } else if (s.rank !== null) {
        expect(tj).toMatch(/約/);
        expect(te).toMatch(/~/);
      }
    });
  }

  it('the stamp only on a confirmed answer with a stamp; muted prefix only on a slower clear', () => {
    const el = document.createElement('div');
    renderRankRow(el, standing({ rank: 37, exact: true, phase: 'confirmed' }), null);
    expect(el.querySelector('.stamp--rank')).toBeNull();
    renderRankRow(el, standing({ rank: 37, phase: 'pending', stamp: 'in' }), null);
    expect(el.querySelector('.stamp--rank')).toBeNull();
    renderRankRow(el, standing({ rank: 1, exact: true, phase: 'confirmed', stamp: 'wr' }), null);
    expect(el.querySelector('.stamp--rank.stamp--wr')).not.toBeNull();
    expect(el.querySelector('.sr-only')!.textContent).toBe('世界一！ 世界1位');
    expect(el.querySelector('.stamp--rank')!.getAttribute('aria-hidden')).toBe('true');
    // the climb is read out too (the ↑n pill itself is aria-hidden)
    renderRankRow(el, standing({ rank: 37, was: 49, exact: true, phase: 'confirmed', stamp: 'up' }), null);
    expect(el.querySelector('.sr-only')!.textContent).toBe('ランクアップ！ 世界37位 12位アップ');
    renderRankRow(el, standing({ rank: 342, pct: 32.2, was: 400, candidate: false }), null);
    expect(el.querySelector('.rank-up')!.getAttribute('aria-hidden')).toBe('true');
    expect(el.querySelector('.sr-only')!.textContent).toBe('約58位アップ');
    renderRankRow(el, standing({ forPb: false, rank: 342, pct: 32.2, candidate: false }), null);
    expect(el.classList.contains('res-rank--muted')).toBe(true);
  });

  it('standingKey changes only with what the row shows', () => {
    const a = standing({ rank: 37, phase: 'pending' });
    expect(standingKey({ ...a })).toBe(standingKey(a));
    expect(standingKey({ ...a, runKey: 'other' })).toBe(standingKey(a));
    expect(standingKey({ ...a, phase: 'confirmed' })).not.toBe(standingKey(a));
    expect(standingKey({ ...a, stamp: 'in' })).not.toBe(standingKey(a));
    expect(standingKey(null)).toBe('');
  });
});

describe('results card: the rank row in the card', () => {
  it('sits right after the time, and follows core replacing data.standing (re-rendered only on a change)', () => {
    mount();
    const data = results(standing({ rank: 37, phase: 'pending' }));
    ui.show({ id: 'results', data });
    const row = root.querySelector('.res-rank')!;
    expect(row.previousElementSibling!.classList.contains('res-time')).toBe(true);
    expect(row.getAttribute('aria-live')).toBe('polite');
    expect(rowText()).toBe('約37位の見込み・確認中…');
    // the same standing: nothing is re-rendered
    const main = row.querySelector('.res-rank-main');
    for (let i = 0; i < 12; i++) ui.hud(hudState());
    expect(row.querySelector('.res-rank-main')).toBe(main);
    // the answer: core replaces the object, the row follows within 6 HUD frames
    data.standing = standing({ rank: 37, exact: true, phase: 'confirmed', stamp: 'in' });
    for (let i = 0; i < 6; i++) ui.hud(hudState());
    expect(root.querySelector('.res-rank .stamp--rank')).not.toBeNull();
    expect(rowText()).toContain('ランクイン！');
    // the dead data.rank chip is gone; the AI-beaten chip stays
    expect(root.querySelector('.res-online')!.textContent).not.toContain('世界');
    expect(root.querySelector('.res-online .chip--ai')).not.toBeNull();
  });

  it('the stamp is pressed once per card: .is-new on the first render only, not after a rotation or the ranking', async () => {
    mount();
    const data = results(standing({ rank: 37, was: 49, exact: true, phase: 'confirmed', stamp: 'up' }));
    ui.show({ id: 'results', data });
    await Promise.resolve();
    const st = root.querySelector<HTMLElement>('.stamp--rank')!;
    expect(st.classList.contains('is-new')).toBe(true);
    // pressed after the count-up and the medal fly (~900 ms after the card opened)
    expect(parseInt(st.style.getPropertyValue('--rank-delay'), 10)).toBeGreaterThan(800);
    expect(root.querySelector<HTMLElement>('.rank-up.is-new')).not.toBeNull();
    // the meta line (1,065人中) comes in with the stamp, not before it
    const sub = root.querySelector<HTMLElement>('.res-rank-sub.is-new')!;
    expect(parseInt(sub.style.getPropertyValue('--rank-delay'), 10)).toBeGreaterThan(parseInt(st.style.getPropertyValue('--rank-delay'), 10));
    // the same ResultsData rendered again (rotation, back from the ranking): final state, no animation
    ui.show({ id: 'results', data });
    expect(root.querySelector('.stamp--rank')!.classList.contains('is-new')).toBe(false);
    expect(root.querySelector('.rank-up')!.classList.contains('is-new')).toBe(false);
    // a new card animates again
    ui.show({ id: 'results', data: results(standing({ rank: 37, exact: true, phase: 'confirmed', stamp: 'in' })) });
    expect(root.querySelector('.stamp--rank')!.classList.contains('is-new')).toBe(true);
  });

  it('a card drawn and covered at once (back from the replay viewer: the card, then the ranking) presses when it shows', async () => {
    mount();
    const data = results(standing({ rank: 37, exact: true, phase: 'confirmed', stamp: 'in' }));
    ui.show({ id: 'results', data });
    ui.show({ id: 'board', key: KEY });
    await Promise.resolve();
    ui.show({ id: 'results', data });
    expect(root.querySelector('.stamp--rank')!.classList.contains('is-new')).toBe(true);
    await Promise.resolve();
    ui.show({ id: 'results', data });
    expect(root.querySelector('.stamp--rank')!.classList.contains('is-new')).toBe(false);
  });

  it('an answer that arrives later is pressed at once (no extra wait)', () => {
    mount();
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValue(1000);
    const data = results(standing({ rank: 37, phase: 'pending' }));
    ui.show({ id: 'results', data });
    now.mockReturnValue(4000);
    data.standing = standing({ rank: 37, exact: true, phase: 'confirmed', stamp: 'in' });
    for (let i = 0; i < 6; i++) ui.hud(hudState());
    const st = root.querySelector<HTMLElement>('.stamp--rank.is-new')!;
    expect(st.style.getPropertyValue('--rank-delay')).toBe('0ms');
  });

  it('first crown: 「AIが負けた理由」 opens after the rank stamp has landed (and waits for an answer on its way)', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    save.seen.aiLostCard = false;
    const scrim = (): Element | null => root.querySelector('.yp-layer[data-kind="scrim"][role="dialog"]');
    mount();
    // stamp pressed at 900 ms for 450 ms: not at the old 1100 ms, but once it has landed
    ui.show({ id: 'results', data: results(standing({ rank: 1, exact: true, phase: 'confirmed', stamp: 'wr' }), { crown: true }) });
    vi.advanceTimersByTime(1200);
    expect(scrim()).toBeNull();
    vi.advanceTimersByTime(500);
    expect(scrim()).not.toBeNull();
    // a rank-in answer still on its way: wait for it, then for its stamp
    root.replaceChildren();
    save.seen.aiLostCard = false;   // (opening it marks it seen)
    mount();
    const data = results(standing({ rank: 1, phase: 'pending' }), { crown: true });
    ui.show({ id: 'results', data });
    vi.advanceTimersByTime(2000);
    expect(scrim()).toBeNull();
    data.standing = standing({ rank: 1, exact: true, phase: 'confirmed', stamp: 'wr' });
    vi.advanceTimersByTime(300);
    expect(root.querySelector('.stamp--rank.is-new')).not.toBeNull();
    expect(scrim()).toBeNull();
    vi.advanceTimersByTime(800);
    expect(scrim()).not.toBeNull();
    // no answer at all: it does not wait forever
    root.replaceChildren();
    save.seen.aiLostCard = false;
    mount();
    ui.show({ id: 'results', data: results(standing({ rank: 1, phase: 'pending' }), { crown: true }) });
    vi.advanceTimersByTime(3800);
    expect(scrim()).not.toBeNull();
    // no rank row: as before, 1.1 s
    root.replaceChildren();
    save.seen.aiLostCard = false;
    mount();
    ui.show({ id: 'results', data: results(null, { crown: true }) });
    vi.advanceTimersByTime(1150);
    expect(scrim()).not.toBeNull();
  });

  it('reduced motion: the stamp fades (CSS), still: the final frame', () => {
    save.settings.motion = 'off';
    mount();
    ui.show({ id: 'results', data: results(standing({ rank: 37, exact: true, phase: 'confirmed', stamp: 'in' })) });
    expect(root.querySelector('.yp')!.classList.contains('yp--reduce')).toBe(true);
    expect(root.querySelector('.stamp--rank.is-new')).not.toBeNull();
    const css = readFileSync(resolve(process.cwd(), 'src/ui/styles.css'), 'utf8');
    expect(css).toMatch(/\.yp--reduce \.stamp--rank\.is-new,\s*\.yp--reduce \.rank-up\.is-new,\s*\.yp--reduce \.res-rank-sub\.is-new \{\s*animation: yp-fade-in 0\.3s/);
    expect(css).toMatch(/\.yp--still \.stamp--rank\.is-new,\s*\.yp--still \.rank-up\.is-new,\s*\.yp--still \.res-rank-sub\.is-new \{\s*animation: none !important/);
    expect(css).toMatch(/@keyframes yp-stamp-press/);
  });

  it('no row on a failed run, practice, assist, the daily, or without a standing', () => {
    mount();
    const st = standing({ rank: 342, pct: 32.2, candidate: false });
    ui.show({ id: 'results', data: results(st, { ok: false, score: null }) });
    expect(root.querySelector('.res-rank')).toBeNull();
    ui.show({ id: 'results', data: results(null) });
    expect(root.querySelector('.res-rank')).toBeNull();
    ui.show({ id: 'results', data: results(st, { level: { ...lv('2-2'), id: 'd:5', world: 0 } as LevelDef }) });
    expect(root.querySelector('.res-rank')).toBeNull();
    // practice
    ui.fx({ t: 'levelLoaded', level: lv('2-2') });
    ui.show({ id: 'hud' });
    ui.hud(hudState({ mode: 'practice', running: true, timeSub: 300 }));
    ui.fx({ t: 'success', score: 314, medal: 0, crown: false, firstCrown: false, pb: false, badges: [] });
    ui.show({ id: 'results', data: results(st) });
    expect(root.querySelector('.res-rank')).toBeNull();
    // assist
    root.replaceChildren();
    mount({ pause: () => ({ assist: true }) });
    ui.fx({ t: 'levelLoaded', level: lv('2-2') });
    ui.fx({ t: 'success', score: 314, medal: 3, crown: false, firstCrown: false, pb: true, badges: [] });
    ui.show({ id: 'results', data: results(st) });
    expect(root.querySelector('.res-rank')).toBeNull();
    // a normal run shows it
    root.replaceChildren();
    mount();
    ui.show({ id: 'results', data: results(st) });
    expect(rowText()).toContain('世界 約342位');
  });
});

describe('ranking screen', () => {
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  const full = (over: Partial<BoardResponse> = {}): BoardResponse => ({ key: KEY, n: 1065, aiBeaten: 37, par: 324, cutoff: 497, top: rows(100, 37), hist: crowdHist(1065), ...over });

  it('renders at once from the boot top 10 with skeleton rows, then the answer replaces it', async () => {
    let answer!: (r: BoardResponse | null) => void;
    mount({ boot: () => boot(), fetchBoard: () => new Promise((res) => { answer = res; }) });
    ui.show({ id: 'board', key: KEY });
    expect(root.querySelectorAll('table.board tbody tr[data-rank]')).toHaveLength(10);
    expect(root.querySelectorAll('.skel')).toHaveLength(6);
    expect(root.querySelector('.board-sum')!.textContent).toContain('参加 812人');
    answer(full());
    await flush();
    expect(root.querySelectorAll('table.board tbody tr[data-rank]')).toHaveLength(100);
    expect(root.querySelectorAll('.skel')).toHaveLength(0);
    expect(root.querySelector('.board-sum')!.textContent).toContain('参加 1,065人');   // the same format as the rank row
  });

  it('my row: is-me, a one-time flash and a scroll to the middle', async () => {
    const scroll = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll });
    try {
      mount({ boot: () => boot({ top: rows(10, 4) }), fetchBoard: async () => full({ top: rows(100, 4) }) });
      ui.show({ id: 'board', key: KEY });
      const first = root.querySelector('tr.is-me')!;
      expect(first.classList.contains('is-flash')).toBe(true);
      expect(scroll).toHaveBeenCalledTimes(1);
      expect(scroll.mock.calls[0]![0]).toMatchObject({ block: 'center', behavior: 'smooth' });
      await flush();
      // the full list keeps my row: the flash carries on where it was (negative delay), no second jump
      const again = root.querySelector<HTMLElement>('tr.is-me')!;
      expect(again).not.toBe(first);
      expect(again.classList.contains('is-flash')).toBe(true);
      expect(Number.parseFloat(again.style.getPropertyValue('--flash-delay'))).toBeLessThanOrEqual(0);
      expect(scroll).toHaveBeenCalledTimes(1);
      expect(root.querySelector('.board-pin')).toBeNull();
    } finally {
      delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it('reduced motion: no flash, an instant scroll', async () => {
    save.settings.motion = 'off';
    const scroll = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll });
    try {
      mount({ fetchBoard: async () => full() });
      ui.show({ id: 'board', key: KEY });
      await flush();
      expect(root.querySelector('tr.is-me')!.classList.contains('is-flash')).toBe(false);
      expect(scroll.mock.calls[0]![0]).toMatchObject({ behavior: 'auto' });
    } finally {
      delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it('pinned row: an estimate (約, 上位 x%) below a gap row when I am outside a full top 100', async () => {
    save.levels['2-2']!.bestSub = 900;
    save.levels['2-2']!.sentSub = 900;
    const hist = crowdHist(1065);
    mount({ fetchBoard: async () => full({ top: rows(100), hist }) });
    ui.show({ id: 'board', key: KEY });
    await flush();
    const e = estimateLevelRank(hist, 497, 900, 900)!;
    const pin = root.querySelector('.board-pin')!;
    expect(pin.textContent).toContain(`約${e.rank}位`);
    expect(pin.textContent).toContain(`上位${levelPct(e.rank, e.n)}%`);
    expect(pin.textContent).toContain('あなた');
    expect(pin.textContent).toContain('7.500');
    expect(pin.textContent).not.toContain('未送信');
    const gap = root.querySelectorAll('table.board tbody tr');
    expect(gap[gap.length - 1]!.classList.contains('is-gap')).toBe(true);
    expect(gap[gap.length - 1]!.textContent).toBe('⋮');
  });

  it('pinned row: 未送信 when the server does not count this best (no sentSub, or another bin)', () => {
    const v: BoardView = { n: 1065, aiBeaten: 37, par: 324, cutoff: 497, top: rows(100), hist: crowdHist(1065), cleared: null, complete: true };
    save.levels['2-2']!.bestSub = 900;
    delete save.levels['2-2']!.sentSub;
    expect(levelPin(v, save, KEY)).toMatchObject({ unsent: true, status: null, approx: true });
    save.levels['2-2']!.sentSub = 1300;   // counted with a slower time in another bin
    expect(levelPin(v, save, KEY)!.unsent).toBe(true);
    save.levels['2-2']!.sentSub = 901;    // same bin: the server would write nothing
    expect(levelPin(v, save, KEY)!.unsent).toBe(false);
  });

  it('pinned row: 反映待ち for a top-100 time the list does not have yet; 100位圏外 without a histogram', async () => {
    save.levels['2-2']!.bestSub = 260;   // between rank 20 and 21
    save.levels['2-2']!.sentSub = 260;
    mount({ fetchBoard: async () => full({ top: rows(100) }) });
    ui.show({ id: 'board', key: KEY });
    await flush();
    let pin = root.querySelector('.board-pin')!;
    expect(pin.textContent).toContain('反映待ち');
    expect(pin.textContent).not.toMatch(/\d+位/);
    // its time belongs among the rows: no 「⋮」 (that would read as "below #100")
    expect(root.querySelector('tr.is-gap')).toBeNull();
    // outside the top 100 with no histogram yet
    save.levels['2-2']!.bestSub = 900;
    save.levels['2-2']!.sentSub = 900;
    root.replaceChildren();
    mount({ fetchBoard: async () => { const r = full({ top: rows(100) }); delete r.hist; return r; } });
    ui.show({ id: 'board', key: KEY });
    await flush();
    pin = root.querySelector('.board-pin')!;
    expect(pin.textContent).toContain('100位圏外');
    expect(root.querySelector('tr.is-gap')).not.toBeNull();
  });

  it('no pinned row for a best on another level hash, or without a best', () => {
    const v: BoardView = { n: 1065, aiBeaten: 37, par: 324, cutoff: 497, top: rows(100), hist: crowdHist(1065), cleared: null, complete: true };
    save.levels['2-2']!.bestSub = 900;
    save.levels['2-2']!.hash = 'ffffffff';
    expect(levelPin(v, save, KEY)).toBeNull();
    save.levels['2-2']!.hash = '00000000';
    save.levels['2-2']!.bestSub = null;
    expect(levelPin(v, save, KEY)).toBeNull();
    expect(levelPin(v, null, KEY)).toBeNull();
  });

  it('the boot render shows a pinned estimate below the top 10 too (never an unmarked number)', () => {
    save.levels['2-2']!.bestSub = 300;   // slower than the boot top 10, faster than the cutoff
    save.levels['2-2']!.sentSub = 300;
    const v: BoardView = { n: 1065, aiBeaten: 37, par: 324, cutoff: 497, top: rows(10), hist: crowdHist(1065), cleared: null, complete: false };
    const p = levelPin(v, save, KEY)!;
    expect(p.rank).not.toBeNull();
    expect(p.rank!).toBeGreaterThanOrEqual(11);
    expect(p.rank!).toBeLessThanOrEqual(100);
    expect(p.approx).toBe(true);
  });

  it('a fetch failure after the instant render keeps it and says 上位10位まで表示中', async () => {
    mount({ boot: () => boot(), fetchBoard: async () => null });
    ui.show({ id: 'board', key: KEY });
    await flush();
    expect(root.querySelectorAll('table.board tbody tr[data-rank]')).toHaveLength(10);
    expect(root.querySelector('.board-partial')!.textContent).toBe('上位10位まで表示中');
    expect(root.querySelectorAll('.skel')).toHaveLength(0);
    expect(root.querySelector('.empty')).toBeNull();
    // without a boot copy: the offline empty state as before
    root.replaceChildren();
    mount({ fetchBoard: async () => null });
    ui.show({ id: 'board', key: KEY });
    await flush();
    expect(root.querySelector('.empty')!.textContent).toContain('オフライン');
  });

  it('a boot board of fewer than 10 rows is the whole board: no skeleton, no 上位10位 line when the fetch fails', async () => {
    mount({ boot: () => boot({ top: rows(3, 2) }), fetchBoard: async () => null });
    ui.show({ id: 'board', key: KEY });
    expect(root.querySelectorAll('.skel')).toHaveLength(0);
    expect(root.querySelectorAll('table.board tbody tr[data-rank]')).toHaveLength(3);
    expect(root.querySelector('tr.is-me')!.getAttribute('data-rank')).toBe('2');
    await flush();
    expect(root.querySelector('.board-partial')).toBeNull();
    expect(root.querySelector('table.board tr.is-ai')).not.toBeNull();   // the whole list: the AI row goes after it
  });

  it('daily: the pinned row takes the rank of the last answer (約 above 100) or the histogram', async () => {
    const day: DailyView = { dayIndex: 22, n: 23, level: { ...lv('2-2'), id: 'd:17', world: 0 } as LevelDef, balls: ['ok', null, null, null, null], bestSub: 396, parSub: 402, top: null, rank: 480, pct: 9.6, streak: 1, shareText: '' };
    const fast = rows(100).map((r, i): BoardRow => [r[0], r[1], 200 + i, r[3], r[4], r[5]]);   // 200..299: my 396 is below
    mount({ daily: () => day, fetchBoard: async () => ({ key: DKEY, n: 5012, aiBeaten: 120, par: 402, cutoff: 299, top: fast, hist: [], cleared: 3811 }) });
    ui.show({ id: 'board', key: DKEY });
    await flush();
    const pin = root.querySelector('.board-pin')!;
    expect(pin.textContent).toContain('約480位');
    expect(pin.textContent).toContain('上位9.6%');
    expect(pin.textContent).toContain('3.300');
    expect(pin.textContent).not.toContain('未送信');
    // from the histogram when the answer had no rank; a best not sent yet is 未送信
    const hist = new Array<number>(150).fill(0);
    for (let i = 0; i < 5000; i++) hist[Math.floor((i / 5000) * 40)]! += 1;
    const v: BoardView = { n: 5000, aiBeaten: 0, par: 402, cutoff: 299, top: fast, hist, cleared: 5000, complete: true };
    save.daily.lastSentT120 = 500;
    const p = dailyPin(v, save, DKEY, { ...day, rank: null, pct: null })!;
    expect(p.rank!).toBeGreaterThan(100);
    expect(p.approx).toBe(true);
    expect(p.unsent).toBe(true);
    expect(p.pct).not.toBeNull();
    // a best that belongs in the list shown but is not there: 反映待ち (no number)
    expect(dailyPin({ ...v, top: rows(100) }, save, DKEY, day)).toMatchObject({ rank: null, status: null, unsent: true });
    save.daily.lastSentT120 = 396;
    expect(dailyPin({ ...v, top: rows(100) }, save, DKEY, day)).toMatchObject({ rank: null, status: 'pending', unsent: false });
    // another day's view: no pinned row
    expect(dailyPin(v, save, DKEY, { ...day, dayIndex: 21 })).toBeNull();
  });

  it('English pinned row', async () => {
    save.settings.lang = 'en';
    setLang('en');
    save.levels['2-2']!.bestSub = 900;
    delete save.levels['2-2']!.sentSub;
    mount({ fetchBoard: async () => full({ top: rows(100) }) });
    ui.show({ id: 'board', key: KEY });
    await flush();
    const pin = root.querySelector('.board-pin')!.textContent!;
    expect(pin).toMatch(/~#\d+/);
    expect(pin).toContain('Top ');
    expect(pin).toContain('Not sent');
    expect(pin).toContain('You');
  });
});

describe('daily hub', () => {
  const view = (rank: number | null): DailyView => ({
    dayIndex: 22, n: 23, level: { ...lv('2-2'), id: 'd:17', world: 0 } as LevelDef, balls: ['ok', null, null, null, null],
    bestSub: 396, parSub: 402, top: [], rank, pct: 9.6, streak: 1, shareText: '',
  });
  const rankStat = (): string => [...root.querySelectorAll('.stat')].find((s) => s.textContent!.includes('あなたの順位'))!.querySelector('.stat-val')!.textContent!;

  it('shows 約 above 100 (a histogram estimate), none within the top 100', () => {
    mount();
    ui.show({ id: 'daily', data: view(1480) });
    expect(rankStat()).toContain('約1,480位');
    ui.show({ id: 'daily', data: view(37) });
    expect(rankStat()).toContain('37位');
    expect(rankStat()).not.toContain('約');
  });
});
