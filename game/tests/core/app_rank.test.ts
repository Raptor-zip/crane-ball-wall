// @vitest-environment happy-dom
// Stage 2 in the state machine: the results card's rank row (Standing), the rank-in send, rank news toasts, the stored
// best on a non-PB clear and the boot reconcile (GAME_DESIGN.md §7.9, §9.4). Real app / sim / data, FakeApi. Owner: O3.
import { describe, expect, it } from 'vitest';
import { createApp, type App, type AppDeps } from '../../src/core/app';
import { createGameData } from '../../src/core/data';
import { createSession } from '../../src/core/session';
import { emptyProgress, progressHash } from '../../src/core/progress';
import { servoQ } from '../../src/input/servo';
import { Status } from '../../src/sim/run';
import type { LevelDef } from '../../src/sim/level';
import { decodeReplay, simulateReplay } from '../../src/sim/replay';
import { b64urlDecode } from '../../src/sim/b64';
import { DAILY_EPOCH, DAY_MS } from '../../src/shared/daily';
import { levelBoardKey, type BootBoard, type BootResponse, type SubmitResponse, type SubmitResult } from '../../src/shared/api';
import { LEVEL_HIST_BINS, levelBin, trimHist } from '../../src/shared/rank';
import type { PendingRun } from '../../src/net/outbox';
import type { ResultsData, Screen } from '../../src/ui/ui';
import { FakeApi, FakeInput, FakeRenderer, FakeUI, MemStore } from './fakes';

const data = createGameData();
const L = (id: string): LevelDef => data.level(id)!;
const keyOf = (id: string): string => levelBoardKey(id, data.hash(L(id)));
const K11 = keyOf('1-1');

/** A 1-1 success replay: servo straight to the pad, then wait. */
const REPLAY = ((): string => {
  const lv = L('1-1');
  const s = createSession(lv);
  const frame = { intent: { kind: 'target' as const, x: 1.5 }, fine: false, device: 1, targetX: 1.5 };
  for (let i = 0; i < 3600; i++) {
    if (s.tick(servoQ(frame, s.run.s, lv.physics, false), frame) !== Status.Running && s.started) break;
  }
  return s.replay()!;
})();
const SCORE = simulateReplay(L('1-1').physics, decodeReplay(b64urlDecode(REPLAY)).qs).score!;
const HEADER = decodeReplay(b64urlDecode(REPLAY)).h;

function bootWith(boards: Record<string, Partial<BootBoard>>, over: Partial<BootResponse> = {}): BootResponse {
  const out: BootResponse['boards'] = {};
  for (const [id, b] of Object.entries(boards)) {
    out[id] = { key: keyOf(id), n: 0, aiBeaten: 0, par: data.parSub(L(id)), cutoff: null, top: [], wr: null, ...b };
  }
  return {
    v: 1, sim: 1, now: 0, day: 10, lite: false, readOnly: false, boards: out,
    daily: { key: '', n: 0, cleared: 0, aiBeaten: 0, par: 0, top: [], hist: [], wr: null }, ...over,
  };
}

/** 1-1 with 300 counted players: 10 boot rows far faster than SCORE, the 100th at SCORE - 40, 200 more around SCORE. */
function crowd11(): Partial<BootBoard> {
  const h = new Array<number>(LEVEL_HIST_BINS).fill(0);
  const top: BootBoard['top'] = Array.from({ length: 10 }, (_, i) => [`c${String(i).padStart(15, '0')}`, 1, 60 + i, -1, 1, 1]);
  for (let i = 0; i < 100; i++) h[levelBin(60 + Math.floor(((SCORE - 100) * i) / 100))]! += 1;
  for (let i = 0; i < 200; i++) h[levelBin(SCORE - 30 + 2 * i)]! += 1;
  return { n: 300, cutoff: SCORE - 40, top, hist: trimHist(h) };
}

interface Rig { app: App; ui: FakeUI; store: MemStore; api: FakeApi; input: FakeInput }

async function rig(api: FakeApi, store = new MemStore()): Promise<Rig> {
  const ui = new FakeUI();
  const input = new FakeInput();
  const deps: Partial<AppDeps> = {
    ui, renderer: new FakeRenderer(), input, store, api, audio: null, haptics: null, data, autoStart: false,
    now: () => DAILY_EPOCH + 10 * DAY_MS + 3600_000,
    location: { hash: '', protocol: 'https:', origin: 'https://y.example' },
    prefersReducedMotion: () => false,
  };
  const app = createApp(document.createElement('div'), deps);
  await ticks();
  return { app, ui, store, api, input };
}

const ticks = async (n = 3): Promise<void> => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};
const card = (r: Rig): ResultsData => (r.ui.screens.filter((s): s is Extract<Screen, { id: 'results' }> => s.id === 'results').at(-1)!).data;
const rankIns = (api: FakeApi): { reason: string; first?: string }[] => api.flushCalls.filter((f) => f.reason === 'rankIn');
const badgeToasts = (r: Rig): string[] => r.ui.toasts.filter((t) => t.kind === 'badge' && !t.text.includes('技')).map((t) => t.text);

/** The answer of the server for the queued run of `board`. */
function answerFor(api: FakeApi, board: string, res: Partial<SubmitResult>): { run: PendingRun; result: SubmitResult } {
  const run = api.queued.filter((q) => q.board === board).at(-1)!;
  return { run, result: { board, status: 'accepted', rank: 37, n: 812, cutoff: 402, was: null, counted: run.t120, ...res } };
}

/** flush('rankIn') answers at once (inside the flush, i.e. while the success beat runs) with `res`. */
function answerAtOnce(api: FakeApi, res: Partial<SubmitResult>): void {
  api.flushReply = (reason, opts) => {
    if (reason !== 'rankIn') return Promise.resolve(null);
    const { run, result } = answerFor(api, opts!.first!, res);
    api.answer([run], [result]);
    return Promise.resolve({ ok: true, lite: false, results: [result] } satisfies SubmitResponse);
  };
}

describe('the rank row (Standing) and the rank-in send (§7.9, §9.4)', () => {
  it('a top-100 candidate PB: exactly one rank-in flush (its board first); an answer in the beat stamps the card', async () => {
    const api = new FakeApi();
    api.bootRes = bootWith({ '1-1': {} });
    answerAtOnce(api, {});
    const r = await rig(api);
    const res = await r.app.playReplay('1-1', REPLAY);
    expect(res.state).toBe('RESULTS');
    expect(rankIns(api)).toEqual([{ reason: 'rankIn', first: K11 }]);
    expect(api.queued.map((q) => [q.board, q.t120])).toEqual([[K11, SCORE]]);
    expect(card(r).standing).toMatchObject({
      runKey: `${K11}:${SCORE}`, forPb: true, phase: 'confirmed', rank: 37, n: 812, exact: true, candidate: true, stamp: 'in', pct: null,
    });
    expect(card(r).rank).toBeNull();                       // the §10.4 field stays as it was
    expect(badgeToasts(r)).toEqual([]);                    // seen on the card: no toast
  });

  it('an answer after the card opened replaces the standing of the same ResultsData (pending -> confirmed)', async () => {
    const api = new FakeApi();
    api.bootRes = bootWith({ '1-1': {} });
    let reply!: (x: SubmitResponse | null) => void;
    api.flushReply = (reason) => (reason === 'rankIn' ? new Promise((ok) => { reply = ok; }) : Promise.resolve(null));
    const r = await rig(api);
    await r.app.playReplay('1-1', REPLAY);
    const data1 = card(r);
    expect(data1.standing).toMatchObject({ phase: 'pending', rank: 1, exact: false, candidate: true, stamp: null });
    const { run, result } = answerFor(api, K11, { rank: 37, was: 45 });
    api.answer([run], [result]);
    reply({ ok: true, lite: false, results: [result] });
    await ticks();
    expect(card(r)).toBe(data1);
    expect(data1.standing).toMatchObject({ phase: 'confirmed', rank: 37, was: 45, exact: true, stamp: 'up' });
    expect(badgeToasts(r)).toEqual([]);
  });

  it('rank 1 -> the world-first stamp; an unranked answer never stamps (and is not exact)', async () => {
    const api = new FakeApi();
    api.bootRes = bootWith({ '1-1': {} });
    answerAtOnce(api, { rank: 1, was: null });
    const r = await rig(api);
    await r.app.playReplay('1-1', REPLAY);
    expect(card(r).standing).toMatchObject({ phase: 'confirmed', rank: 1, stamp: 'wr', exact: true });

    const api2 = new FakeApi();
    api2.bootRes = bootWith({ '1-1': {} });
    answerAtOnce(api2, { status: 'unranked', rank: 342, n: 1065, pct: 32.2, was: 360 });
    const r2 = await rig(api2);
    await r2.app.playReplay('1-1', REPLAY);
    expect(card(r2).standing).toMatchObject({ phase: 'confirmed', rank: 342, n: 1065, pct: 32.2, was: 360, exact: false, candidate: false, stamp: null });
  });

  it('never stamps or calls a rank exact without the server\'s own number (an old server answers accepted without rank)', async () => {
    const api = new FakeApi();
    api.bootRes = bootWith({ '1-1': {} });
    answerAtOnce(api, { rank: undefined, was: undefined, counted: undefined });
    const r = await rig(api);
    await r.app.playReplay('1-1', REPLAY);
    expect(card(r).standing).toMatchObject({ phase: 'confirmed', rank: 1, exact: false, stamp: null });
  });

  it('a PB outside the top 100: no rank-in; a local estimate (>= 101, with 上位 %) from the boot histogram', async () => {
    const api = new FakeApi();
    api.bootRes = bootWith({ '1-1': crowd11() });
    const r = await rig(api);
    await r.app.playReplay('1-1', REPLAY);
    expect(rankIns(api)).toEqual([]);
    const s = card(r).standing!;
    expect(s).toMatchObject({ phase: 'local', candidate: false, exact: false, stamp: null, forPb: true });
    expect(s.rank).toBeGreaterThanOrEqual(101);
    expect(s.n).toBe(301);
    expect(s.pct).toBeGreaterThan(0);
  });

  it('lite or READ_ONLY: a candidate is "held" and nothing is flushed; offline keeps it "queued"', async () => {
    for (const set of [(a: FakeApi) => { a.lite = true; }, (a: FakeApi) => { a.readOnly = true; }]) {
      const api = new FakeApi();
      api.bootRes = bootWith({ '1-1': {} });
      set(api);
      const r = await rig(api);
      await r.app.playReplay('1-1', REPLAY);
      expect(rankIns(api)).toEqual([]);
      expect(card(r).standing).toMatchObject({ phase: 'held', candidate: true });
    }
    const api = new FakeApi();
    api.bootRes = bootWith({ '1-1': {} });
    const r = await rig(api);
    api.enabled = false;
    await r.app.playReplay('1-1', REPLAY);
    expect(rankIns(api)).toEqual([]);
    expect(card(r).standing).toMatchObject({ phase: 'queued' });
  });

  it('a rank-in flush that returns null (nothing could carry it) leaves the card on "queued"', async () => {
    const api = new FakeApi();
    api.bootRes = bootWith({ '1-1': {} });
    const r = await rig(api);                              // flushReply: null
    await r.app.playReplay('1-1', REPLAY);
    await ticks();
    expect(rankIns(api)).toHaveLength(1);
    expect(card(r).standing).toMatchObject({ phase: 'queued' });
  });

  it('no standing (and no rank-in) without a boot board of this key', async () => {
    const api = new FakeApi();
    api.bootRes = bootWith({ '1-2': {} });                 // no 1-1 board in boot
    const r = await rig(api);
    await r.app.playReplay('1-1', REPLAY);
    expect(card(r).standing).toBeNull();
    expect(rankIns(api)).toEqual([]);
  });
});

describe('rank news (§7.9: a stamp nobody saw on a card becomes a toast later)', () => {
  it('an answer while RUNNING again: no toast then, one toast on the next select; newer news replaces older', async () => {
    const api = new FakeApi();
    api.bootRes = bootWith({ '1-1': {} });
    api.flushReply = (reason) => (reason === 'rankIn' ? new Promise(() => {}) : Promise.resolve(null));
    const r = await rig(api);
    await r.app.playReplay('1-1', REPLAY);
    r.input.command('retry');
    r.input.target(1.2);
    for (let i = 0; i < 20 && r.app.state() !== 'RUNNING'; i++) r.app.advance(1 / 60);
    expect(r.app.state()).toBe('RUNNING');
    const { run, result } = answerFor(api, K11, { rank: 37 });
    api.answer([run], [result]);
    // an older run of the same board answered later (e.g. a resend): the newest news wins
    const older = { ...run, t120: SCORE + 50 };
    api.answer([older], [{ ...result, rank: 20, was: 37 }]);
    expect(badgeToasts(r)).toEqual([]);
    r.ui.emit('select');
    expect(badgeToasts(r)).toEqual(['1-1 20位にランクアップ']);
    r.ui.emit('openDaily');
    r.ui.emit('select');
    expect(badgeToasts(r)).toHaveLength(1);                 // toasted once
  });

  it('news of another board shows on the next results card; a card that shows its own answer is not toasted twice', async () => {
    const api = new FakeApi();
    api.bootRes = bootWith({ '1-1': {} });
    const r = await rig(api);
    const other = keyOf('1-2');
    api.answer([{ board: other, level: '1-2', replay: 'x', t120: 300, device: 1, nTicks: 180, queuedAt: 0 }],
      [{ board: other, status: 'accepted', rank: 1, was: 3, n: 50, cutoff: null, counted: 300 }]);
    answerAtOnce(api, {});
    await r.app.playReplay('1-1', REPLAY);
    expect(card(r).standing).toMatchObject({ stamp: 'in' });
    expect(badgeToasts(r)).toEqual(['1-2 世界一！']);
  });

  it('an answer that lands on the level select (the player left the card first) is toasted at once', async () => {
    const api = new FakeApi();
    api.bootRes = bootWith({ '1-1': {} });
    api.flushReply = (reason) => (reason === 'rankIn' ? new Promise(() => {}) : Promise.resolve(null));
    const r = await rig(api);
    await r.app.playReplay('1-1', REPLAY);
    r.ui.emit('select');
    expect(r.app.state()).toBe('LEVEL_SELECT');
    const { run, result } = answerFor(api, K11, { rank: 37 });
    api.answer([run], [result]);
    expect(badgeToasts(r)).toEqual(['1-1 ランクイン！ 37位']);
    r.ui.emit('openDaily');
    expect(badgeToasts(r)).toHaveLength(1);
  });
});

describe('what a clear sends (§7.9)', () => {
  it('a non-PB clear of a player the server does not count yet enqueues the stored best (its time, replay and device)', async () => {
    const store = new MemStore();
    const best = SCORE - 10;
    store.d.levels['1-1'] = { ...emptyProgress(progressHash(data.hash(L('1-1')))), cleared: true, bestSub: best, bestReplay: REPLAY };
    const api = new FakeApi();
    api.bootRes = bootWith({ '1-1': {} });
    const r = await rig(api, store);
    api.queued.length = 0;                                // (the boot reconcile queued it too)
    await r.app.playReplay('1-1', REPLAY);
    expect(api.queued).toEqual([
      { board: K11, level: '1-1', replay: REPLAY, t120: best, device: HEADER.device, nTicks: HEADER.nTicks, queuedAt: expect.any(Number) },
    ]);
    expect(rankIns(api)).toEqual([]);
    expect(card(r).standing).toMatchObject({ forPb: false, phase: 'local', runKey: `${K11}:${best}` });
    // counted already: a slower clear sends nothing
    store.d.levels['1-1']!.sentSub = best;
    api.queued.length = 0;
    r.input.command('retry');
    await r.app.playReplay('1-1', REPLAY);
    expect(api.queued).toEqual([]);
  });

  it('boot reconcile: only uncounted bests, bests in another bin, and unsent AI-beaten ones; once per session', async () => {
    const mk = (id: string, best: number, p: Partial<ReturnType<typeof emptyProgress>> = {}): [string, ReturnType<typeof emptyProgress>] =>
      [id, { ...emptyProgress(progressHash(data.hash(L(id)))), cleared: true, bestSub: best, bestReplay: REPLAY, ...p }];
    const levels = (): MemStore['d']['levels'] => Object.fromEntries([
      mk('1-1', 400),                                                     // not counted yet
      mk('1-2', 300, { sentSub: 330, aiBeatenSent: true }),               // bins 50 vs 55: moves
      mk('1-3', 400, { sentSub: 401, aiBeatenSent: true }),               // same bin: nothing to do
      mk('1-4', 200, { sentSub: 202, aiBeatenSent: false }),              // below par 257, not reported
      mk('2-1', 400, { hash: 'stale' }),                                  // another board
      mk('2-2', 400),                                                     // no boot board
    ]);
    const boards = { '1-1': {}, '1-2': {}, '1-3': {}, '1-4': {}, '2-1': {} };
    const run = async (set?: (a: FakeApi) => void): Promise<Rig> => {
      const store = new MemStore();
      store.d.levels = levels();
      const api = new FakeApi();
      api.bootRes = bootWith(boards);
      set?.(api);
      return rig(api, store);
    };
    const r = await run();
    expect(r.api.queued.map((q) => [q.level, q.t120, q.replay === REPLAY, q.device])).toEqual([
      ['1-1', 400, true, HEADER.device], ['1-2', 300, true, HEADER.device], ['1-4', 200, true, HEADER.device],
    ]);
    expect(r.api.flushes).toEqual([]);                     // nothing is sent by the reconcile itself
    r.api.queued.length = 0;
    r.ui.emit('select');
    r.ui.emit('openDaily');
    r.ui.emit('select');
    expect(r.api.queued).toEqual([]);
    for (const set of [(a: FakeApi) => { a.soft = true; }, (a: FakeApi) => { a.lite = true; }, (a: FakeApi) => { a.readOnly = true; }]) {
      expect((await run(set)).api.queued).toEqual([]);
    }
  });
});
