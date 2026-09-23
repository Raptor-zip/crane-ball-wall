// Client <-> sim <-> Worker contract (GAME_DESIGN.md §4.6, §7.7, §7.8, §7.9). Owner: O8.
// The client's wire output is fed to the Worker's own request parser and verifier (with the real src/sim),
// so a drift between src/net and worker/ fails here instead of silently as 400s / mismatches in production.
// worker/ is imported dynamically: its files use workerd types that the app tsconfig does not load.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApi, type NetApi } from '../../src/net/api';
import {
  BATCH_MAX_BYTES, REPLAY_MAX_CHARS, enqueueRun, isSendable, levelPendingRun, nTicksForScore, takeBatch, type PendingRun,
} from '../../src/net/outbox';
import { createStore, type LocalStore } from '../../src/store/save';
import { SUBMIT_MAX_BYTES, levelBoardKey, type SubmitRequest, type SubmitResult, type SubmitRun } from '../../src/shared/api';
import { decodeReplay, simulateReplay } from '../../src/sim/replay';
import { b64urlDecode, b64urlEncode } from '../../src/sim/b64';
import { Status } from '../../src/sim/run';
import { RANKED_MAX_TICKS } from '../../src/sim/constants';
import type { LevelPhysics } from '../../src/sim/level';
import { MemStorage } from '../store/helpers';
import botJson from '../fixtures/bot_1-1_success.json';
import { D, bootRes } from './fakeServer';

// ---- the Worker functions under contract (structural types; see the header comment) ----
interface Target { kind: 'L' | 'D'; key: string; levelId: string; phys: LevelPhysics; hash: string; par: number }
interface WorkerSubmit { parseRequest(text: string): { secret: string; nameSeed: number; runs: SubmitRun[] } | null }
interface WorkerVerify {
  resolveBoard(run: SubmitRun, now: number): Promise<{ ok: true; target: Target } | { ok: false; reason: string }>;
  decodeRun(replay: string, t: Target): { ok: true; qs: Int8Array; nTicks: number } | { ok: false; reason: string };
  simulateRun(t: Target, qs: Int8Array, claimed: number): { ok: true; t120: number } | { ok: false; reason: string };
  levelTarget(id: string): Target | undefined;
}
const SUBMIT_MODULE = '../../worker/routes/submit';
const VERIFY_MODULE = '../../worker/verify';
let W: WorkerSubmit;
let V: WorkerVerify;
beforeAll(async () => {
  W = (await import(/* @vite-ignore */ SUBMIT_MODULE)) as WorkerSubmit;
  V = (await import(/* @vite-ignore */ VERIFY_MODULE)) as WorkerVerify;
});

interface BotFixture { levelId: string; levelHash: string; replay: string; physics: LevelPhysics }
const bot = botJson as unknown as BotFixture;

/** A /api/submit that runs the Worker's steps 1-5 (shape, board, replay, re-simulation) and accepts what passes. */
function workerFetch(log: { status: number; results: SubmitResult[] }[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const reply = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.startsWith('/api/boot')) {
      const b = bootRes();
      const t = V.levelTarget('1-1')!;
      b.boards = { '1-1': { key: t.key, n: 0, aiBeaten: 0, par: t.par, cutoff: null, top: [], wr: null } };
      return reply(200, b);
    }
    const text = String(init?.body ?? '');
    if (new TextEncoder().encode(text).length > SUBMIT_MAX_BYTES) {
      log.push({ status: 413, results: [] });
      return reply(413, { error: 'tooLarge' });
    }
    const req = W.parseRequest(text);
    if (!req) {
      log.push({ status: 400, results: [] });
      return reply(400, { error: 'badRequest' });
    }
    const results: SubmitResult[] = [];
    for (const run of req.runs) {
      const res = await V.resolveBoard(run, Date.now());
      if (!res.ok) {
        results.push({ board: run.board, status: 'rejected', reason: res.reason as never });
        continue;
      }
      if (run.replay === null || run.t120 === null) {
        results.push({ board: run.board, status: 'accepted', rank: null });
        continue;
      }
      const dec = V.decodeRun(run.replay, res.target);
      const sim = dec.ok ? V.simulateRun(res.target, dec.qs, run.t120) : dec;
      results.push(sim.ok
        ? { board: run.board, status: 'accepted', rank: 1, aiBeaten: run.t120 < res.target.par }
        : { board: run.board, status: 'rejected', reason: sim.reason as never });
    }
    log.push({ status: 200, results });
    return reply(200, { ok: true, lite: false, results });
  }) as typeof fetch;
}

const stores: LocalStore[] = [];
let store: LocalStore;
beforeEach(() => {
  store = createStore({ storage: new MemStorage(), listen: false, lang: 'ja' });
  stores.push(store);
});
afterEach(() => {
  while (stores.length) stores.pop()!.dispose();
});

describe('client and sim agree (§4.6)', () => {
  it("the bot's 1-1 clear: nTicks = ceil((score + 59) / 2) equals the replay's own length", () => {
    const { h, qs } = decodeReplay(b64urlDecode(bot.replay));
    const r = simulateReplay(bot.physics, qs);
    expect(r.status).toBe(Status.Success);
    expect(r.score).not.toBeNull();
    expect(nTicksForScore(r.score!)).toBe(h.nTicks);
    expect(qs.length).toBe(h.nTicks);
    expect(nTicksForScore(5341)).toBe(RANKED_MAX_TICKS);   // the longest sendable time is 44.5 s
  });
});

describe('client and Worker agree (§7.7, §7.8)', () => {
  function mkApi(log: { status: number; results: SubmitResult[] }[]): NetApi {
    return createApi(store, { fetch: workerFetch(log), now: () => Date.now(), session: null, protocol: 'https:' });
  }
  function botRun(replay = bot.replay): PendingRun {
    const t = V.levelTarget('1-1')!;
    const { qs } = decodeReplay(b64urlDecode(replay));
    const score = simulateReplay(t.phys, qs).score ?? 1;
    return levelPendingRun(levelBoardKey('1-1', t.hash), '1-1', replay, score, 0, Date.now());
  }

  it('the bundled 1-1 physics still matches the bot fixture (else the tests below prove nothing)', () => {
    expect(V.levelTarget('1-1')!.hash).toBe(bot.levelHash);
  });

  it("a real level PB passes the Worker's parser, board check, replay decoder and re-simulation", async () => {
    const log: { status: number; results: SubmitResult[] }[] = [];
    const api = mkApi(log);
    await api.boot(23);
    api.enqueue(botRun());
    expect(store.data().outbox).toHaveLength(1);
    const res = await api.flush('menu');
    expect(log).toEqual([{ status: 200, results: [expect.objectContaining({ status: 'accepted' })] }]);
    expect(res?.results[0]?.status).toBe('accepted');
    expect(store.data().outbox).toEqual([]);
  });

  it('a tampered replay (one q changed) is a Worker mismatch; the client drops it and stays online', async () => {
    const bytes = b64urlDecode(bot.replay);
    const { h, qs } = decodeReplay(bytes);
    const q2 = qs.slice();
    q2[20] = q2[20] === 127 ? 126 : 127;
    const { encodeReplay } = await import('../../src/sim/replay');
    const tampered = b64urlEncode(encodeReplay(h, q2));
    const run = { ...botRun(), replay: tampered };   // claims the original score
    const log: { status: number; results: SubmitResult[] }[] = [];
    const api = mkApi(log);
    await api.boot(23);
    api.enqueue(run);
    await api.flush('menu');
    expect(log[0]!.results[0]).toMatchObject({ status: 'rejected', reason: 'mismatch' });
    expect(store.data().outbox).toEqual([]);
    expect(api.enabled).toBe(true);
  });

  it('whatever the outbox holds, every batch the client builds is a request the Worker parses (never a 400 / 413)', () => {
    // Random runs, many of them malformed (as an old or hand-edited save could hold), pushed through the
    // same path as the save and enqueue(); valid values are drawn more often so most rounds make a batch.
    let seed = 12345;
    const rnd = (): number => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    const b64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const rep = (n: number): string => Array.from({ length: n }, (_, i) => b64[(i * 37 + n) & 63]).join('');
    const replays = [rep(1), rep(17), rep(400), rep(2000), rep(REPLAY_MAX_CHARS), rep(REPLAY_MAX_CHARS + 1), 'has:colon', 'a+b/'];
    const good = ['1-1', '2-2', '3-4', '5-9', '4-1', '2-7'];
    let checked = 0;
    let full = 0;
    for (let round = 0; round < 300; round++) {
      let outbox: PendingRun[] = [];
      for (let i = 0; i < 12; i++) {
        const daily = rnd() < 0.3;
        const level = rnd() < 0.8 ? pick(good) : pick(['9-9', 'x', '', 'd:17', 'a-very-long-level-id']);
        const board = daily
          ? (rnd() < 0.8 ? pick([D(23), D(22)]) : pick(['D:23:1c0e77aa:s1', D(23) + 'x'.repeat(60)]))
          : (rnd() < 0.85 ? `L:${level}:9f3a12bc:s1` : pick(['L:2-2:9F3A12BC:s1', `L:${level}:9f3a12bc:s0`, 'nonsense']));
        const withReplay = !daily || rnd() < 0.7;
        const r = {
          board, level: daily ? 'd:17' : level,
          replay: withReplay ? pick(replays) : null,
          t120: withReplay ? (rnd() < 0.8 ? 1 + Math.floor(rnd() * 5000) : pick([0, -5, 1.5, 2e6])) : null,
          device: rnd() < 0.8 ? pick([0, 1, 5]) : pick([6, -1, 2.5]),
          nTicks: rnd() < 0.8 ? pick([1, 300, 2700]) : pick([2701, 0]),
          queuedAt: Math.floor(rnd() * 1000),
          ...(daily ? {
            tries: pick([1, 5, 0, 6, undefined]),
            balls: pick(['XO---', 'XOGCX', 'XOXOXO', 'abcde', undefined]),
            ...(rnd() < 0.5 ? { prev: pick([null, 455, -1, 3.5]) } : {}),
          } : {}),
        } as PendingRun;
        outbox = enqueueRun(outbox, r);
      }
      for (const r of outbox) expect(isSendable(r)).toBe(true);
      // Drain the outbox batch by batch, like successive flushes.
      for (;;) {
        const batch = takeBatch(outbox);
        if (batch.length === 0) break;
        const body: SubmitRequest = { v: 1, secret: store.data().id.secret, nameSeed: 65535, runs: batch };
        const text = JSON.stringify(body);
        expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(BATCH_MAX_BYTES);
        expect(W.parseRequest(text)).not.toBeNull();
        if (batch.length === 4) full++;
        checked++;
        const sent = new Set(batch.map((x) => x.board));
        outbox = outbox.filter((x) => !sent.has(x.board));
      }
      expect(outbox).toEqual([]);   // nothing that passed isSendable is stuck forever
    }
    expect(checked).toBeGreaterThan(300);   // 435 with this seed
    expect(full).toBeGreaterThan(5);        // 4-run batches: 15 with this seed
  });
});
