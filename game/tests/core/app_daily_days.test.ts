// @vitest-environment happy-dom
// The daily across JST day boundaries, the pagehide during a ball, and deep links in an open page (§7.5, §7.8, §7.9).
// Owner: O3. Real app / sim / data; FakeApi, or the real api client over FakeServer where the send discipline matters.
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type App, type AppDeps } from '../../src/core/app';
import { bundledSources, createGameData, type GameData } from '../../src/core/data';
import type { DailyDef, LevelDef } from '../../src/sim/level';
import type { InputFrame } from '../../src/input/types';
import { createApi } from '../../src/net/api';
import { decodeReplay, encodeReplay } from '../../src/sim/replay';
import { b64urlDecode, b64urlEncode } from '../../src/sim/b64';
import { SIM_VERSION } from '../../src/sim/constants';
import { dailyBoardKey } from '../../src/shared/api';
import { DAILY_EPOCH, DAY_MS, dayStartMs, jstDayNumber, pickDaily } from '../../src/shared/daily';
import { t } from '../../src/ui/i18n/format';
import { FakeServer, bootRes } from '../net/fakeServer';
import { FakeApi, FakeInput, FakeRenderer, FakeUI, MemStore } from './fakes';
import botFile from '../fixtures/bot_1-1_success.json';

const data0 = createGameData();
const L0 = (id: string): LevelDef => data0.level(id)!;
const BOT_QS: number[] = (botFile as { qs: number[] }).qs;
const BOT_SCORE: number = (botFile as { score: number }).score;
/** 00:00 JST that starts day `day` (dayIndex). */
const dayStart = (day: number): number => DAILY_EPOCH + day * DAY_MS;

/** Input that plays a fixed q sequence as a direct force (one sample per tick), as a keyboard (device 3). */
class ScriptInput extends FakeInput {
  qs: number[] | null = null;
  i = 0;
  play(qs: number[]): void {
    this.qs = qs;
    this.i = 0;
  }
  override sample(): InputFrame {
    if (this.qs) {
      const q = this.i < this.qs.length ? this.qs[this.i++]! : 0;
      return { intent: { kind: 'force', f: (q * 40) / 127 }, fine: false, device: 3, targetX: null };
    }
    return super.sample();
  }
}

interface Rig { app: App; ui: FakeUI; input: ScriptInput; store: MemStore }
const apps: App[] = [];
afterEach(() => {
  while (apps.length) apps.pop()!.dispose();
  setVisibility('visible');
});

function rig(o: { store: MemStore; api: AppDeps['api']; data: GameData; now: () => number; location?: AppDeps['location'] }): Rig {
  const ui = new FakeUI();
  const input = new ScriptInput();
  const app = createApp(document.createElement('div'), {
    ui, renderer: new FakeRenderer(), input, store: o.store, api: o.api, audio: null, haptics: null, data: o.data, autoStart: false,
    now: o.now, location: o.location ?? { hash: '', protocol: 'https:', origin: 'https://y.example' }, prefersReducedMotion: () => false,
  });
  apps.push(app);
  return { app, ui, input, store: o.store };
}

function until(r: Rig, pred: () => boolean, maxFrames = 3000, dt = 1 / 15): boolean {
  for (let i = 0; i < maxFrames; i++) {
    if (pred()) return true;
    r.app.advance(dt);
  }
  return pred();
}

function setVisibility(v: 'hidden' | 'visible'): void {
  Object.defineProperty(document, 'visibilityState', { value: v, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function emptyP(hash: string) {
  return {
    hash, cleared: false, skipped: false, attempts: 0, fails: 0, consecutiveCrashes: 0, bestSub: null, bestReplay: null,
    medal: 0 as const, crown: false, badges: [], hintsSeen: 0, briefed: false, demoShown: false, aiBeatenSent: false,
  };
}

function cleared(...ids: string[]): MemStore {
  const store = new MemStore();
  for (const id of ids) store.d.levels[id] = { ...emptyP(data0.hash(L0(id))), cleared: true, briefed: true };
  return store;
}

/** 84 daily entries made from 1-1 (tier = i % 7 + 1), par 300: the bot's run is a crown. */
function dailyData(): GameData {
  const src = bundledSources();
  const lv = L0('1-1');
  const pool: DailyDef[] = Array.from({ length: 84 }, (_, i) => ({
    ...lv, id: `d:${i}`, world: 0, order: i, tier: ((i % 7) + 1) as DailyDef['tier'], template: 'hop', parSub: 300, hints: undefined,
  }));
  return createGameData({ ...src, dailyPool: { format: 1, pool } });
}

/** Official balls that each end with a mid-run retry (red). */
function useBalls(r: Rig, n: number): void {
  for (let b = 0; b < n; b++) {
    r.input.push(40);
    expect(until(r, () => r.app.state() === 'RUNNING')).toBe(true);
    r.input.idle();
    r.input.command('retry');
  }
}

function openTodaysDaily(r: Rig, data: GameData, nowMs: number): string {
  r.ui.emit('openDaily');
  expect(r.app.state()).toBe('DAILY_HUB');
  const id = pickDaily(data.dailyPool, nowMs).level.id;
  r.ui.emit('openLevel', id);
  expect(r.app.debugState().mode).toBe('daily');
  return id;
}

const boardOf = (data: GameData, day: number): string => dailyBoardKey(day, data.hash(pickDaily(data.dailyPool, dayStart(day)).level));

describe('a daily rack that outlives its JST day (sim-1, client-3)', () => {
  it("a fifth ball that starts before 00:00 and ends after is sent to yesterday's board, then the hub starts the new day", () => {
    const data = dailyData();
    let clock = dayStart(11) - 60_000; // 23:59 JST of day 10
    const api = new FakeApi();
    const r = rig({ store: cleared('1-1', '1-2'), api, data, now: () => clock });
    const level10 = openTodaysDaily(r, data, clock);
    useBalls(r, 4);
    expect(r.store.d.daily.balls).toEqual(['fail', 'fail', 'fail', 'fail', null]);
    expect(api.queued).toEqual([]);
    clock = dayStart(11) - 10_000; // the fifth ball starts at 23:59:50 ...
    r.input.play(BOT_QS);
    expect(until(r, () => r.app.state() === 'RUNNING', 20, 1 / 60)).toBe(true);
    clock = dayStart(11) + 5_000; // ... and ends at 00:00:05 of day 11
    expect(until(r, () => r.app.state() === 'RESULTS', 3000, 1 / 60)).toBe(true);
    expect(r.app.debugState().last).toMatchObject({ ok: true, score: BOT_SCORE });
    const q = api.queued.filter((x) => x.board.startsWith('D:00010:'));
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ board: boardOf(data, 10), level: level10, t120: BOT_SCORE, tries: 5, balls: 'XXXXC', device: 3 });
    expect(q[0]!.replay).toBe(r.store.d.daily.bestReplay);
    expect(api.flushes).toContain('dailyDone');
    // the hub of day 11: a fresh rack, nothing sent for the new day
    r.ui.emit('openDaily');
    expect(r.store.d.daily).toMatchObject({ dayIndex: 11, jstDay: jstDayNumber(clock), bestSub: null, balls: [null, null, null, null, null] });
    expect(api.queued.filter((x) => x.board.startsWith('D:00011:'))).toEqual([]);
  });

  for (const [label, tod, sent] of [['01:00', 3600_000, true], ['03:00', 3 * 3600_000, false]] as const) {
    it(`balls played just before 00:00 on an idle tab: the hub at ${label} ${sent ? 'sends them first' : 'drops them (the Worker no longer takes the day)'}`, () => {
      const data = dailyData();
      let clock = dayStart(11) - 120_000; // 23:58 JST of day 10
      const api = new FakeApi();
      const r = rig({ store: cleared('1-1', '1-2'), api, data, now: () => clock });
      openTodaysDaily(r, data, clock);
      useBalls(r, 3);
      r.ui.emit('select');
      expect(api.queued).toEqual([]);
      clock = dayStart(11) + tod;
      r.ui.emit('openDaily');
      const q = api.queued.filter((x) => x.board.startsWith('D:00010:'));
      if (sent) {
        expect(q).toHaveLength(1);
        expect(q[0]).toMatchObject({ board: boardOf(data, 10), replay: null, t120: null, tries: 3, balls: 'XXX--' });
        expect(api.flushes).toContain('dailyDone');
      } else {
        expect(q).toEqual([]);
        expect(api.flushes).not.toContain('dailyDone');
      }
      expect(r.store.d.daily).toMatchObject({ dayIndex: 11, balls: [null, null, null, null, null] });
    });
  }

  it('a pagehide after 00:00 still sends the rack of the day before (without opening the hub)', () => {
    const data = dailyData();
    let clock = dayStart(11) - 120_000;
    const api = new FakeApi();
    const r = rig({ store: cleared('1-1', '1-2'), api, data, now: () => clock });
    openTodaysDaily(r, data, clock);
    useBalls(r, 3);
    clock = dayStart(11) + 60_000;
    setVisibility('hidden');
    expect(api.queued.filter((x) => x.board === boardOf(data, 10))).toHaveLength(1);
    expect(api.flushes).toContain('pagehide');
  });

  it('an official ball that ends after 00:00 closes its rack: sent at once, the next start is practice', () => {
    const data = dailyData();
    let clock = dayStart(11) - 60_000;
    const api = new FakeApi();
    const r = rig({ store: cleared('1-1', '1-2'), api, data, now: () => clock });
    openTodaysDaily(r, data, clock);
    useBalls(r, 1);
    clock = dayStart(11) - 5_000;
    r.input.play(BOT_QS);
    expect(until(r, () => r.app.state() === 'RUNNING', 20, 1 / 60)).toBe(true);
    clock = dayStart(11) + 10_000;
    expect(until(r, () => r.app.state() === 'RESULTS', 3000, 1 / 60)).toBe(true);
    expect(api.queued.filter((x) => x.board === boardOf(data, 10))).toMatchObject([{ t120: BOT_SCORE, tries: 2, balls: 'XC---' }]);
    expect(api.flushes).toContain('dailyDone');
    r.ui.emit('retry');
    r.input.qs = null;
    r.input.push(40);
    expect(until(r, () => r.app.state() === 'RUNNING')).toBe(true);
    expect(r.app.debugState().mode).toBe('practice');
    expect(r.store.d.daily.balls).toEqual(['fail', 'crown', null, null, null]);
  });

  it('a boot on the next morning sends the unsent rack of the day before, then starts the new day', () => {
    const data = dailyData();
    let clock = dayStart(11) - 120_000;
    const store = cleared('1-1', '1-2');
    const r = rig({ store, api: new FakeApi(), data, now: () => clock });
    openTodaysDaily(r, data, clock);
    useBalls(r, 2);
    r.app.dispose();
    clock = dayStart(11) + 1800_000; // 00:30
    const api = new FakeApi();
    rig({ store, api, data, now: () => clock });
    expect(api.queued).toMatchObject([{ board: boardOf(data, 10), tries: 2, balls: 'XX---' }]);
    expect(api.flushes).toEqual(['dailyDone']);
    expect(store.d.daily).toMatchObject({ dayIndex: 11, balls: [null, null, null, null, null] });
  });
});

describe('a pagehide during the fifth daily ball (client-1, client-4)', () => {
  it("does not report the ball in play, so the day stays 'partial' and the ball's result is sent when it ends", async () => {
    const NOW = dayStart(10) + 3600_000;
    const data = dailyData();
    const pick = pickDaily(data.dailyPool, NOW);
    const key = dailyBoardKey(pick.dayIndex, data.hash(pick.level));
    const server = new FakeServer();
    server.boot = bootRes({ day: pick.dayIndex, daily: { ...bootRes().daily, key } });
    const store = cleared('1-1', '1-2');
    const api = createApi(store, { fetch: server.fetch, net: 'on', protocol: 'https:', session: null, now: () => NOW });
    const r = rig({ store, api, data, now: () => NOW });
    await api.boot(pick.dayIndex);
    await tick();
    openTodaysDaily(r, data, NOW);
    useBalls(r, 4);
    expect(store.d.daily.balls).toEqual(['fail', 'fail', 'fail', 'fail', null]);
    r.input.play(BOT_QS);
    expect(until(r, () => r.app.debugState().ticks >= 40, 3000, 1 / 60)).toBe(true);
    expect(r.app.state()).toBe('RUNNING');
    setVisibility('hidden');
    await tick();
    await tick();
    expect(r.app.state()).toBe('PAUSED');
    const sends = (): NonNullable<ReturnType<FakeServer['submits']>[number]['runs']> =>
      server.submits().flatMap((s) => s.runs).filter((x) => x.board === key);
    expect(sends()).toMatchObject([{ t120: null, tries: 4, balls: 'XXXX-' }]);
    expect(store.d.daily.submitted).toBe('partial');
    setVisibility('visible');
    r.ui.emit('resume');
    expect(until(r, () => r.app.state() === 'RESULTS', 3000, 1 / 60)).toBe(true);
    await tick();
    await tick();
    expect(store.d.daily.balls[4]).toBe('crown');
    // the day's best reaches the server (the device of the best run's replay, not of whatever ran last)
    expect(sends().at(-1)).toMatchObject({ t120: BOT_SCORE, tries: 5, balls: 'XXXXC', prev: null, device: 3 });
    expect(store.d.daily.submitted).toBe('final');
    expect(store.d.outbox).toEqual([]);
  });

  it('a pagehide during the first ball still counts the player (tries 1)', async () => {
    const NOW = dayStart(10) + 3600_000;
    const data = dailyData();
    const pick = pickDaily(data.dailyPool, NOW);
    const key = dailyBoardKey(pick.dayIndex, data.hash(pick.level));
    const server = new FakeServer();
    server.boot = bootRes({ day: pick.dayIndex, daily: { ...bootRes().daily, key } });
    const store = cleared('1-1', '1-2');
    const api = createApi(store, { fetch: server.fetch, net: 'on', protocol: 'https:', session: null, now: () => NOW });
    const r = rig({ store, api, data, now: () => NOW });
    await api.boot(pick.dayIndex);
    openTodaysDaily(r, data, NOW);
    r.input.play(BOT_QS);
    expect(until(r, () => r.app.debugState().ticks >= 40, 3000, 1 / 60)).toBe(true);
    setVisibility('hidden');
    await tick();
    expect(server.submits().flatMap((s) => s.runs).filter((x) => x.board === key)).toMatchObject([{ t120: null, tries: 1, balls: 'X----' }]);
  });
});

describe('the device of a daily send (client-4)', () => {
  it("is the best run's (from its replay header), not the last finished run's", () => {
    const now = dayStart(10) + 3600_000;
    const data = dailyData();
    const api = new FakeApi();
    const r = rig({ store: cleared('1-1', '1-2'), api, data, now: () => now });
    openTodaysDaily(r, data, now);
    r.input.play(BOT_QS); // ball 1: the best, on the keyboard (device 3)
    expect(until(r, () => r.app.state() === 'RESULTS', 3000, 1 / 60)).toBe(true);
    r.input.qs = null;
    r.ui.emit('retry');
    useBalls(r, 3);
    r.input.target(1.5, 1); // ball 5: a slower success by touch (device 1)
    expect(until(r, () => r.app.state() === 'RESULTS', 3000)).toBe(true);
    expect(r.app.debugState().last!.score!).toBeGreaterThan(BOT_SCORE);
    expect(r.store.d.daily.bestSub).toBe(BOT_SCORE);
    expect(api.queued.at(-1)).toMatchObject({ t120: BOT_SCORE, tries: 5, device: 3 });
  });
});

describe('launch before DAILY_EPOCH (client-2): the days before it all have dayIndex 0', () => {
  it('the next JST day gets a fresh rack on its own level, the streak goes on', () => {
    const data = createGameData(); // the bundled pool
    let now = DAILY_EPOCH - 5 * DAY_MS + 3600_000; // e.g. a launch on 2026-09-26
    const store = cleared('1-1', '1-2');
    const api = new FakeApi();
    const r = rig({ store, api, data, now: () => now });
    const p1 = pickDaily(data.dailyPool, now);
    openTodaysDaily(r, data, now);
    useBalls(r, 5);
    expect(store.d.daily.balls.every((b) => b !== null)).toBe(true);
    r.app.dispose();
    now += DAY_MS;
    const p2 = pickDaily(data.dailyPool, now);
    expect([p1.dayIndex, p2.dayIndex]).toEqual([0, 0]);
    expect(p2.level.id).not.toBe(p1.level.id);
    const r2 = rig({ store, api, data, now: () => now });
    r2.ui.emit('openDaily');
    const view = (r2.ui.last as { id: 'daily'; data: { balls: unknown[]; level: { id: string }; streak: number } }).data;
    expect(view.level.id).toBe(p2.level.id);
    expect(view.balls).toEqual([null, null, null, null, null]);
    expect(view.streak).toBe(1);
    r2.ui.emit('openLevel', p2.level.id);
    expect(r2.app.debugState().mode).toBe('daily');
    useBalls(r2, 1);
    expect(store.d.daily).toMatchObject({ dayIndex: 0, jstDay: jstDayNumber(now), balls: ['fail', null, null, null, null], streak: 2 });
    // what the first day sent went under its own board key
    expect(api.queued.every((q) => q.board === dailyBoardKey(0, data.hash(p1.level)))).toBe(true);
  });
});

describe('a page open across 00:00 JST (client-5)', () => {
  it("boots again for the new day's hub and shows its top 10", async () => {
    const data = dailyData();
    let now = dayStart(11) - 60_000;
    const server = new FakeServer();
    server.handler = (c) => {
      const m = /^\/api\/boot\?day=(\d+)$/.exec(c.url);
      if (!m) return undefined;
      const day = Number(m[1]);
      const key = dailyBoardKey(day, data.hash(pickDaily(data.dailyPool, dayStartMs(day)).level));
      return { status: 200, body: bootRes({ day, daily: { ...bootRes().daily, key, top: [['a1b2c3d4e5f60718', day, 250, 5000, 1, 1]] } }) };
    };
    const store = cleared('1-1', '1-2');
    const api = createApi(store, { fetch: server.fetch, net: 'on', protocol: 'https:', session: null, now: () => now });
    const r = rig({ store, api, data, now: () => now });
    await tick();
    await tick();
    r.ui.emit('openDaily');
    type Hub = { id: 'daily'; data: { dayIndex: number; top: unknown[] | null } };
    expect((r.ui.last as Hub).data).toMatchObject({ dayIndex: 10, top: [['a1b2c3d4e5f60718', 10, 250, 5000, 1, 1]] });
    now = dayStart(11) + 60_000;
    r.ui.emit('select');
    r.ui.emit('openDaily');
    expect((r.ui.last as Hub).data).toMatchObject({ dayIndex: 11, top: null });
    await tick();
    await tick();
    expect(server.paths()).toContain('GET /api/boot?day=11');
    expect(r.app.state()).toBe('DAILY_HUB');
    expect((r.ui.last as Hub).data).toMatchObject({ dayIndex: 11, top: [['a1b2c3d4e5f60718', 11, 250, 5000, 1, 1]] });
    // asked once per day: opening the hub again does not boot again
    const boots = server.paths().filter((p) => p.includes('/api/boot')).length;
    r.ui.emit('select');
    r.ui.emit('openDaily');
    await tick();
    expect(server.paths().filter((p) => p.includes('/api/boot')).length).toBe(boots);
  });
});

describe('a challenge link recorded under another simulation version (sim-2)', () => {
  it('opens the level without the ghost and says the link is old', () => {
    const bot = botFile as { replay: string };
    const { h, qs } = decodeReplay(b64urlDecode(bot.replay));
    const r1 = rig({ store: cleared('1-1'), api: null, data: data0, now: () => dayStart(10), location: { hash: `#c=1-1.${bot.replay}`, protocol: 'https:', origin: 'https://y.example' } });
    expect(r1.app.debugState().ghosts).toContain('challenge');
    const other = b64urlEncode(encodeReplay({ ...h, sim: SIM_VERSION + 1 }, qs));
    const r2 = rig({ store: cleared('1-1'), api: null, data: data0, now: () => dayStart(10), location: { hash: `#c=1-1.${other}`, protocol: 'https:', origin: 'https://y.example' } });
    expect(r2.app.debugState()).toMatchObject({ state: 'READY', level: '1-1' });
    expect(r2.app.debugState().ghosts).not.toContain('challenge');
    expect(r2.ui.toasts.map((x) => x.text)).toContain(t('toast.challengeStale'));
  });
});

describe('a link pasted into the open page (client-6)', () => {
  it('a hash change opens the #l= level, a broken #c= goes to the level select; nothing after dispose', () => {
    const loc = { hash: '', protocol: 'https:', origin: 'https://y.example' };
    const store = cleared('1-1');
    const r = rig({ store, api: null, data: data0, now: () => dayStart(10), location: loc });
    expect(r.app.state()).toBe('TITLE');
    loc.hash = '#l=1-3';
    window.dispatchEvent(new Event('hashchange'));
    expect(r.app.debugState()).toMatchObject({ state: 'READY', level: '1-3' });
    loc.hash = '#c=2-2.BROKEN';
    window.dispatchEvent(new Event('hashchange'));
    expect(r.app.state()).toBe('LEVEL_SELECT');
    expect(r.ui.toasts.at(-1)!.text).toBe(t('toast.challengeBad'));
    loc.hash = '';
    window.dispatchEvent(new Event('hashchange'));
    expect(r.app.state()).toBe('LEVEL_SELECT');
    r.app.dispose();
    loc.hash = '#l=1-2';
    window.dispatchEvent(new Event('hashchange'));
    expect(r.app.state()).toBe('LEVEL_SELECT');
  });
});
