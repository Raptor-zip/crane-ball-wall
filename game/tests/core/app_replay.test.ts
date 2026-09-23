// @vitest-environment happy-dom
// The ranking's replay viewer in the state machine (GAME_DESIGN.md §7.5 item 6, §7.6, §9.4): which rows can be watched,
// where a replay comes from (boot WR, my best, one /api/ghost request), the client's verification with the Worker's
// simulateReplay and acceptance rule, the viewer on top of the results card, and 「このゴーストと勝負」. Real app / sim /
// data, FakeApi. Owner: O3.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, REPLAY_CACHE_MAX, type App, type AppDeps } from '../../src/core/app';
import { bundledSources, createGameData, type GameData } from '../../src/core/data';
import { createSession } from '../../src/core/session';
import { servoQ } from '../../src/input/servo';
import { Status } from '../../src/sim/run';
import type { DailyDef, LevelDef } from '../../src/sim/level';
import { decodeReplay, encodeReplay, simulateReplay } from '../../src/sim/replay';
import { b64urlDecode, b64urlEncode } from '../../src/sim/b64';
import { HOLD_SUB } from '../../src/sim/constants';
import { dailyBoardKey, levelBoardKey, type BootBoard, type BootResponse, type BoardRow, type GhostResponse } from '../../src/shared/api';
import { DAILY_EPOCH, DAY_MS, pickDaily } from '../../src/shared/daily';
import { displayName } from '../../src/shared/names';
import type { ReplayLoad, UiContext } from '../../src/ui/context';
import type { Screen } from '../../src/ui/ui';
import { FakeApi, FakeInput, FakeRenderer, FakeUI, MemStore } from './fakes';
import botFile from '../fixtures/bot_1-1_success.json';

const data = createGameData();
const L = (id: string): LevelDef => data.level(id)!;
const K11 = levelBoardKey('1-1', data.hash(L('1-1')));
const BOT = botFile as unknown as { replay: string; score: number; stateHash: number; nTicks: number; levelHash: string };

/** A 1-1 success replay: servo straight to x, then wait (a different x gives a different time). */
function servoReplay(level: LevelDef, x: number): string {
  const s = createSession(level);
  const frame = { intent: { kind: 'target' as const, x }, fine: false, device: 1, targetX: x };
  for (let i = 0; i < 3600; i++) {
    if (s.tick(servoQ(frame, s.run.s, level.physics, false), frame) !== Status.Running && s.started) break;
  }
  return s.replay()!;
}
const scoreOf = (level: LevelDef, b64: string): number => simulateReplay(level.physics, decodeReplay(b64urlDecode(b64)).qs).score!;
const hashOf = (level: LevelDef, b64: string): number => simulateReplay(level.physics, decodeReplay(b64urlDecode(b64)).qs).stateHash;

const MINE = servoReplay(L('1-1'), 1.7);          // my run: the slowest
const R2 = servoReplay(L('1-1'), 1.3);
const R3 = servoReplay(L('1-1'), 1.4);
const S_MINE = scoreOf(L('1-1'), MINE);
const S2 = scoreOf(L('1-1'), R2);
const S3 = scoreOf(L('1-1'), R3);
const P1 = 'a000000000000001';
const P2 = 'a000000000000002';
const P3 = 'a000000000000003';

/** The 1-1 board: #1 the bot (its replay is boot's wr), #2 / #3 two servo runs, then me. */
function top11(me: string): BoardRow[] {
  const rows: BoardRow[] = [[P1, 11, BOT.score, -1, 1, 1], [P2, 22, S2, -1, 1, 1], [P3, 33, S3, -1, 1, 1], [me, 44, S_MINE, -1, 1, 1]];
  return rows.sort((a, b) => a[2] - b[2]);
}

function bootWith(boards: Record<string, Partial<BootBoard>>, over: Partial<BootResponse> = {}): BootResponse {
  const out: BootResponse['boards'] = {};
  for (const [id, b] of Object.entries(boards)) {
    out[id] = { key: levelBoardKey(id, data.hash(L(id))), n: 4, aiBeaten: 0, par: data.parSub(L(id)), cutoff: null, top: [], wr: null, ...b };
  }
  return {
    v: 1, sim: 1, now: 0, day: 10, lite: false, readOnly: false, boards: out,
    daily: { key: '', n: 0, cleared: 0, aiBeaten: 0, par: 0, top: [], hist: [], wr: null }, ...over,
  };
}

interface Rig { app: App; ui: FakeUI; store: MemStore; api: FakeApi; input: FakeInput; renderer: FakeRenderer; ctx: UiContext }
const apps: App[] = [];
afterEach(() => {
  while (apps.length) apps.pop()!.dispose();
  vi.restoreAllMocks();
});

async function rig(api: FakeApi, o: { store?: MemStore; data?: GameData; now?: number } = {}): Promise<Rig> {
  const ui = new FakeUI();
  const input = new FakeInput();
  const renderer = new FakeRenderer();
  const store = o.store ?? new MemStore();
  const deps: Partial<AppDeps> = {
    ui, renderer, input, store, api, audio: null, haptics: null, data: o.data ?? data, autoStart: false,
    now: () => o.now ?? DAILY_EPOCH + 10 * DAY_MS + 3600_000,
    location: { hash: '', protocol: 'https:', origin: 'https://y.example' },
    prefersReducedMotion: () => false,
  };
  const app = createApp(document.createElement('div'), deps);
  apps.push(app);
  await ticks();
  return { app, ui, store, api, input, renderer, ctx: ui.ctx! };
}

const ticks = async (n = 3): Promise<void> => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};
/** Frames of real time (the viewer plays at ×0.5). */
function advance(r: Rig, seconds: number, dt = 1 / 30): void {
  for (let t = 0; t < seconds; t += dt) r.app.advance(dt);
}

/** Plays my 1-1 run to the results card and opens the ranking over it, as the results card's button does. */
async function toBoard(api: FakeApi, o: Parameters<typeof rig>[1] = {}): Promise<Rig> {
  const r = await rig(api, o);
  const res = await r.app.playReplay('1-1', MINE);
  expect(res.state).toBe('RESULTS');
  r.ui.emit('board', { level: '1-1' });
  expect(r.ui.last).toEqual({ id: 'board', key: K11 });
  return r;
}

function api11(): FakeApi {
  const api = new FakeApi();
  api.bootRes = bootWith({ '1-1': { top: top11('b000000000000000'), wr: BOT.replay } });
  return api;
}

const idOf = (key: string, pidh: string, t120: number): string => `${key}|${pidh}|${t120}`;
const load = (r: Rig, rank: number, row: BoardRow, key = K11): Promise<ReplayLoad> =>
  r.ctx.loadReplay!({ key, rank, pidh: row[0], nameSeed: row[1], t120: row[2] });

describe('the replay viewer (§7.5 item 6): sources, verification, the viewer over the results card', () => {
  it('the fixtures: the bot replay belongs to this build\'s 1-1 and the runs are ordered', () => {
    expect(data.hash(L('1-1'))).toBe(BOT.levelHash);
    expect(scoreOf(L('1-1'), BOT.replay)).toBe(BOT.score);
    expect(BOT.score % 2).toBe(1);                 // an odd score: the track ends half a substep before the hold does
    expect(new Set([BOT.score, S2, S3, S_MINE]).size).toBe(4);
  });

  it('#1 from the boot WR: ready without a request, re-simulated to the ranked run, played on the real crane', async () => {
    const api = api11();
    const r = await toBoard(api);
    const top = api.bootRes!.boards['1-1']!.top;
    // Opening the ranking asks for nothing; #1 is ready from boot, the others cost a request.
    expect(r.ctx.replayAvail!(K11, 1, top[0]!)).toBe('ready');
    expect(r.ctx.replayAvail!(K11, 2, top[1]!)).toBe('fetch');
    expect(api.ghostCalls).toEqual([]);
    const res = await load(r, 1, top[0]!);
    expect(res).toEqual({ ok: true, id: idOf(K11, P1, BOT.score) });
    expect(api.ghostCalls).toEqual([]);
    const before = r.app.debugState();
    r.ui.emit('replay', { id: idOf(K11, P1, BOT.score) });
    expect(r.app.state()).toBe('DEMO');
    advance(r, 0.05);
    const shown = r.ui.last as Extract<Screen, { id: 'demo' }>;
    expect(shown.id).toBe('demo');
    expect(shown.replay).toMatchObject({ rank: 1, t120: BOT.score, kind: 'wr', mine: false, name: displayName(11, P1, 'ja') });
    expect(shown.replay!.aiF).not.toBeNull();
    expect(shown.replay!.meF).not.toBeNull();                 // my best (the run just played)
    expect(shown.replay!.gapMm).toBeNull();                   // 1-1 has no walls
    const d = r.app.debugState();
    expect(d.replay).toMatchObject({ key: K11, rank: 1, pidh: P1, t120: BOT.score, score: BOT.score, stateHash: BOT.stateHash, source: 'boot', kind: 'wr' });
    // the replay's ghost tag rides on the crane, the AI par ghost races beside it
    expect(d.ghosts).toEqual(['wr', 'ai']);
    // the finished run under the card is untouched
    expect(d.status).toBe(Status.Success);
    expect(d.bestSub).toBe(before.bestSub);
    expect(r.store.d.levels['1-1']!.attempts).toBe(1);
    expect(api.flushes.filter((f) => f === 'menu')).toEqual([]);
  });

  it('holds on the Success frame (odd score: the clock stops on the ranked time), then any input returns to the ranking', async () => {
    const api = api11();
    const r = await toBoard(api);
    const top = api.bootRes!.boards['1-1']!.top;
    await load(r, 1, top[0]!);
    r.ui.emit('replay', { id: idOf(K11, P1, BOT.score) });
    advance(r, 0.6);
    expect(r.renderer.lastFrame!.status).toBe(Status.Running);
    expect(r.renderer.lastFrame!.timeScale).toBe(0.5);        // the trail's strobe runs on sim time
    // ×0.5: 2 s of real time per second of the run; well past its end
    advance(r, 2 * (BOT.score + HOLD_SUB) / 120 + 2);
    expect(r.app.state()).toBe('DEMO');
    expect(r.app.debugState().replay!.t).toBeCloseTo((BOT.score + HOLD_SUB) / 120, 9);
    expect(r.renderer.lastFrame!.status).toBe(Status.Success);   // the hold completes: the trail freezes into the strobe
    expect(r.renderer.lastFrame!.holdFrac).toBe(1);
    expect(r.ui.huds.at(-1)!.timeSub).toBe(BOT.score);
    // the clock never ran on through the hold (and never jumped back)
    const clock = r.ui.huds.filter((h) => h.mode === 'demo').map((h) => h.timeSub);
    expect(Math.max(...clock)).toBe(BOT.score);
    expect(clock.every((v, i) => i === 0 || v >= clock[i - 1]!)).toBe(true);
    r.input.command('any');
    expect(r.app.state()).toBe('RESULTS');
    expect(r.app.debugState().replay).toBeNull();
    expect(r.ui.screens.slice(-2).map((s) => s.id)).toEqual(['results', 'board']);
    expect(r.ui.last).toEqual({ id: 'board', key: K11, focusRank: 1 });
    expect(r.app.debugState().status).toBe(Status.Success);
  });

  it('the skip guard: an input right after the viewer opens does not close it', async () => {
    const api = api11();
    const r = await toBoard(api);
    await load(r, 1, api.bootRes!.boards['1-1']!.top[0]!);
    r.ui.emit('replay', { id: idOf(K11, P1, BOT.score) });
    r.input.command('any');
    expect(r.app.state()).toBe('DEMO');
    advance(r, 0.4);
    r.input.command('retry');
    expect(r.app.state()).toBe('RESULTS');
  });

  it('another row: one /api/ghost request for that row, none the second time; named and timed from the answer', async () => {
    const api = api11();
    const answers: Record<number, GhostResponse> = {
      2: { key: K11, rank: 2, pidh: P2, nameSeed: 22, t120: S2, replay: R2 },
      3: { key: K11, rank: 3, pidh: P3, nameSeed: 33, t120: S3, replay: R3 },
    };
    api.ghostReply = (_key, rank) => Promise.resolve(answers[rank] ?? null);
    const r = await toBoard(api);
    const top = api.bootRes!.boards['1-1']!.top;
    const row3 = top.find((x) => x[0] === P3)!;
    const rank3 = top.indexOf(row3) + 1;
    const res = await load(r, rank3, row3);
    expect(res).toEqual({ ok: true, id: idOf(K11, P3, S3) });
    expect(api.ghostCalls).toEqual([{ key: K11, rank: rank3, opts: { pidh: P3, t120: S3 } }]);
    expect(r.ctx.replayAvail!(K11, rank3, row3)).toBe('ready');
    expect(await load(r, rank3, row3)).toEqual({ ok: true, id: idOf(K11, P3, S3) });
    expect(api.ghostCalls).toHaveLength(1);
    // the board moved: the table said P2 at this rank, the server answers P3's run -> labelled from the answer
    api.ghostReply = () => Promise.resolve({ ...answers[3]!, rank: 2 });
    const row2 = top.find((x) => x[0] === P2)!;
    const moved = await load(r, 2, row2);
    expect(moved).toEqual({ ok: true, id: idOf(K11, P3, S3) });
    r.ui.emit('replay', moved.ok ? { id: moved.id } : null);
    expect(r.app.debugState().replay).toMatchObject({ pidh: P3, t120: S3, score: S3, stateHash: hashOf(L('1-1'), R3), source: 'net', kind: 'rival', rank: 2 });
  });

  it('a replay that does not re-simulate to its ranked time, of another level, or garbage: bad (no state change, one warning)', async () => {
    const api = api11();
    const r = await toBoard(api);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error');
    const cases: GhostResponse[] = [
      { key: K11, rank: 3, pidh: P3, nameSeed: 33, t120: S3 + 2, replay: R3 },                    // a time it does not make
      { key: K11, rank: 3, pidh: P3, nameSeed: 33, t120: S3, replay: servoReplay(L('1-2'), 1.5) }, // another level's
      { key: K11, rank: 3, pidh: P3, nameSeed: 33, t120: S3, replay: 'WVAB-garbage' },
    ];
    // assisted runs are never ranked: the same run with the assist flag
    const dec = decodeReplay(b64urlDecode(R3));
    cases.push({ key: K11, rank: 3, pidh: P3, nameSeed: 33, t120: S3, replay: b64urlEncode(encodeReplay({ ...dec.h, flags: 1 }, dec.qs)) });
    for (const g of cases) {
      api.left = 3;
      api.ghostReply = () => Promise.resolve(g);
      expect(await load(r, 3, [P3, 33, g.t120, -1, 1, 1])).toEqual({ ok: false, reason: 'bad' });
    }
    expect(r.app.state()).toBe('RESULTS');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(err).not.toHaveBeenCalled();
  });

  it('offline / low-quota: #1 from boot still plays, other rows are not watchable; a spent budget keeps the ▶ and says why', async () => {
    const api = api11();
    const r = await toBoard(api);
    const top = api.bootRes!.boards['1-1']!.top;
    api.enabled = false;
    expect(r.ctx.replayAvail!(K11, 1, top[0]!)).toBe('ready');
    expect(r.ctx.replayAvail!(K11, 2, top[1]!)).toBeNull();
    expect(await load(r, 2, top[1]!)).toEqual({ ok: false, reason: 'offline' });
    expect(await load(r, 1, top[0]!)).toMatchObject({ ok: true });
    api.enabled = true;
    api.lite = true;
    expect(r.ctx.replayAvail!(K11, 2, top[1]!)).toBeNull();
    api.lite = false;
    api.left = 0;
    expect(r.ctx.replayAvail!(K11, 2, top[1]!)).toBe('fetch');
    expect(await load(r, 2, top[1]!)).toEqual({ ok: false, reason: 'budget' });
    api.left = 2;
    api.ghostReply = () => Promise.resolve(null);   // 404: gone from the board
    expect(await load(r, 2, top[1]!)).toEqual({ ok: false, reason: 'missing' });
  });

  it('#1 improved since boot (another time at rank 1) or a stale boot WR: a quiet request instead of an error', async () => {
    const api = new FakeApi();
    // boot says P1 is #1 with a time its wr does not make (e.g. an admin purge left an old wr)
    api.bootRes = bootWith({ '1-1': { top: [[P1, 11, BOT.score + 2, -1, 1, 1]], wr: BOT.replay } });
    api.ghostReply = () => Promise.resolve({ key: K11, rank: 1, pidh: P1, nameSeed: 11, t120: BOT.score, replay: BOT.replay });
    const r = await toBoard(api);
    const err = vi.spyOn(console, 'error');
    const warn = vi.spyOn(console, 'warn');
    const row = api.bootRes.boards['1-1']!.top[0]!;
    expect(r.ctx.replayAvail!(K11, 1, row)).toBe('fetch');
    // the full list has #1's current time: boot's wr is not that run -> one request, labelled from the answer
    const res = await load(r, 1, [P1, 11, BOT.score, -1, 1, 1]);
    expect(res).toEqual({ ok: true, id: idOf(K11, P1, BOT.score) });
    expect(api.ghostCalls).toHaveLength(1);
    expect(err).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('my own row plays my stored best (0 requests) and offers no race', async () => {
    const api = api11();
    const me = new MemStore();
    const r = await toBoard(api, { store: me });
    const pidh = me.d.id.pidh;
    const row: BoardRow = [pidh, me.d.id.nameSeed, S_MINE, -1, 1, 1];
    expect(r.ctx.replayAvail!(K11, 4, row)).toBe('ready');
    const res = await load(r, 4, row);
    expect(res).toEqual({ ok: true, id: idOf(K11, pidh, S_MINE) });
    r.ui.emit('replay', { id: idOf(K11, pidh, S_MINE) });
    expect((r.ui.last as Extract<Screen, { id: 'demo' }>).replay).toMatchObject({ mine: true, meF: null });
    expect(r.app.debugState().replay).toMatchObject({ source: 'local', score: S_MINE });
    r.ui.emit('raceGhost', { id: idOf(K11, pidh, S_MINE) });   // the UI offers none; core ignores it too
    expect(r.app.state()).toBe('DEMO');
    expect(r.app.debugState().picked).toBeNull();
    expect(api.ghostCalls).toEqual([]);
  });

  it('only on the results card of the board\'s own level: another level hash, another state -> not watchable (stale)', async () => {
    const api = api11();
    const r = await toBoard(api);
    const row = api.bootRes!.boards['1-1']!.top[0]!;
    const other = levelBoardKey('1-1', 'deadbeef');
    expect(r.ctx.replayAvail!(other, 1, row)).toBeNull();
    expect(await load(r, 1, row, other)).toEqual({ ok: false, reason: 'stale' });
    expect(r.ctx.replayAvail!(levelBoardKey('1-2', data.hash(L('1-2'))), 1, row)).toBeNull();
    r.input.command('retry');
    expect(r.app.state()).toBe('READY');
    expect(r.ctx.replayAvail!(K11, 1, row)).toBeNull();
    expect(await load(r, 1, row)).toEqual({ ok: false, reason: 'stale' });
    r.ui.emit('replay', { id: idOf(K11, P1, BOT.score) });
    expect(r.app.state()).toBe('READY');
  });

  it('a rank-in answer that arrives while the viewer is open waits for the card (no toast later)', async () => {
    const api = api11();
    const r = await toBoard(api);
    await load(r, 1, api.bootRes!.boards['1-1']!.top[0]!);
    r.ui.emit('replay', { id: idOf(K11, P1, BOT.score) });
    const run = api.queued.filter((q) => q.board === K11).at(-1)!;
    api.answer([run], [{ board: K11, status: 'accepted', rank: 4, n: 5, cutoff: null, was: null, counted: run.t120 }]);
    advance(r, 0.5);
    r.input.command('any');
    expect(r.app.state()).toBe('RESULTS');
    const card = (r.ui.screens.filter((s): s is Extract<Screen, { id: 'results' }> => s.id === 'results').at(-1)!).data;
    expect(card.standing).toMatchObject({ phase: 'confirmed', rank: 4, stamp: 'in' });
    r.ui.emit('select');
    expect(r.ui.toasts.filter((t) => t.kind === 'badge' && !t.text.includes('技'))).toEqual([]);
  });

  it('a rank-in answer during the viewer, then 勝負 (the card never comes back): it is said on the next select', async () => {
    const api = api11();
    const r = await toBoard(api);
    await load(r, 1, api.bootRes!.boards['1-1']!.top[0]!);
    r.ui.emit('replay', { id: idOf(K11, P1, BOT.score) });
    const run = api.queued.filter((q) => q.board === K11).at(-1)!;
    api.answer([run], [{ board: K11, status: 'accepted', rank: 4, n: 5, cutoff: null, was: null, counted: run.t120 }]);
    advance(r, 0.5);
    r.ui.emit('raceGhost', { id: idOf(K11, P1, BOT.score) });
    expect(r.app.state()).toBe('READY');
    r.ui.emit('select');
    expect(r.ui.toasts.filter((t) => t.kind === 'badge' && !t.text.includes('技'))).toEqual([{ text: '1-1 ランクイン！ 4位', kind: 'badge' }]);
  });

  it('a stamp seen on the card before the viewer is not said again after 勝負', async () => {
    const api = api11();
    const r = await toBoard(api);
    const run = api.queued.filter((q) => q.board === K11).at(-1)!;
    api.answer([run], [{ board: K11, status: 'accepted', rank: 4, n: 5, cutoff: null, was: null, counted: run.t120 }]);
    await load(r, 1, api.bootRes!.boards['1-1']!.top[0]!);
    r.ui.emit('replay', { id: idOf(K11, P1, BOT.score) });
    advance(r, 0.5);
    r.ui.emit('raceGhost', { id: idOf(K11, P1, BOT.score) });
    r.ui.emit('select');
    expect(r.ui.toasts.filter((t) => t.kind === 'badge' && !t.text.includes('技'))).toEqual([]);
  });

  it('a link pasted while the viewer is open: the viewer goes with the card (its runs are sent), the next demo is the AI\'s', async () => {
    const api = api11();
    const ui = new FakeUI();
    const loc = { hash: '', protocol: 'https:', origin: 'https://y.example' };
    const app = createApp(document.createElement('div'), {
      ui, renderer: new FakeRenderer(), input: new FakeInput(), store: new MemStore(), api, audio: null, haptics: null, data, autoStart: false,
      now: () => DAILY_EPOCH + 10 * DAY_MS + 3600_000, location: loc, prefersReducedMotion: () => false,
    });
    apps.push(app);
    await ticks();
    expect((await app.playReplay('1-1', MINE)).state).toBe('RESULTS');
    ui.emit('board', { level: '1-1' });
    await ui.ctx!.loadReplay!({ key: K11, rank: 1, pidh: P1, nameSeed: 11, t120: BOT.score });
    ui.emit('replay', { id: idOf(K11, P1, BOT.score) });
    for (let t = 0; t < 0.5; t += 1 / 30) app.advance(1 / 30);
    loc.hash = '#l=1-1';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(app.state()).toBe('READY');
    expect(app.debugState().replay).toBeNull();
    expect(api.flushes).toContain('menu');          // leaving the viewer is leaving the results card
    // the AI demo (results card / pause menu) plays and ends on its own, back to READY
    ui.emit('demo');
    expect(app.state()).toBe('DEMO');
    expect((ui.last as Extract<Screen, { id: 'demo' }>).replay).toBeUndefined();
    for (let t = 0; t < 30; t += 1 / 30) app.advance(1 / 30);
    expect(app.state()).toBe('READY');
    expect(app.debugState().ghosts).not.toContain('wr');
  });

  it('a row the table shows older than the board: the server\'s run at that rank, one request however many taps', async () => {
    const api = api11();
    const r = await toBoard(api);
    const row2 = api.bootRes!.boards['1-1']!.top.find((x) => x[0] === P2)!;
    api.ghostReply = () => Promise.resolve({ key: K11, rank: 2, pidh: P3, nameSeed: 33, t120: S3, replay: R3 });
    for (let i = 0; i < 3; i++) {
      expect(await load(r, 2, row2)).toEqual({ ok: true, id: idOf(K11, P3, S3) });
      expect(r.ctx.replayAvail!(K11, 2, row2)).toBe('ready');
    }
    expect(api.ghostCalls).toHaveLength(1);
    expect(api.left).toBe(2);
  });

  it('#1 (boot) and my row (my best) never cost a request, also after the session cache dropped them', async () => {
    const api = api11();
    const me = new MemStore();
    const r = await toBoard(api, { store: me });
    const top = api.bootRes!.boards['1-1']!.top;
    const mine: BoardRow = [me.d.id.pidh, me.d.id.nameSeed, S_MINE, -1, 1, 1];
    expect(r.ctx.replayAvail!(K11, 1, top[0]!)).toBe('ready');
    expect(r.ctx.replayAvail!(K11, 4, mine)).toBe('ready');
    // more other rows watched than the cache holds
    api.left = 100;
    let i = 0;
    api.ghostReply = () => Promise.resolve({ key: K11, rank: 3, pidh: `c${String(++i).padStart(15, '0')}`, nameSeed: 33, t120: S3, replay: R3 });
    for (let k = 0; k < REPLAY_CACHE_MAX + 2; k++) expect((await load(r, 3, [`x${k}`, 1, S3, -1, 1, 1])).ok).toBe(true);
    const calls = api.ghostCalls.length;
    expect(r.ctx.replayAvail!(K11, 1, top[0]!)).toBe('ready');
    expect(await load(r, 1, top[0]!)).toEqual({ ok: true, id: idOf(K11, P1, BOT.score) });
    expect(await load(r, 4, mine)).toEqual({ ok: true, id: idOf(K11, mine[0], S_MINE) });
    expect(api.ghostCalls).toHaveLength(calls);
    api.enabled = false;
    expect(r.ctx.replayAvail!(K11, 1, top[0]!)).toBe('ready');
  });
});

describe('the rival (§7.6): the record just above my PB', () => {
  async function withPb(answer: (key: string, rank: number) => GhostResponse | null): Promise<Rig> {
    const api = api11();
    api.ghostReply = (key, rank) => Promise.resolve(answer(key, rank));
    const store = new MemStore();
    store.d.levels['1-1'] = {
      hash: data.hash(L('1-1')), cleared: true, skipped: false, attempts: 5, fails: 0, consecutiveCrashes: 0, bestSub: S_MINE, bestReplay: MINE,
      medal: 1, crown: false, badges: [], hintsSeen: 0, briefed: true, demoShown: false, aiBeatenSent: false,
    };
    const r = await rig(api, { store });
    expect((await r.app.playReplay('1-1', MINE)).state).toBe('RESULTS');
    await ticks();
    r.store.d.settings.ghostSet = 3;   // AI + rival
    return r;
  }

  it('asks for the row it picked (a cached answer of an older board at that rank is not it)', async () => {
    const top = top11('b000000000000000').filter((x) => x[0] !== 'b000000000000000');
    const r = await withPb((key, rank) => ({ key, rank, pidh: top[rank - 1]![0], nameSeed: top[rank - 1]![1], t120: top[rank - 1]![2], replay: R3 }));
    expect(r.api.ghostCalls).toEqual([{ key: K11, rank: 3, opts: { pidh: top[2]![0], t120: top[2]![2] } }]);
    expect(r.app.debugState().ghosts).toContain('rival');
  });

  it('an answer that is not faster than my PB is no rival', async () => {
    const r = await withPb((key, rank) => ({ key, rank, pidh: P3, nameSeed: 33, t120: S_MINE + 10, replay: MINE }));
    expect(r.api.ghostCalls).toHaveLength(1);
    expect(r.app.debugState().ghosts).not.toContain('rival');
  });
});

describe('「このゴーストと勝負」 (§7.6)', () => {
  async function racing(set = 0): Promise<Rig> {
    const api = api11();
    api.ghostReply = () => Promise.resolve({ key: K11, rank: 3, pidh: P3, nameSeed: 33, t120: S3, replay: R3 });
    const r = await toBoard(api);
    r.store.d.settings.ghostSet = set as 0;
    const top = api.bootRes!.boards['1-1']!.top;
    const row3 = top.find((x) => x[0] === P3)!;
    const res = await load(r, top.indexOf(row3) + 1, row3);
    expect(res.ok).toBe(true);
    r.ui.emit('replay', res.ok ? { id: res.id } : null);
    advance(r, 1);
    r.ui.emit('raceGhost', res.ok ? { id: res.id } : null);
    return r;
  }

  it('the next attempt races it: READY on the same level, the ghost right after the AI (the split comparison ghost)', async () => {
    const r = await racing();
    expect(r.app.state()).toBe('READY');
    const d = r.app.debugState();
    expect(d.level).toBe('1-1');
    expect(d.ghosts).toEqual(['ai', 'rival', 'pb']);
    expect(d.picked).toEqual({ pidh: P3, kind: 'rival' });
    expect(r.ui.toasts.at(-1)!.text).toBe(`${displayName(33, P3, 'ja')}のゴーストと勝負！`);
    // retries keep it
    r.input.command('retry');
    expect(r.app.debugState().picked).toEqual({ pidh: P3, kind: 'rival' });
    // another level drops it
    r.app.command('openLevel:1-2');
    expect(r.app.debugState().picked).toBeNull();
    expect(r.app.debugState().ghosts).not.toContain('rival');
  });

  it('joins every ghost set like a challenge (なし too) and takes the place of the set\'s ghost of its kind', async () => {
    const r = await racing(4);
    expect(r.app.debugState().ghosts).toEqual(['rival']);
    r.store.d.settings.ghostSet = 3;   // AI + rival: never two rival triangles
    expect(r.app.debugState().ghosts).toEqual(['ai', 'rival']);
    r.store.d.settings.ghostSet = 1;
    expect(r.app.debugState().ghosts).toEqual(['ai', 'rival']);
  });

  it('#1 races as the WR ghost; the AI + WR set does not show the boot WR a second time', async () => {
    const api = api11();
    const r = await toBoard(api);
    r.store.d.settings.ghostSet = 2;
    await load(r, 1, api.bootRes!.boards['1-1']!.top[0]!);
    r.ui.emit('replay', { id: idOf(K11, P1, BOT.score) });
    r.ui.emit('raceGhost', { id: idOf(K11, P1, BOT.score) });
    expect(r.app.state()).toBe('READY');
    expect(r.app.debugState().ghosts).toEqual(['ai', 'wr']);
    expect(r.app.debugState().picked).toEqual({ pidh: P1, kind: 'wr' });
  });
});

describe('the daily board (D key)', () => {
  /** 84 daily entries made from 1-1: the bot's replay is valid on today's daily. */
  function dailyData(): GameData {
    const src = bundledSources();
    const lv = L('1-1');
    const pool: DailyDef[] = Array.from({ length: 84 }, (_, i) => ({
      ...lv, id: `d:${i}`, world: 0, order: i, tier: ((i % 7) + 1) as DailyDef['tier'], template: 'hop', parSub: 300, hints: undefined,
    }));
    return createGameData({ ...src, dailyPool: { format: 1, pool } });
  }

  it('#1 of today\'s daily from boot daily.wr, on the results card of an official ball; 勝負 keeps the rack rules', async () => {
    const dd = dailyData();
    const now = DAILY_EPOCH + 10 * DAY_MS + 3600_000;
    const pick = pickDaily(dd.dailyPool, now);
    const key = dailyBoardKey(pick.dayIndex, dd.hash(pick.level));
    const store = new MemStore();
    store.d.levels['1-2'] = { hash: dd.hash(dd.level('1-2')!), cleared: true, skipped: false, attempts: 1, fails: 0, consecutiveCrashes: 0, bestSub: 900, bestReplay: null, medal: 1, crown: false, badges: [], hintsSeen: 0, briefed: true, demoShown: false, aiBeatenSent: false };
    store.d.levels['1-1'] = { ...store.d.levels['1-2']!, hash: dd.hash(dd.level('1-1')!) };
    const api = new FakeApi();
    api.bootRes = bootWith({}, { daily: { key, n: 2, cleared: 2, aiBeaten: 1, par: 300, top: [[P1, 11, BOT.score, -1, 1, 1]], hist: [], wr: BOT.replay } });
    const r = await rig(api, { store, data: dd, now });
    const res = await r.app.playReplay(pick.level.id, MINE);
    expect(res.state).toBe('RESULTS');
    expect(r.app.debugState().mode).toBe('daily');
    expect(r.store.d.daily.balls.filter((b) => b !== null)).toHaveLength(1);
    r.ui.emit('board');
    expect(r.ui.last).toEqual({ id: 'board', key });
    const row = api.bootRes.daily.top[0]!;
    expect(r.ctx.replayAvail!(key, 1, row)).toBe('ready');
    const got = await load(r, 1, row, key);
    expect(got).toEqual({ ok: true, id: idOf(key, P1, BOT.score) });
    r.ui.emit('replay', { id: idOf(key, P1, BOT.score) });
    expect(r.app.debugState().replay).toMatchObject({ key, source: 'boot', score: BOT.score, stateHash: BOT.stateHash });
    expect(r.store.d.daily.balls.filter((b) => b !== null)).toHaveLength(1);   // watching uses no ball
    r.ui.emit('raceGhost', { id: idOf(key, P1, BOT.score) });
    expect(r.app.state()).toBe('READY');
    expect(r.app.debugState().mode).toBe('daily');                             // an official ball is still left
    expect(r.app.debugState().ghosts).toContain('wr');
    expect(api.ghostCalls).toEqual([]);
  });
});
