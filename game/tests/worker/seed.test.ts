// One-off level-histogram seed (worker/seed.ts, GAME_DESIGN.md §7.7 「面のヒストグラムと順位の推定」). Owner: O9.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { dailyBoardKey, parseBoardKey } from '../../src/shared/api';
import { jstDate } from '../../worker/limits';
import { LEVEL_KEY_RE, seedLevelHistSql } from '../../worker/seed';
import { levelTargets } from '../../worker/verify';
import { levelKey, resetAll } from './helpers';

const K1 = levelKey('1-1');
const K2 = levelKey('1-2');
const STALE = 'L:1-1:deadbeef:s1';
const DAILY = dailyBoardKey(9, '1c0e77aa');
const pid = (i: number): string => `s${String(i).padStart(15, '0')}`;

async function insertRuns(key: string, rows: [pidh: string, t120: number | null][]): Promise<void> {
  const stmts = rows.map(([p, t]) =>
    env.DB.prepare('INSERT INTO runs (board, pidh, name_seed, t120, created) VALUES (?, ?, 1, ?, ?)').bind(key, p, t, 5_000));
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
}

async function insertPlay(key: string, pidh: string, t120: number | null): Promise<void> {
  await env.DB.prepare('INSERT INTO plays (board, pidh, created, t120) VALUES (?, ?, 7, ?)').bind(key, pidh, t120).run();
}

async function plays(): Promise<{ board: string; pidh: string; created: number; t120: number | null }[]> {
  return (await env.DB.prepare('SELECT board, pidh, created, t120 FROM plays ORDER BY board, pidh').all<{
    board: string; pidh: string; created: number; t120: number | null;
  }>()).results;
}

async function counter(k: string): Promise<number | null> {
  return (await env.DB.prepare('SELECT n FROM counters WHERE k = ?').bind(k).first<{ n: number }>())?.n ?? null;
}

beforeEach(async () => {
  await resetAll();
});

describe('seedLevelHistSql: keys', () => {
  it('accepts every current level board key', () => {
    const keys = levelTargets().map((t) => t.key);
    expect(keys).toHaveLength(18);
    for (const k of keys) {
      expect(k).toMatch(LEVEL_KEY_RE);
      expect(parseBoardKey(k)?.kind).toBe('L');
    }
    const sql = seedLevelHistSql(keys);
    expect(sql).toHaveLength(3);
    for (const k of keys) expect(sql[0]).toContain(`'${k}'`);
  });

  it('rejects an empty list, duplicates and anything that is not a level board key', () => {
    expect(() => seedLevelHistSql([])).toThrow(/no keys/);
    expect(() => seedLevelHistSql([K1, K2, K1])).toThrow(/duplicate/);
    for (const bad of [
      DAILY, 'L:1-1:13E2284E:s1', 'L:6-1:13e2284e:s1', 'L:1-0:13e2284e:s1', 'L:1-1:13e2284:s1', 'L:1-1:13e2284e:s0',
      'L:1-1:13e2284e:s12345', ` ${K1}`, `${K1}'`, `${K1}'); DELETE FROM runs; --`, '',
    ]) {
      expect(() => seedLevelHistSql([K1, bad]), bad).toThrow(/not a level board key/);
    }
  });
});

describe('seedLevelHistSql: applied to D1', () => {
  /** Runs on two current keys, one stale key and a daily; plays rows that must survive. Returns the current runs count. */
  async function fixture(): Promise<number> {
    expect(STALE).not.toBe(K1);
    const k1: [string, number | null][] = Array.from({ length: 150 }, (_, i) => [pid(i), 150 + 3 * i]);
    k1.push([pid(900), null]);                    // a NULL time is not a histogram position (and not counted)
    const k2: [string, number | null][] = Array.from({ length: 60 }, (_, i) => [pid(i), 400 + 5 * i]);
    await insertRuns(K1, k1);
    await insertRuns(K2, k2);
    await insertRuns(STALE, Array.from({ length: 40 }, (_, i) => [pid(i), 200 + i]));
    await insertRuns(DAILY, Array.from({ length: 10 }, (_, i) => [pid(i), 900 + i]));
    await insertPlay(K1, pid(3), 100);            // already faster than its runs time (159): kept
    await insertPlay(K1, pid(4), null);           // population row without a time: gets 162
    await insertPlay(K1, pid(5), 4000);           // slower than its runs time (165): becomes 165
    await insertPlay(K1, pid(800), null);         // no runs row: stays NULL
    await insertPlay(STALE, pid(1), null);        // stale board: never touched
    await env.DB.prepare('INSERT INTO counters (k, n) VALUES (?, 1000)').bind(`wr:${jstDate(Date.now())}`).run();
    return 150 + 60;
  }

  it('copies runs times into plays.t120 for the current keys only, keeping faster plays times', async () => {
    const counted = await fixture();
    const before = Date.now();
    const res: D1Result[] = [];
    for (const s of seedLevelHistSql([K1, K2])) res.push(await env.DB.prepare(s).run());
    const after = Date.now();

    const all = await plays();
    const t = (key: string, p: string): number | null | undefined => all.find((r) => r.board === key && r.pidh === p)?.t120;
    for (let i = 0; i < 150; i++) if (i !== 3) expect(t(K1, pid(i)), pid(i)).toBe(150 + 3 * i);
    for (let i = 0; i < 60; i++) expect(t(K2, pid(i))).toBe(400 + 5 * i);
    expect(t(K1, pid(3))).toBe(100);
    expect(t(K1, pid(4))).toBe(162);
    expect(t(K1, pid(5))).toBe(165);
    expect(t(K1, pid(800))).toBeNull();
    expect(t(K1, pid(900))).toBeUndefined();
    // New rows keep the runs row's created; existing rows keep theirs.
    expect(all.find((r) => r.board === K1 && r.pidh === pid(0))?.created).toBe(5_000);
    expect(all.find((r) => r.board === K1 && r.pidh === pid(4))?.created).toBe(7);
    // Stale and daily boards: untouched.
    expect(all.filter((r) => r.board === STALE)).toEqual([{ board: STALE, pidh: pid(1), created: 7, t120: null }]);
    expect(all.filter((r) => r.board === DAILY)).toEqual([]);
    // (a) wrote every current runs row except the one whose plays time was already faster.
    expect(res[0]!.meta.changes).toBe(counted - 1);

    // (b) today's JST write estimate: + runs count + 2. date('now', '+9 hours') is the Worker's jstDate.
    const day = [jstDate(before), jstDate(after)];
    const wrKey = (await env.DB.prepare("SELECT k FROM counters WHERE k LIKE 'wr:%'").all<{ k: string }>()).results.map((r) => r.k);
    expect(wrKey).toHaveLength(1);
    expect(day.map((d) => `wr:${d}`)).toContain(wrKey[0]);
    expect(await counter(wrKey[0]!)).toBe(1000 + counted + 2);
    // (c) the rebuild is armed.
    expect(await counter('hist:next')).toBe(0);
  });

  it('is idempotent: a second apply (the SQL file as the tool writes it) changes no plays row', async () => {
    await fixture();
    const stmts = seedLevelHistSql([K1, K2]);
    for (const s of stmts) await env.DB.prepare(s).run();
    const once = await plays();
    await env.DB.prepare("UPDATE counters SET n = 999999 WHERE k = 'hist:next'").run();

    const again = await env.DB.prepare(stmts[0]!).run();
    expect(again.meta.changes).toBe(0);
    expect(again.meta.rows_written ?? 0).toBe(0);
    // The file form: one statement per line, `;`-terminated (wrangler d1 execute --file).
    await env.DB.exec(stmts.join(';\n') + ';\n');
    expect(await plays()).toEqual(once);
    expect(await counter('hist:next')).toBe(0);
  });

  it('arms the rebuild and counts 2 rows even when there are no runs yet', async () => {
    for (const s of seedLevelHistSql([K1])) await env.DB.prepare(s).run();
    expect(await plays()).toEqual([]);
    const wr = await env.DB.prepare("SELECT n FROM counters WHERE k LIKE 'wr:%'").all<{ n: number }>();
    expect(wr.results).toEqual([{ n: 2 }]);
    expect(await counter('hist:next')).toBe(0);
  });
});
