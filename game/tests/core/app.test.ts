// @vitest-environment happy-dom
// The §9.4 state machine end to end with fake UI / renderer / input / store / api and the real sim, servo and data. Owner: O3.
import { describe, expect, it } from 'vitest';
import { createApp, type App, type AppDeps } from '../../src/core/app';
import { createGameData, bundledSources, type GameData } from '../../src/core/data';
import { createSession } from '../../src/core/session';
import { servoQ } from '../../src/input/servo';
import { Status } from '../../src/sim/run';
import type { DailyDef, LevelDef } from '../../src/sim/level';
import { DAILY_EPOCH, DAY_MS, pickDaily } from '../../src/shared/daily';
import { challengeUrl } from '../../src/core/links';
import { decodeReplay, simulateReplay } from '../../src/sim/replay';
import { b64urlDecode } from '../../src/sim/b64';
import { FakeApi, FakeInput, FakeRenderer, FakeUI, LAYOUT, MemStore } from './fakes';
import goldenFile from '../fixtures/golden_replays.json';

const golden = (goldenFile as unknown as { replays: { id: string; replay: string }[] }).replays;
const goldenReplay = (id: string): string => golden.find((r) => r.id === id)!.replay;

const data = createGameData();
const L = (id: string): LevelDef => data.level(id)!;

interface Rig { app: App; ui: FakeUI; renderer: FakeRenderer; input: FakeInput; store: MemStore; api: FakeApi | null }

function rig(opts: { hash?: string; store?: MemStore; api?: FakeApi | null; data?: GameData; now?: number } = {}): Rig {
  const ui = new FakeUI();
  const renderer = new FakeRenderer();
  const input = new FakeInput();
  const store = opts.store ?? new MemStore();
  const api = opts.api === undefined ? null : opts.api;
  const deps: Partial<AppDeps> = {
    ui, renderer, input, store, api, audio: null, haptics: null, data: opts.data ?? data, autoStart: false,
    now: () => opts.now ?? DAILY_EPOCH + 10 * DAY_MS + 3600_000,
    location: { hash: opts.hash ?? '', protocol: 'https:', origin: 'https://y.example' },
    prefersReducedMotion: () => false,
  };
  const app = createApp(document.createElement('div'), deps);
  return { app, ui, renderer, input, store, api };
}

/** Advances wall-clock frames of 1/15 s (4 ticks each) until pred() or maxFrames. */
function until(r: Rig, pred: () => boolean, maxFrames = 3000, dt = 1 / 15): number {
  for (let i = 0; i < maxFrames; i++) {
    if (pred()) return i;
    r.app.advance(dt);
  }
  return pred() ? maxFrames : -1;
}

/** A 1-1 success replay: servo straight to the pad, then wait (as in a first play). */
function replay11(): string {
  const lv = L('1-1');
  const s = createSession(lv);
  const frame = { intent: { kind: 'target' as const, x: 1.5 }, fine: false, device: 1, targetX: 1.5 };
  for (let i = 0; i < 3600; i++) {
    if (s.tick(servoQ(frame, s.run.s, lv.physics, false), frame) !== Status.Running && s.started) break;
  }
  expect(s.status()).toBe(Status.Success);
  return s.replay()!;
}

function crashInto12(r: Rig): void {
  r.input.push(40);
  expect(until(r, () => r.app.state() === 'CRASH_BEAT', 200)).toBeGreaterThanOrEqual(0);
  r.input.idle();
}

describe('boot and title', () => {
  it('boots to TITLE with the 2-2 AI attract, any input -> READY(1-1) while 1-1 is uncleared', () => {
    const r = rig();
    expect(r.app.state()).toBe('TITLE');
    expect(r.ui.last).toEqual({ id: 'title' });
    expect(r.renderer.loaded).toEqual(['2-2']);
    r.app.advance(0.5);
    expect(r.renderer.lastFrame!.ghosts.map((g) => g.kind)).toEqual(['ai']);
    r.input.command('any');
    expect(r.app.state()).toBe('READY');
    expect(r.app.debugState().level).toBe('1-1');
    expect(r.ui.last).toEqual({ id: 'hud' });
  });

  it('title -> LEVEL_SELECT once 1-1 is cleared (the UI title button emits select)', () => {
    const store = new MemStore();
    store.d.levels['1-1'] = { ...emptyP(data.hash(L('1-1'))), cleared: true };
    const r = rig({ store });
    r.ui.emit('select', { from: 'title' });
    expect(r.app.state()).toBe('LEVEL_SELECT');
    expect(r.ui.last).toMatchObject({ id: 'select', world: 1 });
  });
});

describe('READY -> RUNNING -> results', () => {
  it('READY is static: no ticks until the servo asks for a force', () => {
    const r = rig();
    r.input.command('any');
    for (let i = 0; i < 30; i++) r.app.advance(1 / 60);
    expect(r.app.state()).toBe('READY');
    expect(r.app.debugState().ticks).toBe(0);
    expect(r.input.samples).toBeGreaterThanOrEqual(29);
    r.input.target(1.5);
    r.app.advance(1 / 60);
    expect(r.app.state()).toBe('RUNNING');
    expect(r.ui.fxs.some((e) => e.t === 'runStart')).toBe(true);
  });

  it('a 1-1 success replay -> SUCCESS_BEAT -> RESULTS, PB stored, hides the AI on the very first try', async () => {
    const r = rig();
    r.input.command('any');
    expect(r.app.debugState().ghosts).toEqual([]); // first attempt on 1-1: AI hidden
    const res = await r.app.playReplay('1-1', replay11());
    expect(res.status).toBe(Status.Success);
    expect(res.state).toBe('RESULTS');
    const shown = r.ui.last as Extract<ReturnType<FakeUI['screens']['at']>, { id: 'results' }>;
    expect(shown.id).toBe('results');
    expect(shown.data.ok).toBe(true);
    expect(shown.data.score).toBe(res.score);
    expect(shown.data.replay).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(shown.data.badges).toContain('ippatsu');
    expect(Number.isNaN(shown.data.gapMm)).toBe(true); // 1-1 has no walls
    const p = r.store.d.levels['1-1']!;
    expect([p.cleared, p.attempts, p.fails, p.bestSub]).toEqual([true, 1, 0, res.score]);
    expect(p.bestReplay).toBe(shown.data.replay);
    const success = r.ui.fxs.find((e) => e.t === 'success');
    expect(success).toMatchObject({ t: 'success', score: res.score, pb: false });
    // retry: the AI ghost and the new PB ghost ride along now
    r.input.command('retry');
    expect(r.app.state()).toBe('READY');
    expect(r.app.debugState().ghosts).toEqual(['ai', 'pb']);
  });

  it('retry is immediate and never reloads the level', () => {
    const r = rig();
    r.input.command('any');
    r.input.target(1.5);
    until(r, () => r.app.debugState().ticks > 100);
    const loads = r.renderer.loaded.length;
    const t0 = performance.now();
    r.input.command('retry');
    const ms = performance.now() - t0;
    expect(r.app.state()).toBe('READY');
    expect(ms).toBeLessThan(100);
    expect(r.renderer.loaded.length).toBe(loads);
    expect(r.renderer.resets).toBeGreaterThan(0);
    expect(r.store.d.levels['1-1']).toMatchObject({ attempts: 1, fails: 1 });
  });

  it('a false start (< 1 s) is neither an attempt nor a failure', () => {
    const r = rig();
    r.input.command('any');
    r.input.target(1.5);
    until(r, () => r.app.debugState().ticks >= 20);
    r.input.command('retry');
    expect(r.store.d.levels['1-1']?.attempts ?? 0).toBe(0);
  });
});

function rig12(): Rig {
  const store = new MemStore();
  store.d.levels['1-1'] = { ...emptyP(data.hash(L('1-1'))), cleared: true };
  const r = rig({ store });
  r.ui.emit('openLevel', '1-2');
  expect(r.app.state()).toBe('READY');
  expect(r.app.debugState().level).toBe('1-2');
  return r;
}

describe('crashes, hints and the auto demo (§7.4)', () => {
  it('crash -> CRASH_BEAT (0.7 s) -> READY, input skips the beat', () => {
    const r = rig12();
    crashInto12(r);
    expect(r.ui.fxs.find((e) => e.t === 'crash')).toMatchObject({ t: 'crash', kind: expect.any(Number) });
    expect(r.renderer.lastFrame).not.toBeNull();
    r.app.advance(0.05);
    expect(r.renderer.lastFrame!.timeScale).toBe(0); // 80 ms hit-stop
    r.app.advance(0.1);
    expect(r.renderer.lastFrame!.timeScale).toBeCloseTo(0.35, 6);
    until(r, () => r.app.state() !== 'CRASH_BEAT', 40, 0.05);
    expect(r.app.state()).toBe('READY');
    crashInto12(r);
    r.input.command('any');
    expect(r.app.state()).toBe('READY');
  });

  it('three crashes open hint 1 and play the AI demo once; the demo is skippable', () => {
    const r = rig12();
    for (let i = 0; i < 3; i++) {
      crashInto12(r);
      if (i < 2) r.input.command('any');
    }
    expect(r.ui.toasts.some((t) => t.text.includes('1/3'))).toBe(true);
    // R ends the third crash beat -> auto demo; the 'any' that follows the same key press must not skip it
    r.input.command('retry');
    r.input.command('any');
    expect(r.app.state()).toBe('DEMO');
    expect(r.ui.last).toMatchObject({ id: 'demo' });
    expect(r.store.d.levels['1-2']!.demoShown).toBe(true);
    r.app.advance(0.2);
    r.input.command('any'); // key mashing right after the crash does not skip it either
    expect(r.app.state()).toBe('DEMO');
    r.app.advance(0.25);
    expect(r.app.debugState().mode).toBe('demo');
    r.input.command('any');
    expect(r.app.state()).toBe('READY');
    r.app.advance(1 / 60);
    const hud = r.ui.huds.at(-1)!;
    expect(hud.hint).toBeTruthy(); // the READY line shows hint 1
    for (let i = 0; i < 3; i++) {
      crashInto12(r);
      r.input.command('any');
    }
    expect(r.app.state()).toBe('READY'); // no second demo
    expect(r.store.d.levels['1-2']).toMatchObject({ fails: 6, consecutiveCrashes: 6 });
    expect(r.ui.toasts.some((t) => t.text.includes('2/3'))).toBe(true);
  });

  it('the demo plays to the end on its own and returns to READY', () => {
    const r = rig12();
    r.ui.emit('demo');
    expect(r.app.state()).toBe('DEMO');
    const n = until(r, () => r.app.state() !== 'DEMO', 2000, 1 / 30);
    expect(n).toBeGreaterThan(30);
    expect(r.app.state()).toBe('READY');
  });
});

describe('pause', () => {
  it('stops the sim clock and resumes', () => {
    const r = rig();
    r.input.command('any');
    r.input.target(1.5);
    until(r, () => r.app.debugState().ticks > 10);
    r.ui.emit('pause');
    expect(r.app.state()).toBe('PAUSED');
    const t = r.app.debugState().ticks;
    for (let i = 0; i < 20; i++) r.app.advance(1 / 60);
    expect(r.app.debugState().ticks).toBe(t);
    r.ui.emit('resume');
    expect(r.app.state()).toBe('RUNNING');
    r.app.advance(1 / 30);
    expect(r.app.debugState().ticks).toBeGreaterThan(t);
  });
});

describe('links (§7.5, §2.2)', () => {
  it('a broken challenge link goes to level select with a message, without throwing', () => {
    const r = rig({ hash: '#c=2-2.%%%garbage' });
    expect(r.app.state()).toBe('LEVEL_SELECT');
    expect(r.ui.toasts.length).toBeGreaterThan(0);
  });

  it('a challenge link plays the 1-1 tutorial first when 1-1 is uncleared, skip goes on', () => {
    const rep = replay11();
    const r = rig({ hash: new URL(challengeUrl('https://y.example', '1-2', rep)).hash });
    // the replay is a 1-1 replay: its levelHash does not match 1-2 -> stale, opened without the ghost
    expect(r.app.state()).toBe('READY');
    expect(r.app.debugState()).toMatchObject({ level: '1-1', tutorial: true });
    r.ui.emit('skip');
    expect(r.app.debugState()).toMatchObject({ level: '1-2', mode: 'challenge', tutorial: false });
    expect(r.ui.toasts.some((t) => t.kind === 'warn')).toBe(true);
  });

  it('a valid challenge opens the level (even locked) with the white challenge ghost', () => {
    const store = new MemStore();
    store.d.levels['1-1'] = { ...emptyP(data.hash(L('1-1'))), cleared: true };
    const rep = replay11();
    const r = rig({ store, hash: `#c=1-1.${rep}` });
    expect(r.app.debugState()).toMatchObject({ state: 'READY', level: '1-1', mode: 'challenge' });
    expect(r.app.debugState().ghosts).toContain('challenge');
    // the ghost's own stateHash is the Worker's (simulateReplay of the link replay), for the M11 round trip
    const { qs } = decodeReplay(b64urlDecode(rep));
    expect(r.app.debugState().challengeHash).toBe(simulateReplay(L('1-1').physics, qs).stateHash);
    const r2 = rig({ store, hash: '#l=5-4' });
    expect(r2.app.debugState()).toMatchObject({ level: '5-4' });
    expect(['READY', 'BRIEFING']).toContain(r2.app.state());
  });
});

describe('ghost sets (§7.6)', () => {
  it('G cycles AI+PB -> AI -> (WR, rival skipped while missing) -> research -> none', () => {
    const store = new MemStore();
    for (const id of ['1-1', '1-2', '1-3', '1-4', '2-1']) store.d.levels[id] = { ...emptyP(data.hash(L(id))), cleared: true, briefed: true };
    const r = rig({ store });
    r.ui.emit('openLevel', '2-2');
    if (r.app.state() === 'BRIEFING') r.input.command('any');
    expect(r.app.state()).toBe('READY');
    expect(r.app.debugState().ghosts).toEqual(['ai']);
    r.input.command('ghostCycle');
    expect(r.store.d.settings.ghostSet).toBe(1);
    r.input.command('ghostCycle');
    expect(r.app.debugState().ghosts).toEqual(['ai', 'research_fast', 'research_pump']);
    r.input.command('ghostCycle');
    expect(r.store.d.settings.ghostSet).toBe(4);
    expect(r.app.debugState().ghosts).toEqual([]);
    r.input.command('ghostCycle');
    expect(r.store.d.settings.ghostSet).toBe(0);
  });
});

describe('daily (§7.5)', () => {
  /** The pool is not bundled yet: 84 entries made from 1-2 (tier = i % 7 + 1). */
  function dailyData(): GameData {
    const src = bundledSources();
    const base = L('1-2');
    const pool: DailyDef[] = Array.from({ length: 84 }, (_, i) => ({
      ...base, id: `d:${i}`, world: 0, order: i, tier: ((i % 7) + 1) as DailyDef['tier'], template: 'hop', parSub: 300, hints: undefined,
    }));
    return createGameData({ ...src, dailyPool: { format: 1, pool } });
  }

  it('balls are consumed at tick 0; the fifth sends the day and shows the hub', () => {
    const api = new FakeApi();
    const store = new MemStore();
    const dd = dailyData();
    const now = DAILY_EPOCH + 10 * DAY_MS + 3600_000;
    const r = rig({ store, api, data: dd, now });
    r.ui.emit('openDaily');
    expect(r.app.state()).toBe('DAILY_HUB');
    const view = (r.ui.last as { id: 'daily'; data: { n: number; balls: unknown[]; shareText: string } }).data;
    expect(view.n).toBe(11);
    expect(view.balls).toEqual([null, null, null, null, null]);
    r.ui.emit('openLevel', pickDaily(dd.dailyPool, now).level.id);
    expect(r.app.debugState()).toMatchObject({ state: 'READY', mode: 'daily' });
    for (let ball = 0; ball < 5; ball++) {
      r.input.push(40);
      until(r, () => r.app.state() === 'RUNNING', 10);
      expect(store.d.daily.balls.filter((b) => b !== null).length).toBe(ball + 1);
      until(r, () => r.app.state() === 'CRASH_BEAT', 200);
      r.input.idle();
      r.input.command('any');
    }
    expect(store.d.daily.balls).toEqual(['fail', 'fail', 'fail', 'fail', 'fail']);
    expect(r.app.state()).toBe('DAILY_HUB');
    const q = api.queued.at(-1)!;
    expect(q).toMatchObject({ level: expect.stringMatching(/^d:/), replay: null, t120: null, tries: 5, balls: 'XXXXX' });
    expect(q.board).toMatch(/^D:00010:[0-9a-f]{8}:s1$/);
    expect(api.flushes).toContain('dailyDone');
    expect(store.d.daily.streak).toBe(1);
    // afterwards: unlimited practice
    r.ui.emit('retry');
    expect(r.app.debugState()).toMatchObject({ state: 'READY', mode: 'practice' });
  });
});

describe('daily extras', () => {
  function pool11(): GameData {
    const src = bundledSources();
    const base = L('1-1');
    const pool: DailyDef[] = Array.from({ length: 84 }, (_, i) => ({
      ...base, id: `d:${i}`, world: 0, order: i, tier: ((i % 7) + 1) as DailyDef['tier'], template: 'hop', parSub: 300, hints: undefined,
    }));
    return createGameData({ ...src, dailyPool: { format: 1, pool } });
  }

  it('an official daily success settles the ball and never shows 一発 (a campaign-level badge)', () => {
    const now = DAILY_EPOCH + 10 * DAY_MS + 3600_000;
    const dd = pool11();
    const r = rig({ api: new FakeApi(), data: dd, now });
    r.ui.emit('openDaily');
    r.ui.emit('openLevel', pickDaily(dd.dailyPool, now).level.id);
    expect(r.app.debugState().mode).toBe('daily');
    r.input.target(1.5);
    until(r, () => r.app.state() === 'RESULTS', 3000);
    const last = r.app.debugState().last!;
    expect(last.ok).toBe(true);
    expect(last.badges).not.toContain('ippatsu');
    expect(r.store.d.daily.balls[0]).not.toBe('fail');
    expect(r.store.d.daily.bestSub).toBe(last.score);
  });

  it("command('openLevel:d:<i>') opens another day's daily level as practice", () => {
    const now = DAILY_EPOCH + 10 * DAY_MS + 3600_000;
    const dd = pool11();
    const today = pickDaily(dd.dailyPool, now).level.id;
    const other = dd.dailyPool.find((l) => l.id !== today)!.id;
    const r = rig({ data: dd, now });
    r.app.command(`openLevel:${other}`);
    expect(r.app.debugState()).toMatchObject({ state: 'READY', level: other, mode: 'practice' });
  });
});

describe('trick toasts (§7.3): once per save, not per run', () => {
  it('the same replay twice toasts its tricks only the first time', async () => {
    const r = rig();
    const first = await r.app.playReplay('2-2', goldenReplay('2-2/pump'));
    expect(first).toMatchObject({ status: Status.Crash, state: 'READY' });
    const tricks1 = r.ui.toasts.filter((t) => t.kind === 'badge').length;
    expect(tricks1).toBeGreaterThan(0);
    expect(r.store.d.seen.tricks.length).toBe(tricks1);
    await r.app.playReplay('2-2', goldenReplay('2-2/pump'));
    expect(r.ui.toasts.filter((t) => t.kind === 'badge').length).toBe(tricks1);
  });
});

describe('HUD and render frame (§9.3, §4.8)', () => {
  it('the HUD gets screen anchors for the swing meter, the required-angle arc and the gap gauge', () => {
    const r = rig12();
    r.app.advance(1 / 60);
    let a = r.ui.huds.at(-1)!.anchors!;
    expect(a).toBeTruthy();
    // FakeRenderer.worldToScreen: x -> 640 + 200 x, y -> 600 - 200 y; the trolley is at x = 0, the ball hangs 1 m below
    expect(a.pivot).toEqual({ x: 640, y: 600 - 200 * 1.25 });
    expect(a.ball.x).toBeCloseTo(640, 6);
    expect(a.ball.y).toBeCloseTo(600 - 200 * 0.25, 6);
    expect(a.pxPerM).toBeCloseTo(200, 6);
    expect(a.reqDeg).toBeGreaterThan(20); // the 1-2 wall is within 1.2 m: its required angle is previewed at READY
    expect(a.reqDir).toBe(1);
    r.input.target(0.6);
    until(r, () => r.app.debugState().ticks > 30);
    a = r.ui.huds.at(-1)!.anchors!;
    expect(a.pivot.x).toBeGreaterThan(640);
    expect(r.ui.huds.at(-1)!.running).toBe(true);
  });

  it('pausing keeps the interpolated pose (no jump to the next tick) and the ghosts where they were', () => {
    const r = rig();
    r.input.command('any');
    r.input.target(1.5);
    until(r, () => r.app.debugState().ticks > 20);
    r.app.advance(1 / 120); // leave half a tick in the accumulator
    const before = r.renderer.lastFrame!;
    expect(before.alpha).toBeGreaterThan(0.2);
    expect(before.alpha).toBeLessThan(0.8);
    r.ui.emit('pause');
    r.app.advance(1 / 60);
    const paused = r.renderer.lastFrame!;
    expect(paused.alpha).toBeCloseTo(before.alpha, 9);
    expect(paused.cur.x).toBe(before.cur.x);
  });

  it('a rotation (layout change) keeps the run and the target: resetForRun is not called', () => {
    const r = rig();
    r.input.command('any');
    r.input.target(1.5);
    until(r, () => r.app.debugState().ticks > 20);
    const resets = r.input.resets.length;
    r.ui.layoutCb!({ ...LAYOUT, kind: 'tall', w: 390, h: 844 });
    r.app.advance(1 / 60);
    expect(r.input.resets.length).toBe(resets);
    expect(r.app.state()).toBe('RUNNING');
  });

  it('the title attract drives the crane with the AI run (the tall follow camera keeps it in view)', () => {
    const r = rig();
    r.app.advance(0.1);
    const x0 = r.renderer.lastFrame!.cur.x;
    for (let i = 0; i < 20; i++) r.app.advance(0.1);
    const f = r.renderer.lastFrame!;
    expect(f.cur.x).not.toBeCloseTo(x0, 3);
    expect(f.ghosts[0]!.x).toBeCloseTo(f.cur.x, 5);
  });
});

describe('1-1 contextual hint (§2.2 0:10, §7.4)', () => {
  it('fires once ever: still swinging over the pad for 1.5 s -> hint 2 as a toast, remembered in hintsSeen', () => {
    const store = new MemStore();
    const r = rig({ store });
    r.input.command('any');
    r.input.target(1.5); // the trolley parks on the pad, the ball keeps swinging well above 5 deg
    until(r, () => r.ui.toasts.length > 0, 400);
    const hint = r.ui.toasts.at(-1)!;
    expect(hint.kind).toBe('info');
    expect(store.d.levels['1-1']!.hintsSeen).toBeGreaterThanOrEqual(2);
    // a new session with the same save does not show it again
    const r2 = rig({ store });
    r2.input.command('any');
    r2.input.target(1.5);
    until(r2, () => r2.app.debugState().ticks > 300, 400);
    expect(r2.ui.toasts.filter((t) => t.text === hint.text)).toEqual([]);
  });
});

describe('assist (§3.6)', () => {
  it('a run that used the assist is never a PB, even when the assist is switched off mid-run', async () => {
    const r = rig();
    r.input.command('any');
    r.ui.emit('assistAccept', { on: true });
    r.input.target(1.5);
    until(r, () => r.app.debugState().ticks > 10);
    r.ui.emit('assistAccept', { on: false });
    until(r, () => r.app.state() === 'SUCCESS_BEAT' || r.app.state() === 'RESULTS', 3000);
    expect(r.app.debugState().last).toMatchObject({ ok: true, medal: 0, pb: false });
    expect(r.store.d.levels['1-1']).toMatchObject({ cleared: true, bestSub: null, bestReplay: null });
  });
});

describe('test hooks', () => {
  it('state() is JSON-serialisable and command() takes UI action names', () => {
    const r = rig();
    const s = r.app.debugState();
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
    r.app.command('any');
    expect(r.app.state()).toBe('READY');
    r.app.command('pause');
    expect(r.app.state()).toBe('PAUSED');
    r.app.command('resume');
    expect(r.app.state()).toBe('READY');
    r.app.command('select');
    expect(r.app.state()).toBe('LEVEL_SELECT');
    r.app.command('openLevel:1-1');
    expect(r.app.state()).toBe('READY');
  });
});

function emptyP(hash: string) {
  return {
    hash, cleared: false, skipped: false, attempts: 0, fails: 0, consecutiveCrashes: 0, bestSub: null, bestReplay: null,
    medal: 0 as const, crown: false, badges: [], hintsSeen: 0, briefed: false, demoShown: false, aiBeatenSent: false,
  };
}
