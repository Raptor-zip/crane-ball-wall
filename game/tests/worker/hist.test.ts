// The hourly level histogram rebuild (worker/hist.ts, GAME_DESIGN.md §7.7 「面のヒストグラムと順位の推定」) and the cron
// dispatch of worker/index.ts scheduled(). Owner: O9.
import { env } from 'cloudflare:workers';
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { DAILY_EPOCH, DAY_MS } from '../../src/shared/daily';
import { LEVEL_HIST_BINS, levelBin, trimHist } from '../../src/shared/rank';
import worker, { type Env } from '../../worker/index';
import { CRON_DAILY, CRON_HIST } from '../../worker/cron';
import { HIST_MIN_INTERVAL_MS, HIST_NEXT_KEY, LEVEL_BIN_SQL, histIntervalMs, runHistRebuild } from '../../worker/hist';
import { jstDate } from '../../worker/limits';
import { levelTargets } from '../../worker/verify';
import { NOW, boardRow, fakeRows, proxyDb, resetAll, seedBoard, seedPlays } from './helpers';

const KEYS = levelTargets().map((t) => t.key);
const [K1, K2, K3] = [KEYS[0]!, KEYS[1]!, KEYS[5]!];
const STALE = 'L:1-1:deadbeef:s1';
const HOUR = 3_600_000;

function rng(seed: number): () => number {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
}

function histOf(times: readonly number[]): number[] {
  const h = new Array<number>(LEVEL_HIST_BINS).fill(0);
  for (const t of times) h[levelBin(t)]! += 1;
  return h;
}

/** `count` random plays rows over K1, K2, K3 and STALE (10 % without a time). Returns the counted times per board. */
async function randomPlays(count: number, keys = [K1, K2, K3, STALE], seed = 7): Promise<Map<string, number[]>> {
  const r = rng(seed);
  const times = new Map<string, number[]>(keys.map((k) => [k, []]));
  const values: string[] = [];
  for (let i = 0; i < count; i++) {
    const k = keys[Math.floor(r() * keys.length)]!;
    const t = r() < 0.1 ? null : Math.floor(120 + r() * r() * 5400);
    // keys and numbers only: safe as literals (D1 allows 100 bound parameters per statement)
    values.push(`('${k}', 'q${String(i).padStart(15, '0')}', 1, ${t ?? 'NULL'})`);
    if (t !== null) times.get(k)!.push(t);
  }
  for (let i = 0; i < values.length; i += 200) {
    await env.DB.prepare(`INSERT INTO plays (board, pidh, created, t120) VALUES ${values.slice(i, i + 200).join(', ')}`).run();
  }
  return times;
}

async function counter(k: string): Promise<number | null> {
  return (await env.DB.prepare('SELECT n FROM counters WHERE k = ?').bind(k).first<{ n: number }>())?.n ?? null;
}
async function setCounter(k: string, n: number): Promise<void> {
  await env.DB.prepare('INSERT INTO counters (k, n) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET n = excluded.n').bind(k, n).run();
}
const WR = `wr:${jstDate(NOW)}`;
const arm = (): Promise<void> => setCounter(HIST_NEXT_KEY, 0);

/** The stored level hist of a board as the rebuild writes it. */
const stored = (times: readonly number[]): string => JSON.stringify(trimHist(histOf(times)));

let log: MockInstance<typeof console.log>;
beforeEach(async () => {
  await resetAll();
  log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  return () => log.mockRestore();
});

describe('LEVEL_BIN_SQL', () => {
  it('equals levelBin for every t in 0..5400 on the INTEGER column plays.t120', async () => {
    const key = 'L:1-1:00000000:s1';
    await seedPlays(key, 5401, 0);
    await env.DB.prepare('INSERT INTO plays (board, pidh, created, t120) VALUES (?, ?, ?, ?)').bind(key, 'bound', 1, 483).run();
    const { results } = await env.DB.prepare(`SELECT t120, typeof(t120) AS ty, ${LEVEL_BIN_SQL} AS b FROM plays WHERE board = ?`)
      .bind(key).all<{ t120: number; ty: string; b: number }>();
    expect(results).toHaveLength(5402);
    expect(new Set(results.map((r) => r.ty))).toEqual(new Set(['integer']));   // a bound JS number too
    expect(results.map((r) => r.b)).toEqual(results.map((r) => levelBin(r.t120)));
  });
});

describe('runHistRebuild', () => {
  it('rebuilds hist and n of the current boards from 2,000 plays rows; stale boards and boards without a row stay', async () => {
    await seedBoard(K1, fakeRows(3, 100), { n: 999, hist: [1] });
    await seedBoard(K2, fakeRows(3, 100), { n: 0 });
    await seedBoard(STALE, fakeRows(3, 100), { n: 5, hist: [5] });
    const times = await randomPlays(2000);
    for (const k of [K1, K2, K3, STALE]) expect(times.get(k)!.length).toBeGreaterThan(300);
    await setCounter(WR, 1000);
    await arm();
    const before = { k1: (await boardRow(K1))!.ver, k2: (await boardRow(K2))!.ver };

    const out = await runHistRebuild(env as unknown as Env, NOW);
    expect(out.written).toBe(2);
    expect(out.read).toBeGreaterThanOrEqual([K1, K2, K3].reduce((a, k) => a + times.get(k)!.length, 0));
    for (const k of [K1, K2]) {
      const br = (await boardRow(k))!;
      expect(br.hist).toBe(stored(times.get(k)!));
      expect(br.n).toBe(times.get(k)!.length);
    }
    expect([(await boardRow(K1))!.ver, (await boardRow(K2))!.ver]).toEqual([before.k1, before.k2]);   // never bumps ver
    expect(await boardRow(K3)).toBeNull();
    const stale = (await boardRow(STALE))!;
    expect([stale.hist, stale.n]).toEqual(['[5]', 5]);
    expect(await counter(WR)).toBe(1000 + 2 + 2);
    expect(await counter(HIST_NEXT_KEY)).toBe(NOW + HIST_MIN_INTERVAL_MS);
    expect(log).toHaveBeenLastCalledWith(JSON.stringify({ evt: 'hist-rebuild', read: out.read, written: 2, boards: 2, nextMin: 55 }));

    // Inside the interval: skipped. Forced again: nothing changed, so no boards row is written.
    expect(await runHistRebuild(env as unknown as Env, NOW + 54 * 60_000)).toEqual({ skipped: 'interval' });
    await arm();
    const p = proxyDb(env.DB);
    expect(await runHistRebuild({ ...(env as unknown as Env), DB: p.db }, NOW + HOUR)).toMatchObject({ written: 0 });
    expect(p.sqls.some((s) => s.startsWith('UPDATE boards'))).toBe(false);
    expect(await counter(WR)).toBe(1000 + 4 + 2);
  });

  it('is skipped when unarmed (no seed yet), under READ_ONLY and in lite; nothing is written', async () => {
    await seedBoard(K1, fakeRows(3, 100), { n: 3 });
    await randomPlays(200, [K1]);
    const e = env as unknown as Env;
    expect(await runHistRebuild(e, NOW)).toEqual({ skipped: 'unarmed' });
    await arm();
    const p = proxyDb(env.DB);
    expect(await runHistRebuild({ ...e, DB: p.db, READ_ONLY: '1' }, NOW)).toEqual({ skipped: 'READ_ONLY' });
    expect(p.count()).toBe(0);
    await setCounter(WR, 80_001);
    expect(await runHistRebuild(e, NOW)).toEqual({ skipped: 'lite' });
    expect([(await boardRow(K1))!.hist, (await boardRow(K1))!.n, await counter(HIST_NEXT_KEY)]).toEqual([null, 3, 0]);
    // soft (50k) does not stop it
    await setCounter(WR, 50_001);
    expect(await runHistRebuild(e, NOW)).toMatchObject({ written: 1 });
  });

  it('adaptive interval: 55 min up to 20k rows read, then whole hours minus 5 min (100k: the 5th hourly tick)', async () => {
    expect([0, 2000, 20_000].map(histIntervalMs)).toEqual([55 * 60_000, 55 * 60_000, 55 * 60_000]);
    expect(histIntervalMs(20_001)).toBe(HOUR + 55 * 60_000);
    expect(histIntervalMs(100_000)).toBe(4 * HOUR + 55 * 60_000);
    // Through the real code path: D1 reports 100k rows read for the snapshot.
    await seedBoard(K1, fakeRows(3, 100), { n: 3 });
    await randomPlays(100, [K1]);
    await arm();
    const big = {
      prepare: (sql: string) => env.DB.prepare(sql),
      batch: async (stmts: D1PreparedStatement[]) => {
        const r = await env.DB.batch(stmts);
        if (r.length === 2) for (const x of r) x.meta.rows_read = 50_000;
        return r;
      },
    } as unknown as D1Database;
    const e = { ...(env as unknown as Env), DB: big };
    expect(await runHistRebuild(e, NOW)).toMatchObject({ read: 100_000 });
    expect(await counter(HIST_NEXT_KEY)).toBe(NOW + 4 * HOUR + 55 * 60_000);
    for (let h = 1; h <= 4; h++) expect(await runHistRebuild(e, NOW + h * HOUR)).toEqual({ skipped: 'interval' });
    expect(await runHistRebuild(e, NOW + 5 * HOUR)).toMatchObject({ read: 100_000 });
  });

  it('a submit that bumps ver between the snapshot and the update wins: that board waits, the others are updated', async () => {
    await seedBoard(K1, fakeRows(3, 100), { n: 3 });
    await seedBoard(K2, fakeRows(3, 100), { n: 3 });
    const times = await randomPlays(600, [K1, K2]);
    await arm();
    const p = proxyDb(env.DB, async (sqls) => {
      if (sqls.some((s) => s.startsWith('UPDATE boards SET hist'))) {
        await env.DB.prepare('UPDATE boards SET ver = ver + 1, n = n + 1 WHERE board = ?').bind(K1).run();
      }
    });
    expect(await runHistRebuild({ ...(env as unknown as Env), DB: p.db }, NOW)).toMatchObject({ written: 1 });
    expect([(await boardRow(K1))!.hist, (await boardRow(K1))!.n]).toEqual([null, 4]);
    expect([(await boardRow(K2))!.hist, (await boardRow(K2))!.n]).toEqual([stored(times.get(K2)!), times.get(K2)!.length]);
    // The next run picks it up.
    await arm();
    expect(await runHistRebuild(env as unknown as Env, NOW + HOUR)).toMatchObject({ written: 1 });
    expect((await boardRow(K1))!.hist).toBe(stored(times.get(K1)!));
  });

  it('uses at most 1 + 2 + 18 + 1 = 22 statements with all 18 boards changing', async () => {
    expect(KEYS).toHaveLength(18);
    for (const k of KEYS) await seedBoard(k, [], { n: 0 });
    await randomPlays(900, KEYS, 11);
    await arm();
    const p = proxyDb(env.DB);
    expect(await runHistRebuild({ ...(env as unknown as Env), DB: p.db }, NOW)).toMatchObject({ written: 18 });
    expect(p.count()).toBe(22);
  });
});

describe('scheduled()', () => {
  it('dispatches on the cron string: 7 * * * * rebuilds, 30 15 * * * deletes old daily runs', async () => {
    expect([CRON_DAILY, CRON_HIST]).toEqual(['30 15 * * *', '7 * * * *']);
    await seedBoard(K1, fakeRows(3, 100), { n: 3 });
    const times = await randomPlays(100, [K1]);
    await env.DB.prepare("INSERT INTO runs (board, pidh, name_seed, t120, created) VALUES ('D:00001:1c0e77aa:s1', 'a1b2c3d4e5f60718', 1, 500, 1)").run();
    await arm();
    const run = async (cron: string, scheduledTime: number): Promise<void> => {
      const ctx = createExecutionContext();
      await worker.scheduled(createScheduledController({ scheduledTime, cron }), env as never, ctx);
      await waitOnExecutionContext(ctx);
    };
    const late = DAILY_EPOCH + 30 * DAY_MS + 30 * 60 * 1000;   // day 30, 00:30 JST: day 1 is older than 15 days

    await run(CRON_DAILY, late);
    expect(await counter(HIST_NEXT_KEY)).toBe(0);                 // the daily job does not rebuild
    expect((await boardRow(K1))!.hist).toBeNull();
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM runs WHERE board >= 'D:' AND board < 'E'").first('n')).toBe(0);

    await run(CRON_HIST, late);
    expect((await boardRow(K1))!.hist).toBe(stored(times.get(K1)!));
    expect(await counter(HIST_NEXT_KEY)).toBe(late + HIST_MIN_INTERVAL_MS);
    expect(log.mock.calls.map((c) => JSON.parse(String(c[0])).evt)).toEqual(['cron', 'hist-rebuild']);
  });

  it('logs hist-rebuild-failed when the rebuild throws', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const broken = { prepare: () => { throw new Error('boom'); }, batch: () => { throw new Error('boom'); } } as unknown as D1Database;
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime: NOW, cron: CRON_HIST }), { ...(env as object), DB: broken } as never, ctx);
    await waitOnExecutionContext(ctx);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('"evt":"hist-rebuild-failed"'));
    err.mockRestore();
  });
});
