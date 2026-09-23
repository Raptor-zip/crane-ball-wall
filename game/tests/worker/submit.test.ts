// POST /api/submit on level boards: verification (§7.8 steps 2-5) and ranking writes (steps 6-7). Owner: O9.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubmitResponse, SubmitResult, SubmitRun } from '../../src/shared/api';
import { ReplayFlag, simulateReplay } from '../../src/sim/replay';
import { BALL_R, SIM_VERSION } from '../../src/sim/constants';
import { levelHash } from '../../src/sim/level';
import { b64urlEncode } from '../../src/sim/b64';
import { jstDate, pendingForTest } from '../../worker/limits';
import { setParOverrideForTest } from '../../worker/verify';
import { runFingerprint } from '../../worker/dup';
import {
  NOW, awayFromMinuteBoundary, boardRow, encode, fakeRows, freshIp, level, levelKey, pidhOf, proxyDb, request, resetAll,
  runRow, seedBoard, submit, successBot, wallBots, type BotRun,
} from './helpers';

const P11 = level('1-1').physics;
const KEY = levelKey('1-1');
let bots: { fast: BotRun; mid: BotRun; slow: BotRun } | null = null;
/** Three 1-1 success runs: t120 483 / 657 / 1050 with the current simulator. */
function b(): { fast: BotRun; mid: BotRun; slow: BotRun } {
  bots ??= { fast: successBot(P11, { moveS: 4.5 }), mid: successBot(P11, { moveS: 6 }), slow: successBot(P11, { moveS: 10 }) };
  return bots;
}
let pair: [BotRun, BotRun] | null = null;
/** Two 1-1 bot runs with different inputs and the same time (a tie that is not a copy). */
function sameTimePair(): [BotRun, BotRun] {
  if (pair) return pair;
  const seen = new Map<number, BotRun>();
  for (let m = 40; m <= 120 && !pair; m++) {
    for (let w = 0; w <= 6 && !pair; w++) {
      const r = successBot(P11, { moveS: m / 20, waitTicks: w });
      const o = seen.get(r.t120);
      if (o && o.replay !== r.replay) pair = [o, r];
      else seen.set(r.t120, r);
    }
  }
  if (!pair) throw new Error('sameTimePair: no tie found');
  return pair;
}
const run11 = (bot: BotRun, over: Partial<SubmitRun> = {}): SubmitRun =>
  ({ board: KEY, level: '1-1', replay: bot.replay, t120: bot.t120, device: 1, ...over });

async function results(res: Response): Promise<SubmitResult[]> {
  expect(res.status).toBe(200);
  return ((await res.json()) as SubmitResponse).results;
}
async function one(i: number, r: SubmitRun, nameSeed?: number): Promise<SubmitResult> {
  return (await results(await submit(request(i, [r], nameSeed))))[0]!;
}

beforeEach(async () => {
  await resetAll();
});

describe('accepted', () => {
  it('re-simulates a bot replay, ranks it and writes boards + runs', async () => {
    setParOverrideForTest({ '1-1': 100 });
    const bot = b().fast;
    const res = await submit(request(1, [run11(bot)]));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({
      ok: true, lite: false,
      results: [{ board: KEY, status: 'accepted', rank: 1, n: 1, cutoff: null, aiBeaten: false }],
    });
    const br = (await boardRow(KEY))!;
    expect(br.ver).toBe(1);
    expect(br.n).toBe(1);
    expect(br.par).toBe(100);
    // -1: no walls on 1-1; the 7th element is the fingerprint of the inputs (worker/dup.ts), never sent to clients
    expect(JSON.parse(br.top)).toEqual([[pidhOf(1), 101, bot.t120, -1, 1, NOW, runFingerprint(bot.qs)]]);
    expect(b64urlEncode(Uint8Array.from(br.wr!))).toBe(bot.replay);
    const rr = (await runRow(KEY, pidhOf(1)))!;
    expect(rr.t120).toBe(bot.t120);
    expect(rr.gap_um).toBeNull();
    expect(rr.peak_cn).toBeGreaterThan(0);
    expect(b64urlEncode(Uint8Array.from(rr.replay!))).toBe(bot.replay);
    expect(pendingForTest().wr).toBeGreaterThanOrEqual(3);
  });

  it('keeps the earlier submission ahead on equal times and counts n once per person', async () => {
    const { fast } = b();
    const [x, y] = sameTimePair();   // two different runs with the same time
    expect(await one(1, run11(x))).toMatchObject({ status: 'accepted', rank: 1, n: 1 });
    expect(await one(2, run11(y))).toMatchObject({ status: 'accepted', rank: 2, n: 2 });
    expect(await one(2, run11(fast))).toMatchObject({ status: 'accepted', rank: 1, n: 2 });
    const top = JSON.parse((await boardRow(KEY))!.top) as unknown[][];
    expect(top.map((r) => r[0])).toEqual([pidhOf(2), pidhOf(1)]);
  });

  it('answers notBetter for a slower run of the same player without writing', async () => {
    const { fast, mid } = b();
    await one(1, run11(fast));
    const ver = (await boardRow(KEY))!.ver;
    expect(await one(1, run11(mid))).toMatchObject({ status: 'notBetter', rank: 1, n: 1 });
    expect((await boardRow(KEY))!.ver).toBe(ver);
    expect((await runRow(KEY, pidhOf(1)))!.t120).toBe(fast.t120);
  });

  it('computes gap_um = round((sqrt(minD2) - r) * 1e6) and peak_cn on a level with walls', async () => {
    const [{ levelId, bot }] = wallBots(1) as [{ levelId: string; bot: BotRun }];
    const key = levelKey(levelId);
    const r = simulateReplay(level(levelId).physics, bot.qs);
    const gapUm = Math.round((Math.sqrt(r.minD2) - BALL_R) * 1e6);
    expect(gapUm).toBeGreaterThan(1000);   // the AI keeps ~20 mm
    expect(await one(1, { board: key, level: levelId, replay: bot.replay, t120: bot.t120, device: 3 })).toMatchObject({ status: 'accepted', rank: 1, n: 1 });
    const rr = (await runRow(key, pidhOf(1)))!;
    expect(rr.gap_um).toBe(gapUm);
    expect(rr.peak_cn).toBe(Math.round(r.peakF * 100));
    expect(JSON.parse((await boardRow(key))!.top)).toEqual([[pidhOf(1), 101, bot.t120, gapUm, 3, NOW, runFingerprint(bot.qs)]]);
  });

  it('marks aiBeaten when the time is below par and counts ai_beaten once per person', async () => {
    setParOverrideForTest({ '1-1': 5000 });
    const { fast, slow } = b();
    expect(await one(1, run11(slow))).toMatchObject({ status: 'accepted', aiBeaten: true });
    expect(await one(1, run11(fast))).toMatchObject({ status: 'accepted', aiBeaten: true });
    expect((await boardRow(KEY))!.ai_beaten).toBe(1);
  });
});

describe('rejected', () => {
  it('mismatch: one q flipped', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bot = b().fast;
    // Flip the first q whose sign change alters the outcome (flips that happen not to change the run are legal).
    let qs = bot.qs;
    for (let k = 1; k < bot.qs.length; k++) {
      if (bot.qs[k] === 0) continue;
      const t = bot.qs.slice();
      t[k] = -t[k]!;
      if (simulateReplay(P11, t).score !== bot.t120) {
        qs = t;
        break;
      }
    }
    expect(qs).not.toBe(bot.qs);
    expect(await one(1, run11(bot, { replay: encode(P11, qs) }))).toEqual({ board: KEY, status: 'rejected', reason: 'mismatch' });
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ evt: 'mismatch', board: KEY, claimed: bot.t120 }));
    expect(await boardRow(KEY)).toBeNull();
    warn.mockRestore();
  });

  it('mismatch: claimed time off by one substep', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bot = b().fast;
    expect(await one(1, run11(bot, { t120: bot.t120 - 1 }))).toMatchObject({ status: 'rejected', reason: 'mismatch' });
    expect(await one(1, run11(bot, { t120: bot.t120 + 1 }))).toMatchObject({ status: 'rejected', reason: 'mismatch' });
    vi.restoreAllMocks();
  });

  it('mismatch: extra ticks after the success tick', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bot = b().fast;
    const qs = Int8Array.from([...bot.qs, 0, 0]);
    expect(await one(1, run11(bot, { replay: encode(P11, qs) }))).toMatchObject({ status: 'rejected', reason: 'mismatch' });
    vi.restoreAllMocks();
  });

  it('stale: old level hash or another sim version', async () => {
    const bot = b().fast;
    expect(await one(1, run11(bot, { board: 'L:1-1:deadbeef:s1' }))).toEqual({ board: 'L:1-1:deadbeef:s1', status: 'rejected', reason: 'stale' });
    const s2 = KEY.replace(/:s1$/, ':s2');
    expect(await one(1, run11(bot, { board: s2 }))).toMatchObject({ status: 'rejected', reason: 'stale' });
  });

  it('badBoard: malformed key, unknown level, level field not matching the key', async () => {
    const bot = b().fast;
    expect(await one(1, run11(bot, { board: 'X:1-1' }))).toMatchObject({ status: 'rejected', reason: 'badBoard' });
    expect(await one(1, run11(bot, { board: 'L:5-9:00000000:s1', level: '5-9' }))).toMatchObject({ status: 'rejected', reason: 'badBoard' });
    expect(await one(1, run11(bot, { level: '1-2' }))).toMatchObject({ status: 'rejected', reason: 'badBoard' });
  });

  it('tooLong: 2701 ticks', async () => {
    const qs = new Int8Array(2701);
    qs[0] = 5;
    expect(await one(1, run11(b().fast, { replay: encode(P11, qs), t120: 5000 }))).toMatchObject({ status: 'rejected', reason: 'tooLong' });
  });

  it('tooLong also for a header claiming more ticks than the 60 s time-up (checked before the full decode)', async () => {
    // Hand-made (encodeReplay refuses > 3600 ticks): header, nTicks = 4000 (varint a0 1f), q = 5, then 3999 x repeat.
    const h = parseInt(levelHash(P11), 16);
    const bytes = [0x59, 0x50, 1, SIM_VERSION, h & 255, (h >>> 8) & 255, (h >>> 16) & 255, h >>> 24, 1, 0, 0xa0, 0x1f, 10];
    let left = 3999;
    while (left >= 2) {
      const reps = Math.min(left, 8000);
      let v = (reps - 2) * 2 + 1;
      while (v >= 128) { bytes.push((v & 127) | 128); v >>>= 7; }
      bytes.push(v);
      left -= reps;
    }
    if (left === 1) bytes.push(0);
    expect(await one(1, run11(b().fast, { replay: b64urlEncode(Uint8Array.from(bytes)), t120: 5000 }))).toMatchObject({ status: 'rejected', reason: 'tooLong' });
    // A truncated header is badReplay.
    expect(await one(1, run11(b().fast, { replay: b64urlEncode(Uint8Array.from(bytes.slice(0, 11))) }))).toMatchObject({ status: 'rejected', reason: 'badReplay' });
  });

  it('badReplay: garbage, flags, first q = 0, other level, null on a level board, oversize', async () => {
    const bot = b().fast;
    const bad = async (over: Partial<SubmitRun>): Promise<void> => {
      expect(await one(1, run11(bot, over))).toMatchObject({ status: 'rejected', reason: 'badReplay' });
    };
    await bad({ replay: 'not-a-replay' });
    await bad({ replay: encode(P11, bot.qs, ReplayFlag.Practice) });
    await bad({ replay: encode(P11, bot.qs, ReplayFlag.Assisted) });
    const z = bot.qs.slice();
    z[0] = 0;
    await bad({ replay: encode(P11, z) });
    await bad({ replay: encode(level('1-2').physics, bot.qs) });
    await bad({ replay: null });
    await bad({ t120: null });
    await bad({ replay: 'A'.repeat(8200) });
    // DirectForce is allowed.
    expect(await one(1, run11(bot, { replay: encode(P11, bot.qs, ReplayFlag.DirectForce) }))).toMatchObject({ status: 'accepted' });
  });
});

describe('top 100', () => {
  it('unranked below the 100th without beating the AI: no writes at all', async () => {
    setParOverrideForTest({ '1-1': 100 });
    await seedBoard(KEY, fakeRows(100, 10));
    const p = proxyDb(env.DB);
    const res = await submit(request(1, [run11(b().fast)]), { env: { DB: p.db } });
    expect((await results(res))[0]).toEqual({ board: KEY, status: 'unranked', rank: null, n: 100, cutoff: 109, aiBeaten: false });
    expect(p.sqls.every((s) => s.startsWith('SELECT'))).toBe(true);
    expect((await boardRow(KEY))!.ver).toBe(0);
    expect(await runRow(KEY, pidhOf(1))).toBeNull();
    expect(pendingForTest().wr).toBe(0);
  });

  it('accepts a first AI-beaten run below the 100th with a NULL replay; a second one is unranked', async () => {
    setParOverrideForTest({ '1-1': 5000 });
    await seedBoard(KEY, fakeRows(100, 10));
    const { fast, slow } = b();
    expect(await one(1, run11(slow))).toEqual({ board: KEY, status: 'accepted', rank: null, n: 101, cutoff: 109, aiBeaten: true });
    const br = (await boardRow(KEY))!;
    expect(br.ai_beaten).toBe(1);
    expect(br.n).toBe(101);
    expect(JSON.parse(br.top)).toHaveLength(100);
    expect(br.wr).toBeNull();
    const rr = (await runRow(KEY, pidhOf(1)))!;
    expect(rr.t120).toBe(slow.t120);
    expect(rr.replay).toBeNull();
    // Already counted as AI-beaten: a better run that still misses the top 100 is unranked and not written.
    expect(await one(1, run11(fast))).toMatchObject({ status: 'unranked', rank: null, aiBeaten: true });
    expect((await boardRow(KEY))!.ai_beaten).toBe(1);
    expect((await runRow(KEY, pidhOf(1)))!.t120).toBe(slow.t120);
  });

  it('sets the replay of the player who falls to rank 101 to NULL', async () => {
    const rows = fakeRows(100, 1100);
    await seedBoard(KEY, rows);
    const bot = b().fast;
    expect(await one(1, run11(bot))).toMatchObject({ status: 'accepted', rank: 1, n: 101, cutoff: 1198 });
    const top = JSON.parse((await boardRow(KEY))!.top) as unknown[][];
    expect(top).toHaveLength(100);
    expect(top[0]![0]).toBe(pidhOf(1));
    expect(top.some((r) => r[0] === rows[99]![0])).toBe(false);
    expect((await runRow(KEY, rows[99]![0]))!.replay).toBeNull();
    expect((await runRow(KEY, rows[98]![0]))!.replay).not.toBeNull();
    expect((await runRow(KEY, rows[99]![0]))!.t120).toBe(rows[99]![2]);   // the row itself stays (n counts people)
  });
});

describe('lite safety valve', () => {
  it('above 80k estimated writes only level runs reaching the top 10 are accepted', async () => {
    await env.DB.prepare('INSERT INTO counters (k, n) VALUES (?, ?)').bind(`wr:${jstDate(NOW)}`, 80_001).run();
    await seedBoard(KEY, fakeRows(10, 10));
    const { fast } = b();
    const res = (await (await submit(request(1, [run11(fast)]))).json()) as SubmitResponse;
    expect(res.lite).toBe(true);
    expect(res.results[0]).toEqual({ board: KEY, status: 'rejected', reason: 'lite' });
    await env.DB.prepare('DELETE FROM runs').run();
    await env.DB.prepare('DELETE FROM boards').run();
    await seedBoard(KEY, fakeRows(9, 10));
    expect(await one(1, run11(fast))).toMatchObject({ status: 'accepted', rank: 10 });
  });

  it('also triggers on estimated requests', async () => {
    await env.DB.prepare('INSERT INTO counters (k, n) VALUES (?, ?)').bind(`req:${jstDate(NOW)}`, 80_001).run();
    await seedBoard(KEY, fakeRows(10, 10));
    expect(await one(1, run11(b().fast))).toMatchObject({ status: 'rejected', reason: 'lite' });
  });
});

describe('request errors', () => {
  const ok = (): SubmitRun => run11(b().fast);
  it('400 for 5 runs, bad JSON, bad secret, bad shapes and duplicate boards', async () => {
    const five = request(1, [0, 1, 2, 3, 4].map((i) => ({ ...ok(), board: `L:1-${i + 1}:00000000:s1` })));
    expect((await submit(five)).status).toBe(400);
    expect((await submit('{nope')).status).toBe(400);
    expect((await submit({ ...request(1, [ok()]), secret: 'short' })).status).toBe(400);
    expect((await submit({ ...request(1, [ok()]), v: 2 })).status).toBe(400);
    expect((await submit({ ...request(1, [ok()]), nameSeed: 70000 })).status).toBe(400);
    expect((await submit(request(1, []))).status).toBe(400);
    expect((await submit(request(1, [{ ...ok(), device: 9 }]))).status).toBe(400);
    expect((await submit(request(1, [{ ...ok(), balls: 'XXXXXX' }]))).status).toBe(400);
    expect((await submit(request(1, [ok(), ok()]))).status).toBe(400);
    const e = (await (await submit('{nope')).json()) as { error: string };
    expect(e.error).toBe('badRequest');
  });

  it('413 above 16 KB', async () => {
    const big = JSON.stringify({ ...request(1, [ok()]), pad: 'x'.repeat(16 * 1024) });
    expect((await submit(big)).status).toBe(413);
  });

  it('405 for GET and 503 READ_ONLY when writes are switched off', async () => {
    expect((await (await import('./helpers')).call('/api/submit')).status).toBe(405);
    const res = await submit(request(1, [ok()]), { env: { READ_ONLY: '1' } });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'READ_ONLY' });
    expect(await boardRow(KEY)).toBeNull();
  });

  it('a D1 failure defers only that run; the runs before it keep their answers and their rows are counted', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const [{ levelId, bot }] = wallBots(1) as [{ levelId: string; bot: BotRun }];
    const wallKey = levelKey(levelId);
    // Batches: run 1 read, run 1 write, then run 2's read fails.
    let batches = 0;
    const p = proxyDb(env.DB, async () => {
      if (++batches === 3) throw new Error('D1_ERROR: simulated');
    });
    const res = await submit(request(1, [run11(b().fast), { board: wallKey, level: levelId, replay: bot.replay, t120: bot.t120, device: 1 }]), { env: { DB: p.db } });
    expect((await results(res)).map((r) => r.status)).toEqual(['accepted', 'deferred']);
    expect((await runRow(KEY, pidhOf(1)))!.t120).toBe(b().fast.t120);
    expect(await boardRow(wallKey)).toBeNull();
    expect(pendingForTest().wr).toBeGreaterThanOrEqual(2);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('submit-d1-error'));
    err.mockRestore();
  });

  it('429 on the 7th submit within a minute from one IP (RL_SUBMIT)', { timeout: 10_000 }, async () => {
    await awayFromMinuteBoundary();
    const ip = freshIp();
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await submit('{}', { ip })).status);
    expect(codes).toEqual([400, 400, 400, 400, 400, 400, 429]);
  });

  it('429 from the in-memory token bucket when the binding is missing', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const ip = freshIp();
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await submit('{}', { ip, env: { RL_SUBMIT: undefined } })).status);
    expect(codes).toEqual([400, 400, 400, 400, 400, 400, 429]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('rl-fallback'));
    log.mockRestore();
  });
});
