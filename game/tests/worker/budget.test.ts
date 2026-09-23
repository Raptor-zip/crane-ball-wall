// §7.8 steps 1, 7, 8: CPU and D1 statement budgets, the cold-isolate rule, optimistic-lock conflicts. Owner: O9.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SubmitResponse, SubmitRun } from '../../src/shared/api';
import { DAILY_EPOCH, DAY_MS } from '../../src/shared/daily';
import { Db } from '../../worker/db';
import { setSubmitIsolateForTest } from '../../worker/routes/submit';
import {
  BOARD_UPDATE_SQL, NOW, boardRow, concurrentWrite, dailyAt, fakeDailyPool, fakeRows, level, levelKey, longBot, pidhOf,
  proxyDb, request, resetAll, runRow, seedBoard, submit, successBot, wallBots, type BotRun,
} from './helpers';

const POOL = fakeDailyPool();
const P11 = level('1-1').physics;
const KEY = levelKey('1-1');
let cache: { long: BotRun; short: BotRun; mid: BotRun } | null = null;
function bots(): { long: BotRun; short: BotRun; mid: BotRun } {
  cache ??= { long: longBot(P11), short: successBot(P11, { moveS: 4.5 }), mid: successBot(P11, { moveS: 12 }) };
  return cache;
}
const lvl = (bt: BotRun): SubmitRun => ({ board: KEY, level: '1-1', replay: bt.replay, t120: bt.t120, device: 1 });
const daily = (bt: BotRun, now = NOW): SubmitRun => {
  const d = dailyAt(POOL, now);
  return { board: d.key, level: d.levelId, replay: bt.replay, t120: bt.t120, device: 1, tries: 1, balls: 'O----' };
};
async function statuses(res: Response): Promise<string[]> {
  expect(res.status).toBe(200);
  return ((await res.json()) as SubmitResponse).results.map((r) => r.status);
}

beforeEach(async () => {
  await resetAll({ pool: POOL });
});

describe('CPU budget (step 1)', () => {
  it('the long bot is a ~45 s replay', () => {
    expect(bots().long.nTicks).toBeGreaterThanOrEqual(2500);
    expect(bots().long.nTicks).toBeLessThanOrEqual(2700);
  });

  it('defers a later run once the request would verify more than 5400 substeps', async () => {
    const { long, short } = bots();
    expect(long.nTicks * 2 + short.nTicks * 2).toBeGreaterThan(5400);
    expect(await statuses(await submit(request(1, [lvl(long), daily(short)])))).toEqual(['accepted', 'deferred']);
    expect(await runRow(dailyAt(POOL, NOW).key, pidhOf(1))).toBeNull();
    // Two short runs fit.
    expect(await statuses(await submit(request(2, [lvl(short), daily(short)])))).toEqual(['accepted', 'accepted']);
  });

  it('a single 45 s replay is verified even by a cold isolate; its other runs are deferred', async () => {
    setSubmitIsolateForTest(true);
    const { long, short } = bots();
    expect(await statuses(await submit(request(1, [lvl(long), daily(short)])))).toEqual(['accepted', 'deferred']);
    // The next request of the (now warm) isolate verifies the deferred run.
    expect(await statuses(await submit(request(1, [daily(short)])))).toEqual(['accepted']);
    await resetAll({ pool: POOL });   // (another player posting the same long run would be a dup)
    setSubmitIsolateForTest(true);
    expect(await statuses(await submit(request(3, [lvl(long)])))).toEqual(['accepted']);
  });
});

describe('optimistic lock (steps 7-8)', () => {
  it('retries once after a ver conflict and then succeeds', async () => {
    let conflicts = 0;
    const p = proxyDb(env.DB, async (sqls) => {
      if (conflicts === 0 && sqls.some((s) => s.startsWith(BOARD_UPDATE_SQL))) {
        conflicts++;
        await concurrentWrite(KEY);
      }
    });
    const res = await submit(request(1, [lvl(bots().short)]), { env: { DB: p.db } });
    expect(await statuses(res)).toEqual(['accepted']);
    const br = (await boardRow(KEY))!;
    expect(br.ver).toBe(2);                 // the concurrent writer's +1 and ours
    expect(br.tok).not.toBe('other');
    expect((await runRow(KEY, pidhOf(1)))!.t120).toBe(bots().short.t120);
  });

  it('two conflicts in a row -> deferred, and the EXISTS(tok) guard kept runs untouched', async () => {
    const p = proxyDb(env.DB, async (sqls) => {
      if (sqls.some((s) => s.startsWith(BOARD_UPDATE_SQL))) await concurrentWrite(KEY);
    });
    const res = await submit(request(1, [lvl(bots().short)]), { env: { DB: p.db } });
    expect(await statuses(res)).toEqual(['deferred']);
    const br = (await boardRow(KEY))!;
    expect(br.tok).toBe('other');
    expect(br.top).toBe('[]');
    expect(await runRow(KEY, pidhOf(1))).toBeNull();
  });

  it('a conflict never lets the runs write through when another request of the same ver won', async () => {
    // The winner writes its own row between our read and our batch: our ver is stale -> no runs row for us.
    const p = proxyDb(env.DB, async (sqls) => {
      if (sqls.some((s) => s.startsWith(BOARD_UPDATE_SQL))) {
        await env.DB.prepare("INSERT INTO boards (board, par, ver, tok) VALUES (?, 1, 1, 'winner') ON CONFLICT(board) DO UPDATE SET ver = ver + 1, tok = 'winner'")
          .bind(KEY).run();
      }
    });
    await submit(request(1, [lvl(bots().mid)]), { env: { DB: p.db } });
    expect(await runRow(KEY, pidhOf(1))).toBeNull();
  });
});

describe('D1 statement budget (step 1)', () => {
  it('Db.canStartRun: used + 13 + 1 <= 49', () => {
    const db = new Db(env.DB);
    db.used = 35;
    expect(db.canStartRun()).toBe(true);
    db.used = 36;
    expect(db.canStartRun()).toBe(false);
  });

  it('stays below 50 statements per request in the worst case: 4 runs, each with a drop, each conflicting twice', async () => {
    const t = DAILY_EPOCH + 10 * DAY_MS + 3600 * 1000;   // 01:00 JST: today's and yesterday's daily are both open
    await resetAll({ pool: POOL, now: t });
    const [wall] = wallBots(1) as [{ levelId: string; bot: BotRun }];
    const { short, mid } = bots();
    const runs = [
      lvl(short), daily(short, t), daily(mid, t - DAY_MS),
      { board: levelKey(wall.levelId), level: wall.levelId, replay: wall.bot.replay, t120: wall.bot.t120, device: 1 },
    ];
    // Full top 100 slower than every bot: each accepted run would push someone to rank 101 (UPDATE + upsert + drop).
    for (const r of runs) await seedBoard(r.board, fakeRows(100, 3000));
    const p = proxyDb(env.DB, async (sqls) => {
      if (sqls.some((s) => s.startsWith(BOARD_UPDATE_SQL))) for (const r of runs) await concurrentWrite(r.board);
    });
    const res = await submit(request(1, runs), { env: { DB: p.db } });
    expect(await statuses(res)).toEqual(['deferred', 'deferred', 'deferred', 'deferred']);
    // counters read + 4 runs x 2 attempts x (read 2 + UPDATE + upsert + drop) = 41 (+1 if the counters flush).
    expect(p.count()).toBeGreaterThanOrEqual(41);
    expect(p.count()).toBeLessThan(50);
    for (const r of runs) expect(await runRow(r.board, pidhOf(1))).toBeNull();
  });

  it('defers the remaining runs when the next one could exceed the budget', async () => {
    // Pretend the counters read already used 37 statements: 37 + 13 + 1 > 49.
    const origAll = Db.prototype.all;
    Db.prototype.all = async function <T>(this: Db, stmt: D1PreparedStatement): Promise<T[]> {
      const r = (await origAll.call(this, stmt)) as T[];
      this.used += 36;
      return r;
    };
    try {
      const res = await submit(request(1, [lvl(bots().short)]));
      expect(await statuses(res)).toEqual(['deferred']);
      expect(await boardRow(KEY)).toBeNull();
    } finally {
      Db.prototype.all = origAll;
    }
  });
});
