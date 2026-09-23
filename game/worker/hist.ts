// Hourly cron 7 * * * *: rebuild the level histograms from plays.t120 (GAME_DESIGN.md §7.7 「面のヒストグラムと順位の推定」).
// Owner: O9.
//
// Level boards.hist and boards.n are a cache of the plays table: submits move a player's plays.t120 (and add 1 to n for
// a brand-new placement) but never write hist. This job recomputes both for the current 18 level keys (a board whose
// stored hist still counts someone but has no counted play left, after an admin purge, is emptied: [] and n = 0):
//   1 statement  counters: today's usage (lite -> skip) and 'hist:next' (absent = not armed; the one-off seed arms it)
//   1 batch      boards rows + one grouped SELECT over plays (one snapshot)
//   1 batch      UPDATE boards SET hist, n ... WHERE ver = <read ver> for each changed board (a submit that bumped ver in
//                between wins, that board waits for the next run; the rebuild never bumps ver itself), and the counters
//                ('hist:next' = the earliest next run, today's write estimate)
// At most 1 + 2 + 18 + 1 = 22 statements (D1: 50). Stale-hash boards are never read or written.
// Rows read (D1 meta.rows_read, measured on local D1): the grouped SELECT reads each counted plays row twice (the index
// search, then the GROUP BY temp B-tree) and each row without a time once, plus about 1 per key; the boards SELECT reads
// about 1 per key plus its rows. So ≈ 2 × counted + untimed + 3 × 18 + boards rows.
import type { Env } from './index';
import { Db, parseHist } from './db';
import { estimateUsage, isLite, jstDate } from './limits';
import { levelTargets } from './verify';
import { LEVEL_HIST_BINS, sumHist, trimHist } from '../src/shared/rank';

/** counters row: epoch ms of the earliest next rebuild. Absent = not armed (worker/seed.ts arms it with 0). */
export const HIST_NEXT_KEY = 'hist:next';
/** At most one rebuild per hourly tick. */
export const HIST_MIN_INTERVAL_MS = 55 * 60_000;
/**
 * Rows read per hour of interval (reads stay <= ~480k/day): hourly up to 20k rows read, i.e. ≈ 10k counted plays rows
 * (each is read twice); 100k rows read (≈ 50k counted rows) runs every 5th tick.
 */
export const HIST_ROWS_PER_HOUR = 20_000;
/** levelBin of src/shared/rank.ts in SQL: integer division on the INTEGER column t120 (tests pin it for t in 0..5400). */
export const LEVEL_BIN_SQL =
  'CASE WHEN t120 < 480 THEN t120 / 6 WHEN t120 < 1440 THEN 80 + (t120 - 480) / 24 ELSE MIN(152, 120 + (t120 - 1440) / 120) END';

/**
 * Time to the next rebuild after one that read `rowsRead` rows: max(55 min, ceil(rowsRead / 20k) h - 5 min). The 5 min
 * slack lets the matching hourly tick run (the ticks come every 60 min, a little late at most).
 */
export function histIntervalMs(rowsRead: number): number {
  return Math.max(HIST_MIN_INTERVAL_MS, Math.ceil(Math.max(0, rowsRead) / HIST_ROWS_PER_HOUR) * 3_600_000 - 5 * 60_000);
}

export interface HistRebuild { skipped?: string; read?: number; written?: number }

interface BoardRow { board: string; ver: number; n: number; hist: string | null }
interface BinRow { board: string; b: number; k: number }

export async function runHistRebuild(env: Env, now: number): Promise<HistRebuild> {
  const skip = (why: string): HistRebuild => {
    console.log(JSON.stringify({ evt: 'hist-rebuild', skipped: why }));
    return { skipped: why };
  };
  if (env.READ_ONLY === '1') return skip('READ_ONLY');
  const db = new Db(env.DB);
  const day = jstDate(now);
  const counters = await db.all<{ k: string; n: number }>(
    db.prepare('SELECT k, n FROM counters WHERE k IN (?, ?, ?)').bind(`req:${day}`, `wr:${day}`, HIST_NEXT_KEY),
  );
  if (isLite(estimateUsage(counters, now))) return skip('lite');
  const next = counters.find((r) => r.k === HIST_NEXT_KEY);
  if (!next) return skip('unarmed');
  if (now < next.n) return skip('interval');

  const keys = levelTargets().map((t) => t.key);
  const inList = keys.map(() => '?').join(', ');
  const [bRes, pRes] = await db.batch([
    db.prepare(`SELECT board, ver, n, hist FROM boards WHERE board IN (${inList})`).bind(...keys),
    db.prepare(
      `SELECT board, ${LEVEL_BIN_SQL} AS b, COUNT(*) AS k FROM plays WHERE board IN (${inList}) AND t120 IS NOT NULL GROUP BY board, b`,
    ).bind(...keys),
  ]);
  const boards = bRes!.results as BoardRow[];
  const bins = pRes!.results as BinRow[];

  const hists = new Map<string, number[]>();
  let counted = 0;
  for (const r of bins) {
    const k = Number(r.k) || 0;
    if (k <= 0) continue;
    let h = hists.get(r.board);
    if (!h) hists.set(r.board, (h = new Array<number>(LEVEL_HIST_BINS).fill(0)));
    h[Math.max(0, Math.min(LEVEL_HIST_BINS - 1, Math.floor(Number(r.b) || 0)))]! += k;
    counted += k;
  }
  // D1 reports the rows each statement read. Without that report, err high (a longer interval): 2 reads per counted row,
  // up to 2 rows without a time per counted row (read once; right after the seed ≈ 1 per counted row, e.g. 1-1 ≈ 505
  // of ≈ 1,000, and the share only falls: first sends and heals carry a time), 3 per key and the boards rows.
  const reported = [bRes!, pRes!].map((r) => r.meta?.rows_read);
  const read = reported.every((x) => typeof x === 'number')
    ? (reported as number[]).reduce((a, x) => a + x, 0)
    : 4 * counted + 3 * keys.length + boards.length;

  const stmts: D1PreparedStatement[] = [];
  for (const b of boards) {
    const h = hists.get(b.board);
    const had = parseHist(b.hist, LEVEL_HIST_BINS);
    // No counted play: nothing to rebuild from (the board keeps its n), unless the stored hist still counts someone.
    // Then an admin purge (package.json step (5)) took the last counted player out, and the board is emptied.
    if (!h && sumHist(had) === 0) continue;
    const json = JSON.stringify(h ? trimHist(h) : []);
    const n = h ? sumHist(h) : 0;
    if (b.n === n && b.hist !== null && JSON.stringify(trimHist(had)) === json) continue;
    stmts.push(db.prepare('UPDATE boards SET hist = ?, n = ? WHERE board = ? AND ver = ?').bind(json, n, b.board, b.ver));
  }
  const updates = stmts.length;
  const interval = histIntervalMs(read);
  stmts.push(
    db.prepare(
      'INSERT INTO counters (k, n) VALUES (?, ?), (?, ?) ON CONFLICT(k) DO UPDATE SET ' +
        `n = CASE WHEN excluded.k = '${HIST_NEXT_KEY}' THEN excluded.n ELSE counters.n + excluded.n END`,
    ).bind(HIST_NEXT_KEY, now + interval, `wr:${day}`, updates + 2),
  );
  const res = await db.batch(stmts);
  let written = 0;
  for (let i = 0; i < updates; i++) written += Number(res[i]!.meta?.changes ?? 0) || 0;
  console.log(JSON.stringify({ evt: 'hist-rebuild', read, written, boards: updates, nextMin: Math.round(interval / 60_000) }));
  return { read, written };
}
