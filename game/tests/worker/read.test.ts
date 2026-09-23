// GET /api/boot, /api/board, /api/ghost, /api/bench, routing, counters and the cron cleanup (§7.7, §7.8 step 9). Owner: O9.
import { env, exports } from 'cloudflare:workers';
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardResponse, BootResponse, GhostResponse, SubmitResponse, SubmitRun } from '../../src/shared/api';
import { DAILY_EPOCH, DAY_MS } from '../../src/shared/daily';
import summaryJson from '../../src/data/ghosts_summary.json';
import worker from '../../worker/index';
import { runCron } from '../../worker/cron';
import { jstDate, pendingForTest, setClockForTest } from '../../worker/limits';
import { BOOT_CACHE_CONTROL, bootCacheUrl, isLocalHost, resetBootMemoForTest } from '../../worker/routes/boot';
import { WARMUP_LEVEL, WARMUP_TICKS, botQs, warmup } from '../../worker/warmup';
import { simulateReplay } from '../../src/sim/replay';
import { Status } from '../../src/sim/run';
import { dailyPool, dailyTarget, levelTargets, setDailyPoolForTest } from '../../worker/verify';
import {
  LEVELS, NOW, awayFromMinuteBoundary, call, dailyAt, fakeDailyPool, fakeRows, freshIp, level, levelKey, request, resetAll, seedBoard, submit,
  successBot, type BotRun,
} from './helpers';

const POOL = fakeDailyPool(3000);
const KEY = levelKey('1-1');
let bot: BotRun | null = null;
const b = (): BotRun => (bot ??= successBot(level('1-1').physics, { moveS: 4.5 }));
const run11 = (): SubmitRun => ({ board: KEY, level: '1-1', replay: b().replay, t120: b().t120, device: 2 });
const boot = async (q = '?day=9', ip?: string): Promise<Response> => call(`/api/boot${q}`, ip ? { ip } : {});

beforeEach(async () => {
  await resetAll({ pool: POOL });
});

describe('schema and routing', () => {
  it('has the §7.7 tables', async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('runs', 'boards', 'counters') ORDER BY name",
    ).all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual(['boards', 'counters', 'runs']);
  });

  it('answers unknown /api/* paths with a JSON 404 through the real entry module', async () => {
    const res = await exports.default.fetch('https://example.com/api/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'notFound' });
  });

  it('turns handler exceptions into a JSON 500', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const broken = { prepare: () => { throw new Error('boom'); }, batch: () => { throw new Error('boom'); } } as unknown as D1Database;
    const res = await call('/api/board/' + KEY, {}, { DB: broken });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal' });
    err.mockRestore();
  });
});

describe('GET /api/boot', () => {
  it('has the §7.7 shape and Cache-Control', async () => {
    const res = await boot();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60, stale-while-revalidate=300');
    expect(BOOT_CACHE_CONTROL).toBe('public, max-age=60, stale-while-revalidate=300');
    const j = (await res.json()) as BootResponse;
    expect(j).toMatchObject({ v: 1, sim: 1, now: NOW, day: 9, lite: false, readOnly: false });
    expect(Object.keys(j.boards)).toEqual(LEVELS.map((l) => l.id));
    const summary = summaryJson as unknown as { levels: Record<string, { parSub: number }> };
    for (const l of LEVELS) {
      expect(j.boards[l.id]).toEqual({ key: levelKey(l.id), n: 0, aiBeaten: 0, par: summary.levels[l.id]!.parSub, cutoff: null, top: [], wr: null });
    }
    const d = dailyAt(POOL, NOW);
    expect(j.daily).toEqual({ key: d.key, n: 0, cleared: 0, aiBeaten: 0, par: 3000, top: [], hist: new Array(150).fill(0), wr: null });
  });

  it('reports rankings: top 10 only, cutoff = 100th time, wr as base64url, daily hist', async () => {
    await seedBoard(levelKey('2-2'), fakeRows(100, 300));
    const res = await submit(request(1, [run11()]));
    expect(((await res.json()) as SubmitResponse).results[0]!.status).toBe('accepted');
    const j = (await (await boot()).json()) as BootResponse;
    const bb = j.boards['2-2']!;
    expect(bb.top).toHaveLength(10);
    expect(bb.cutoff).toBe(399);
    expect(bb.n).toBe(100);
    expect(j.boards['1-1']!.wr).toBe(b().replay);
    expect(j.boards['1-1']!.top[0]!.slice(1, 5)).toEqual([101, b().t120, -1, 2]);
  });

  it('memoises for 30 s per isolate and ignores the client day', async () => {
    const first = await (await boot()).text();
    await submit(request(1, [run11()]));
    expect(await (await boot('?day=123')).text()).toBe(first);   // memo hit, the day is the Worker's
    setClockForTest(() => NOW + 31_000);
    await caches.default.delete(bootCacheUrl('https://yurapita.test', NOW));   // the Cache API would still serve it for 60 s
    const later = (await (await boot()).json()) as BootResponse;
    expect(later.day).toBe(9);
    expect(later.boards['1-1']!.n).toBe(1);
  });

  it('local dev (DEV=1 or a localhost host) skips the Cache API: a new run shows once the memo is gone', async () => {
    expect(isLocalHost('localhost')).toBe(true);
    expect(isLocalHost('127.0.0.1')).toBe(true);
    expect(isLocalHost('app.localhost')).toBe(true);
    expect(isLocalHost('[::1]')).toBe(true);
    expect(isLocalHost('yurapita.example.com')).toBe(false);
    expect(isLocalHost('yurapita.workers.dev')).toBe(false);
    const dev = { DEV: '1' } as const;
    const first = (await (await call('/api/boot?day=9', {}, dev)).json()) as BootResponse;
    expect(first.boards['1-1']!.n).toBe(0);
    await submit(request(1, [run11()]));
    setClockForTest(() => NOW + 31_000);
    resetBootMemoForTest();
    const later = (await (await call('/api/boot?day=9', {}, dev)).json()) as BootResponse;
    expect(later.boards['1-1']!.n).toBe(1);
    // the same sequence on a deployed host is served from the Cache API for its max-age
    await resetAll({ pool: POOL });
    await boot();
    await submit(request(1, [run11()]));
    setClockForTest(() => NOW + 31_000);
    resetBootMemoForTest();
    expect(((await (await boot()).json()) as BootResponse).boards['1-1']!.n).toBe(0);
    await caches.default.delete(bootCacheUrl('https://yurapita.test', NOW));
  });

  it('never serves the previous day after 00:00 JST, also before DAILY_EPOCH where every day is dayIndex 0', async () => {
    const pool = fakeDailyPool(3000, true);
    for (const base of [DAILY_EPOCH - 5 * DAY_MS, DAILY_EPOCH + 20 * DAY_MS]) {
      const before = base - 10_000, after = base + 10_000;   // 23:59:50 and 00:00:10 JST
      await resetAll({ pool, now: before });
      const j1 = (await (await boot()).json()) as BootResponse;
      setClockForTest(() => after);
      const j2 = (await (await boot()).json()) as BootResponse;
      expect(j1.daily.key).toBe(dailyAt(pool, before).key);
      expect(j2.daily.key).toBe(dailyAt(pool, after).key);
      expect(j2.daily.key).not.toBe(j1.daily.key);
      expect(j2.now).toBe(after);
      await caches.default.delete(bootCacheUrl('https://yurapita.test', after));
    }
  });

  it('uses 2 D1 statements (boards IN + counters) on a miss and none on a memo hit', async () => {
    const { proxyDb } = await import('./helpers');
    const p = proxyDb(env.DB);
    await call('/api/boot?day=9', {}, { DB: p.db });
    expect(p.count()).toBe(2);
    expect(p.sqls[0]).toMatch(/WHERE board IN \((\?, ){18}\?\)$/);
    await call('/api/boot?day=9', {}, { DB: p.db });
    expect(p.count()).toBe(2);
  });

  it('serves from the Cache API when the memo is gone', async () => {
    await boot();
    const { resetBootMemoForTest } = await import('../../worker/routes/boot');
    resetBootMemoForTest();
    const { proxyDb } = await import('./helpers');
    const p = proxyDb(env.DB);
    const res = await call('/api/boot?day=5', {}, { DB: p.db });
    expect(res.status).toBe(200);
    expect(p.count()).toBe(0);
  });

  it('flags readOnly and lite', async () => {
    await env.DB.prepare('INSERT INTO counters (k, n) VALUES (?, ?)').bind(`wr:${jstDate(NOW)}`, 80_001).run();
    const j = (await (await call('/api/boot', {}, { READ_ONLY: '1' })).json()) as BootResponse;
    expect([j.readOnly, j.lite]).toEqual([true, true]);
  });

  it('429 after 30 reads a minute from one IP (RL_READ)', { timeout: 10_000 }, async () => {
    await awayFromMinuteBoundary();
    const ip = freshIp();
    const codes: number[] = [];
    for (let i = 0; i < 31; i++) codes.push((await boot('', ip)).status);
    expect(codes.slice(0, 30).every((c) => c === 200)).toBe(true);
    expect(codes[30]).toBe(429);
  });
});

describe('GET /api/board/:key and /api/ghost/:key/:rank', () => {
  it('board returns the whole top 100 with Cache-Control max-age=60', async () => {
    await seedBoard(KEY, fakeRows(100, 1000));
    await submit(request(1, [run11()]));
    const res = await call(`/api/board/${encodeURIComponent(KEY)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
    const j = (await res.json()) as BoardResponse;
    expect(j.key).toBe(KEY);
    expect(j.top).toHaveLength(100);
    expect(j.top[0]![2]).toBe(b().t120);
    expect(j.n).toBe(101);
    expect(j.cutoff).toBe(1098);
    // Raw ':' works as well; an unknown board is empty, a malformed key is 400.
    expect((await call(`/api/board/${KEY}`)).status).toBe(200);
    expect(await (await call('/api/board/L:2-1:00000000:s1')).json()).toEqual({ key: 'L:2-1:00000000:s1', n: 0, aiBeaten: 0, par: 0, cutoff: null, top: [] });
    expect((await call('/api/board/garbage')).status).toBe(400);
    // Today's daily board has its par before anyone submitted.
    const d = dailyAt(POOL, NOW);
    expect(await (await call(`/api/board/${d.key}`)).json()).toMatchObject({ key: d.key, n: 0, par: 3000, top: [] });
  });

  it('ghost returns the replay at a rank with Cache-Control max-age=300', async () => {
    await submit(request(1, [run11()], 4242));
    const res = await call(`/api/ghost/${encodeURIComponent(KEY)}/1`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');
    const j = (await res.json()) as GhostResponse;
    expect(j).toEqual({ key: KEY, rank: 1, pidh: expect.stringMatching(/^[0-9a-f]{16}$/), nameSeed: 4242, t120: b().t120, replay: b().replay });
    expect((await call(`/api/ghost/${KEY}/2`)).status).toBe(404);
    expect((await call(`/api/ghost/${KEY}/0`)).status).toBe(400);
    expect((await call(`/api/ghost/${KEY}/101`)).status).toBe(400);
    expect((await call('/api/ghost/nope/1')).status).toBe(400);
  });

  it('ghost is 404 for a rank whose replay was dropped', async () => {
    await seedBoard(KEY, fakeRows(3, 500));
    await env.DB.prepare('UPDATE runs SET replay = NULL WHERE board = ? AND t120 = 501').bind(KEY).run();
    expect((await call(`/api/ghost/${KEY}/1`)).status).toBe(200);
    expect((await call(`/api/ghost/${KEY}/2`)).status).toBe(404);
  });
});

describe('GET /api/bench', () => {
  it('is 404 unless DEV=1', async () => {
    expect((await call('/api/bench?level=2-2&n=1')).status).toBe(404);
  });

  it('verifies the bundled 45 s bot replay n times with DEV=1', async () => {
    const res = await call('/api/bench?level=2-2&n=2', {}, { DEV: '1' });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { level: string; n: number; ticks: number; substeps: number; status: number; simTicks: number };
    expect(j).toMatchObject({ level: '2-2', n: 2, ticks: 2700, substeps: 10800, simTicks: 2700, status: 1 });   // still running after 45 s
  });

  it('module-scope warmup: the bundled 5 s bot really runs 300 ticks on 2-2 (no early crash) and never throws', () => {
    const r = simulateReplay(level(WARMUP_LEVEL).physics, botQs(WARMUP_TICKS));
    expect([WARMUP_TICKS, r.ticks, r.status]).toEqual([300, 300, Status.Running]);
    expect(botQs(WARMUP_TICKS)[0]).not.toBe(0);
    expect(warmup()).toBeGreaterThanOrEqual(0);
  });
});

describe('bundled data', () => {
  it('loads src/data/daily_pool.json through the glob import (empty until O2 generates it)', async () => {
    setDailyPoolForTest(null);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const pool = await dailyPool();
    warn.mockRestore();
    expect(Array.isArray(pool)).toBe(true);
    if (pool.length > 0) {
      expect(pool).toHaveLength(84);
      for (const d of pool) expect(d.parSub).toBeGreaterThan(0);
      const t = await dailyTarget(NOW);
      expect(t!.key).toMatch(/^D:00009:[0-9a-f]{8}:s1$/);
    } else {
      expect(await dailyTarget(NOW)).toBeNull();
    }
  });

  it('has a par for every level board', () => {
    for (const t of levelTargets()) expect(t.par, t.levelId).toBeGreaterThan(0);
  });
});

describe('usage counters (§7.8 step 9)', () => {
  it('flushes the request count every 100 requests', async () => {
    for (let i = 0; i < 99; i++) await boot();
    expect(await env.DB.prepare('SELECT n FROM counters WHERE k = ?').bind(`req:${jstDate(NOW)}`).first('n')).toBeNull();
    await boot();
    expect(await env.DB.prepare('SELECT n FROM counters WHERE k = ?').bind(`req:${jstDate(NOW)}`).first('n')).toBe(100);
    expect(pendingForTest().req).toBe(0);
  });

  it('flushes rows written every 50 rows, inside the submit request', async () => {
    const rows = [];
    for (let i = 0; i < 30; i++) {
      // 30 players with 30 different runs (the same run from another player would be a dup)
      const own = successBot(level('1-1').physics, { moveS: 4 + i / 10 });
      const res = await submit(request(10 + i, [{ ...run11(), replay: own.replay, t120: own.t120 }]));
      rows.push(((await res.json()) as SubmitResponse).results[0]!.status);
    }
    expect(rows.every((s) => s === 'accepted')).toBe(true);
    const wr = await env.DB.prepare('SELECT n FROM counters WHERE k = ?').bind(`wr:${jstDate(NOW)}`).first<number>('n');
    expect(wr).toBeGreaterThanOrEqual(50);
    expect(pendingForTest().wr).toBeLessThan(50);
  });
});

describe('cron (00:30 JST)', () => {
  it('deletes daily runs older than 15 days with a key-range DELETE and counts the writes', async () => {
    const stmts = [];
    for (let d = 1; d <= 30; d++) {
      stmts.push(env.DB.prepare('INSERT INTO runs (board, pidh, name_seed, t120, created) VALUES (?, ?, 1, 500, 1)')
        .bind(`D:${String(d).padStart(5, '0')}:1c0e77aa:s1`, 'a1b2c3d4e5f60718'));
    }
    stmts.push(env.DB.prepare("INSERT INTO runs (board, pidh, name_seed, t120, created) VALUES ('L:1-1:13e2284e:s1', 'a1b2c3d4e5f60718', 1, 500, 1)"));
    await env.DB.batch(stmts);
    const t = DAILY_EPOCH + 30 * DAY_MS + 30 * 60 * 1000;   // day 30, 00:30 JST
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const ctrl = createScheduledController({ scheduledTime: t, cron: '30 15 * * *' });
    const ctx = createExecutionContext();
    await worker.scheduled(ctrl, env as never, ctx);
    await waitOnExecutionContext(ctx);
    const left = await env.DB.prepare('SELECT board FROM runs ORDER BY board').all<{ board: string }>();
    const boards = left.results.map((r) => r.board);
    expect(boards).toHaveLength(17);
    expect(boards[0]).toBe('D:00015:1c0e77aa:s1');
    expect(boards).toContain('L:1-1:13e2284e:s1');
    expect(await env.DB.prepare('SELECT n FROM counters WHERE k = ?').bind(`wr:${jstDate(t)}`).first('n')).toBe(15);
    // Nothing to delete in the first 15 days, and nothing at all while READ_ONLY.
    expect(await runCron(env as never, DAILY_EPOCH + 10 * DAY_MS)).toBe(0);
    expect(await runCron({ ...(env as object), READ_ONLY: '1' } as never, t + 20 * DAY_MS)).toBe(0);
    expect(log.mock.calls.map((c) => String(c[0]))).toEqual([
      JSON.stringify({ evt: 'cron', below: 'D:00015', deleted: 14 }),   // days 1..14; the counter adds its own row (15)
      JSON.stringify({ evt: 'cron', below: null, deleted: 0 }),
      JSON.stringify({ evt: 'cron', skipped: 'READ_ONLY' }),
    ]);
    log.mockRestore();
  });
});
