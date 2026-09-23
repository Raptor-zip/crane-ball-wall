// POST /api/submit on daily boards (§7.7 prev, §7.8 steps 2 and 7: n / cleared / hist without runs rows). Owner: O9.
import { beforeEach, describe, expect, it } from 'vitest';
import { histBin, type SubmitResponse, type SubmitResult, type SubmitRun } from '../../src/shared/api';
import { DAILY_EPOCH, DAY_MS } from '../../src/shared/daily';
import {
  NOW, boardRow, dailyAt, fakeDailyPool, fakeRows, pidhOf, request, resetAll, runRow, seedBoard, submit, successBot,
  type BotRun, type DailyInfo,
} from './helpers';

const POOL = fakeDailyPool(3000);
let D: DailyInfo;
let bots: { a: BotRun; b: BotRun; c: BotRun } | null = null;
/** Three daily success runs with times in different 0.2 s bins (483 / 657 / 1050 today). */
function bot(): { a: BotRun; b: BotRun; c: BotRun } {
  bots ??= { a: successBot(D.phys, { moveS: 4.5 }), b: successBot(D.phys, { moveS: 6 }), c: successBot(D.phys, { moveS: 10 }) };
  return bots;
}
const drun = (bt: BotRun | null, over: Partial<SubmitRun> = {}, d: DailyInfo = D): SubmitRun => ({
  board: d.key, level: d.levelId, replay: bt ? bt.replay : null, t120: bt ? bt.t120 : null, device: 1, tries: 5, balls: 'XOOCX', ...over,
});
async function one(i: number, r: SubmitRun): Promise<SubmitResult> {
  const res = await submit(request(i, [r]));
  expect(res.status).toBe(200);
  return ((await res.json()) as SubmitResponse).results[0]!;
}
const hist = async (key = D.key): Promise<number[]> => JSON.parse((await boardRow(key))!.hist!) as number[];

beforeEach(async () => {
  await resetAll({ pool: POOL });
  D = dailyAt(POOL, NOW);
});

describe('daily', () => {
  it('uses the Worker clock: today is dayIndex 9 and the key carries the daily level hash', () => {
    expect(D.dayIndex).toBe(9);
    expect(D.key).toMatch(/^D:00009:[0-9a-f]{8}:s1$/);
  });

  it('first success: runs row (top 100), n / cleared / ai_beaten / hist, pct', async () => {
    const { b } = bot();
    const r = await one(1, drun(b));
    expect(r).toEqual({ board: D.key, status: 'accepted', rank: 1, n: 1, pct: 50 });
    const br = (await boardRow(D.key))!;
    expect([br.n, br.cleared, br.ai_beaten, br.par]).toEqual([1, 1, 1, 3000]);
    const h = await hist();
    expect(h).toHaveLength(150);
    expect(h[histBin(b.t120)]).toBe(1);
    expect(h.reduce((x, y) => x + y, 0)).toBe(1);
    const rr = (await runRow(D.key, pidhOf(1)))!;
    expect([rr.t120, rr.tries, rr.balls]).toEqual([b.t120, 5, 'XOOCX']);
  });

  it('a better resend with prev moves the player to the new histogram bin', async () => {
    const { a, b } = bot();
    expect(histBin(a.t120)).not.toBe(histBin(b.t120));
    await one(1, drun(b));
    expect(await one(1, drun(a, { prev: b.t120, balls: 'XOOCC' }))).toMatchObject({ status: 'accepted', rank: 1, n: 1 });
    const h = await hist();
    expect(h[histBin(b.t120)]).toBe(0);
    expect(h[histBin(a.t120)]).toBe(1);
    const br = (await boardRow(D.key))!;
    expect([br.n, br.cleared, br.ai_beaten]).toEqual([1, 1, 1]);
    expect((await runRow(D.key, pidhOf(1)))!.balls).toBe('XOOCC');
  });

  it('outside the top 100: a first send counts in the boards row only; a resend moves the bin and keeps a runs row', async () => {
    const pool = fakeDailyPool(100);   // every bot run is slower than the "AI": the first send writes no runs row
    await resetAll({ pool });
    D = dailyAt(pool, NOW);
    const h0 = new Array<number>(150).fill(0);
    for (const r of fakeRows(100, 10)) h0[histBin(r[2])]! += 1;
    await seedBoard(D.key, fakeRows(100, 10), { n: 100, cleared: 100, hist: h0, par: 100 });
    const { a, c } = bot();
    const r1 = await one(1, drun(c));
    expect(r1.status).toBe('accepted');
    expect(r1.rank).toBeGreaterThanOrEqual(101);
    expect(r1.n).toBe(101);
    expect(r1.pct).toBeGreaterThan(90);
    expect(await runRow(D.key, pidhOf(1))).toBeNull();
    let br = (await boardRow(D.key))!;
    expect([br.n, br.cleared, br.ai_beaten, JSON.parse(br.top).length]).toEqual([101, 101, 0, 100]);
    expect((await hist())[histBin(c.t120)]).toBe(1);
    // A better run later that day, still outside the top 100: prev moves the count to the new bin, and the server keeps
    // a runs row (no replay) so that every later resend is judged against its own record, not the self-reported prev.
    const r2 = await one(1, drun(a, { prev: c.t120 }));
    expect(r2).toMatchObject({ status: 'accepted', n: 101 });
    const rr = (await runRow(D.key, pidhOf(1)))!;
    expect([rr.t120, rr.replay]).toEqual([a.t120, null]);
    br = (await boardRow(D.key))!;
    expect([br.n, br.cleared, JSON.parse(br.top).length]).toEqual([101, 101, 100]);
    const h = await hist();
    expect(h[histBin(c.t120)]).toBe(0);
    expect(h[histBin(a.t120)]).toBe(1);
    // Not better than the record: nothing to do, whatever prev claims.
    expect(await one(1, drun(c, { prev: a.t120 }))).toMatchObject({ status: 'notBetter' });
    expect(await one(1, drun(c, { prev: 5000 }))).toMatchObject({ status: 'notBetter' });
    expect(await hist()).toEqual(h);
  });

  it('participation without success (replay null) only increases n', async () => {
    await one(2, drun(bot().b));
    const before = (await boardRow(D.key))!;
    const r = await one(1, drun(null, { balls: 'XXXXX' }));
    expect(r).toEqual({ board: D.key, status: 'accepted', rank: null, n: 2 });
    const br = (await boardRow(D.key))!;
    expect([br.n, br.cleared, br.ai_beaten, br.top, br.hist]).toEqual([2, before.cleared, before.ai_beaten, before.top, before.hist]);
    expect(await runRow(D.key, pidhOf(1))).toBeNull();
    // Reported again (prev null): nothing new.
    expect(await one(1, drun(null, { prev: null }))).toMatchObject({ status: 'notBetter', n: 2 });
    // Later success after a failed participation: cleared +1, n unchanged.
    expect(await one(1, drun(bot().a, { prev: null }))).toMatchObject({ status: 'accepted', n: 2 });
    expect((await boardRow(D.key))!.cleared).toBe(2);
  });

  it('a slower resend of a top-100 player only updates balls and tries', async () => {
    const { a, b } = bot();
    await one(1, drun(a, { tries: 3, balls: 'OXO--' }));
    expect(await one(1, drun(b, { prev: a.t120, tries: 5, balls: 'OXOXO' }))).toMatchObject({ status: 'notBetter', rank: 1 });
    const rr = (await runRow(D.key, pidhOf(1)))!;
    expect([rr.t120, rr.tries, rr.balls]).toEqual([a.t120, 5, 'OXOXO']);
  });

  it('a level-board null replay is badReplay, a daily t120 without replay too', async () => {
    expect(await one(1, drun(null, { t120: 500 }))).toMatchObject({ status: 'rejected', reason: 'badReplay' });
  });

  it('badBoard for other days (yesterday only until 02:00 JST), stale for a wrong hash of today', async () => {
    const y = dailyAt(POOL, NOW - DAY_MS);
    expect(await one(1, drun(bot().a, {}, y))).toMatchObject({ status: 'rejected', reason: 'badBoard' });
    const old = dailyAt(POOL, NOW - 5 * DAY_MS);
    expect(await one(1, drun(bot().a, {}, old))).toMatchObject({ status: 'rejected', reason: 'badBoard' });
    const wrongHash = D.key.replace(/:[0-9a-f]{8}:/, ':deadbeef:');
    expect(await one(1, drun(bot().a, { board: wrongHash }))).toMatchObject({ status: 'rejected', reason: 'stale' });
    expect(await one(1, drun(bot().a, { level: 'd:83' === D.levelId ? 'd:0' : 'd:83' }))).toMatchObject({ status: 'rejected', reason: 'badBoard' });
  });

  it('00:00-02:00 JST: yesterday is still accepted next to today', async () => {
    const t = DAILY_EPOCH + 10 * DAY_MS + 3600 * 1000;   // 01:00 JST, day 10
    await resetAll({ pool: POOL, now: t });
    const today = dailyAt(POOL, t), y = dailyAt(POOL, t - DAY_MS);
    expect([today.dayIndex, y.dayIndex]).toEqual([10, 9]);
    const res = await submit(request(1, [drun(bot().a, {}, y), drun(bot().b, {}, today)]));
    expect(((await res.json()) as SubmitResponse).results.map((r) => r.status)).toEqual(['accepted', 'accepted']);
    await resetAll({ pool: POOL, now: t + 2 * 3600 * 1000 });   // 03:00 JST
    expect(await one(1, drun(bot().a, {}, y))).toMatchObject({ status: 'rejected', reason: 'badBoard' });
  });

  it('before DAILY_EPOCH every day is #1 (dayIndex 0)', async () => {
    const t = DAILY_EPOCH - 3 * DAY_MS + 12 * 3600 * 1000;
    await resetAll({ pool: POOL, now: t });
    const d = dailyAt(POOL, t);
    expect(d.dayIndex).toBe(0);
    expect(await one(1, drun(bot().a, {}, d))).toMatchObject({ status: 'accepted', rank: 1 });
  });

  it('without a daily pool the daily board is unavailable (badBoard)', async () => {
    await resetAll({ pool: [] });
    expect(await one(1, drun(bot().a))).toMatchObject({ status: 'rejected', reason: 'badBoard' });
  });
});
