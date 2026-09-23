// POST /api/submit: verification and writes (GAME_DESIGN.md §7.8). Owner: O9.
//
// Runs are processed in order (§7.8 steps 1-10):
//   1  CPU budget (substeps, first-run rule, cold-isolate rule) and D1 statement budget (<= 49 per request)
//   2  board key -> level / par (stale, badBoard)            verify.ts resolveBoard
//   3  replay decoding and limits (badReplay, tooLong)        verify.ts decodeRun
//   4  re-simulation (mismatch)                               verify.ts simulateRun
//   5  gap_um / peak_cn                                       verify.ts simulateRun
//   6  read boards row + own runs row, rank in `top`, dups    decide(), dup.ts
//      (and INSERT OR IGNORE the plays row: the play population, whatever the rank)
//   7  one DB.batch: UPDATE boards (optimistic lock, per-request tok) + EXISTS-guarded runs writes
//   8  one retry on a ver conflict, then `deferred`
//   9  isolate counters flushed every 50 rows / 100 requests
//   10 lite safety valve
import type { Env } from '../index';
import {
  Db, STATEMENTS_COUNTERS, STATEMENT_LIMIT, apiError, cutoffOf, json, parseHist, parseTop, randomTok, rowsWritten, type TopRow,
} from '../db';
import { isDuplicateRun, runFingerprint } from '../dup';
import { counterFlushDue, countersStatement, estimateUsage, flushCounters, isLite, noteWrites, nowMs, allowRequest, clientKey } from '../limits';
import { decodeRun, resolveBoard, simulateRun, type Target } from '../verify';
import {
  BOARD_TOP_N, MAX_RANKED_T120, NO_WALL_GAP_UM, SUBMIT_MAX_BYTES, SUBMIT_MAX_RUNS, histBin, pctFromHist,
  type SubmitResponse, type SubmitResult, type SubmitRun,
} from '../../src/shared/api';
import { isValidSecret, pidhFromSecret } from '../../src/shared/names';

/** Substeps verified per request (§7.10 CPU: 5400 = one 45 s run). */
export const CPU_SUBSTEPS = 5400;
/** In lite mode only level runs that reach this rank are accepted (§7.8 step 10). */
export const LITE_TOP = 10;

let submitsSeen = 0;

/** Test hook: cold = the next submit is treated as the first one of a fresh isolate. */
export function setSubmitIsolateForTest(cold: boolean): void {
  submitsSeen = cold ? 0 : 1;
}

export async function handleSubmit(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
  if (req.method !== 'POST') return apiError(405, 'method', { Allow: 'POST' });
  if (env.READ_ONLY === '1') return apiError(503, 'READ_ONLY');
  const refused = refuseForeign(req);
  if (refused) return refused;
  if (!(await allowRequest(env, 'submit', clientKey(req)))) return apiError(429, 'rateLimited', { 'Retry-After': '60' });

  const text = await readCapped(req, SUBMIT_MAX_BYTES);
  if (text === null) return apiError(413, 'tooLarge');
  const body = parseRequest(text);
  if (!body) return apiError(400, 'badRequest');

  const now = nowMs();
  const cold = submitsSeen === 0;
  submitsSeen += 1;
  const db = new Db(env.DB);
  const usage = estimateUsage(await db.all<{ k: string; n: number }>(countersStatement(db, now)), now);
  const lite = isLite(usage);
  const ctx: RunCtx = {
    db, now, lite, tok: randomTok(), pidh: pidhFromSecret(body.secret)!, nameSeed: body.nameSeed,
    ua: req.headers.get('User-Agent') ?? '', rows: 0,
  };

  const results: SubmitResult[] = [];
  let substeps = 0;
  for (let i = 0; i < body.runs.length; i++) {
    const run = body.runs[i]!;
    // Step 1: D1 statement budget, and the cold-isolate rule (only the first run of the first request).
    if (!db.canStartRun() || (cold && i >= 1)) {
      results.push({ board: run.board, status: 'deferred' });
      continue;
    }
    // Step 2.
    const res = await resolveBoard(run, now);
    if (!res.ok) {
      results.push({ board: run.board, status: 'rejected', reason: res.reason });
      continue;
    }
    const target = res.target;
    // Steps 3-5 (a daily participation without success skips them).
    let cand: Candidate;
    if (run.replay === null || run.t120 === null) {
      if (target.kind === 'L' || run.replay !== null || run.t120 !== null) {
        results.push({ board: run.board, status: 'rejected', reason: 'badReplay' });
        continue;
      }
      cand = { t120: null, gapUm: null, peakCn: null, device: run.device, replay: null, fp: null };
    } else {
      const dec = decodeRun(run.replay, target);
      if (!dec.ok) {
        results.push({ board: run.board, status: 'rejected', reason: dec.reason });
        continue;
      }
      // Step 1: CPU budget. The first run is always verified, whatever its length.
      const cost = dec.nTicks * 2;
      if (i >= 1 && substeps + cost > CPU_SUBSTEPS) {
        results.push({ board: run.board, status: 'deferred' });
        continue;
      }
      substeps += cost;
      const sim = simulateRun(target, dec.qs, run.t120);
      if (!sim.ok) {
        console.warn({ evt: 'mismatch', ua: ctx.ua, board: run.board, claimed: run.t120, got: sim.got });
        results.push({ board: run.board, status: 'rejected', reason: 'mismatch' });
        continue;
      }
      cand = { t120: sim.t120, gapUm: sim.gapUm, peakCn: sim.peakCn, device: run.device, replay: dec.bytes, fp: runFingerprint(dec.qs) };
    }
    // Steps 6-8. A D1 failure defers this run only: the runs already written keep their answers and the rows
    // they wrote still reach the counters (a transaction that failed wrote nothing; a write batch that committed
    // before the error surfaced is recognised by place() through the request's tok and answered normally).
    try {
      results.push(await place(ctx, target, run, cand));
    } catch (e) {
      console.error(JSON.stringify({ evt: 'submit-d1-error', board: run.board, err: String(e) }));
      results.push({ board: run.board, status: 'deferred' });
    }
  }

  // Step 9.
  noteWrites(ctx.rows, now);
  if (counterFlushDue(now)) await flushCounters(db, env, now);

  const out: SubmitResponse = { ok: true, lite, results };
  return json(out, 200, { 'Cache-Control': 'no-store' });
}

// ---- Request parsing ----

/**
 * Only the game's own page may submit. A cross-site page could otherwise make every visitor's browser post copied
 * replays with a CORS "simple" request (text/plain, no preflight), from each visitor's own address.
 * - Content-Type must be application/json: from another origin that needs a preflight, and OPTIONS gets no CORS
 *   answer, so the browser never sends the POST (415 for anything else).
 * - Sec-Fetch-Site, when the browser sends it, must be same-origin (or none); otherwise the Origin header, when
 *   present, must be this request's origin (403). Scripts without these headers (curl) are left to the rate limit.
 */
export function refuseForeign(req: Request): Response | null {
  const type = (req.headers.get('Content-Type') ?? '').trim().toLowerCase();
  if (!/^application\/json\s*(;|$)/.test(type)) return apiError(415, 'badRequest');
  const site = req.headers.get('Sec-Fetch-Site');
  if (site !== null) return site === 'same-origin' || site === 'none' ? null : apiError(403, 'forbidden');
  const origin = req.headers.get('Origin');
  if (origin !== null && origin !== new URL(req.url).origin) return apiError(403, 'forbidden');
  return null;
}

interface ParsedRequest { secret: string; nameSeed: number; runs: SubmitRun[] }

/** Reads the body as text; null when it exceeds `max` bytes. */
async function readCapped(req: Request, max: number): Promise<string | null> {
  const len = Number(req.headers.get('Content-Length') ?? NaN);
  if (Number.isFinite(len) && len > max) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    all.set(c, o);
    o += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

const isInt = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

/** Shape validation (400 on any violation). Semantic problems of a run become `rejected` later. */
export function parseRequest(text: string): ParsedRequest | null {
  let b: unknown;
  try {
    b = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof b !== 'object' || b === null) return null;
  const o = b as Record<string, unknown>;
  if (o.v !== 1 || !isValidSecret(o.secret) || !isInt(o.nameSeed, 0, 65535)) return null;
  if (!Array.isArray(o.runs) || o.runs.length < 1 || o.runs.length > SUBMIT_MAX_RUNS) return null;
  const runs: SubmitRun[] = [];
  const seen = new Set<string>();
  for (const r of o.runs as unknown[]) {
    if (typeof r !== 'object' || r === null) return null;
    const x = r as Record<string, unknown>;
    if (typeof x.board !== 'string' || x.board.length > 64 || seen.has(x.board)) return null;
    if (typeof x.level !== 'string' || x.level.length > 16) return null;
    if (x.replay !== null && typeof x.replay !== 'string') return null;
    if (x.t120 !== null && !isInt(x.t120, 0, 1e6)) return null;
    if (!isInt(x.device, 0, 5)) return null;
    if (x.tries !== undefined && !isInt(x.tries, 0, 5)) return null;
    if (x.balls !== undefined && (typeof x.balls !== 'string' || !/^[XOGC-]{5}$/.test(x.balls))) return null;
    // prev is the t120 of an accepted run, so it can never exceed the longest ranked run.
    if (x.prev !== undefined && x.prev !== null && !isInt(x.prev, 0, MAX_RANKED_T120)) return null;
    seen.add(x.board);
    const run: SubmitRun = { board: x.board, level: x.level, replay: x.replay as string | null, t120: x.t120 as number | null, device: x.device };
    if (x.tries !== undefined) run.tries = x.tries;
    if (x.balls !== undefined) run.balls = x.balls;
    if (x.prev !== undefined) run.prev = x.prev as number | null;
    runs.push(run);
  }
  return { secret: o.secret, nameSeed: o.nameSeed, runs };
}

// ---- Steps 6-8 ----

interface RunCtx {
  db: Db; now: number; lite: boolean; tok: string; pidh: string; nameSeed: number; ua: string;
  rows: number;   // rows written by this request (step 9)
}

/** Verified values of one run (t120 null = daily participation without success). fp: dup.ts runFingerprint. */
interface Candidate {
  t120: number | null; gapUm: number | null; peakCn: number | null; device: number; replay: Uint8Array | null; fp: string | null;
}

export interface BoardState { exists: boolean; ver: number; top: TopRow[]; n: number; cleared: number; aiBeaten: number; hist: number[] }

export interface DecideInput {
  kind: 'L' | 'D'; board: string; par: number; lite: boolean; now: number;
  pidh: string; nameSeed: number; device: number;
  t120: number | null; gapUm: number | null; peakCn: number | null; replay: Uint8Array | null;
  fp: string | null;                   // fingerprint of the run's inputs (dup.ts); null without a replay
  prev: number | null | undefined;     // daily only (§7.7 `prev`)
  state: BoardState;
  own: { t120: number | null } | null;   // own runs row
}

export interface RunsRow {
  t120: number; gapUm: number | null; peakCn: number | null; device: number; replay: Uint8Array | null; created: number;
}

export type Decision =
  | { write: false; result: SubmitResult; touchOwn: boolean }   // touchOwn: daily notBetter updates balls/tries of an existing row
  | {
    write: true; result: SubmitResult;
    top: TopRow[]; n: number; cleared: number; aiBeaten: number; hist: number[] | null;
    wr: Uint8Array | null;            // new rank-1 replay (null keeps the current one)
    runs: RunsRow | null;             // runs row to upsert (null: a daily first send outside the top 100, or without success)
    drop: string | null;              // pidh that fell to rank 101 (its replay is set to NULL)
  };

const minOf = (...xs: (number | null | undefined)[]): number | null => {
  let m: number | null = null;
  for (const x of xs) if (typeof x === 'number' && (m === null || x < m)) m = x;
  return m;
};

const rejectDup = (board: string): Decision => ({ write: false, touchOwn: false, result: { board, status: 'rejected', reason: 'dup' } });

/** §7.8 step 6 (and the counting rules of step 7) as a pure function. */
export function decide(d: DecideInput): Decision {
  const { state: s, pidh } = d;
  const ownIdx = s.top.findIndex((r) => r[0] === pidh);
  const ownTop = ownIdx >= 0 ? s.top[ownIdx]! : null;
  const others = ownIdx >= 0 ? s.top.filter((_, i) => i !== ownIdx) : s.top;
  const cutoff = cutoffOf(s.top);
  const ownRank = ownIdx >= 0 ? ownIdx + 1 : null;

  if (d.kind === 'L') {
    const t = d.t120!;
    const ownBest = minOf(d.own?.t120, ownTop?.[2]);
    const pos = countAtOrBelow(others, t);
    const rank = pos + 1;
    const inTop = rank <= BOARD_TOP_N;
    const alreadyBeaten = ownBest !== null && ownBest < d.par;
    if (!inTop && (t >= d.par || alreadyBeaten)) {
      return { write: false, touchOwn: false, result: { board: d.board, status: 'unranked', rank: null, n: s.n, cutoff, aiBeaten: t < d.par } };
    }
    if (ownBest !== null && t >= ownBest) {
      return { write: false, touchOwn: false, result: { board: d.board, status: 'notBetter', rank: ownRank, n: s.n, cutoff, aiBeaten: t < d.par } };
    }
    // Another player's top-100 run with the same inputs (dup.ts): the copy is neither ranked nor counted as AI-beaten.
    if (d.fp !== null && isDuplicateRun(d.fp, t, others)) return rejectDup(d.board);
    if (d.lite && rank > LITE_TOP) {
      return { write: false, touchOwn: false, result: { board: d.board, status: 'rejected', reason: 'lite' } };
    }
    const row = topRow(d, t);
    const { top, drop } = inTop ? insertRow(others, pos, row) : { top: s.top, drop: null };
    const n = s.n + (d.own ? 0 : 1);
    const aiBeaten = s.aiBeaten + (t < d.par && !alreadyBeaten ? 1 : 0);
    return {
      write: true, top, n, cleared: s.cleared, aiBeaten, hist: null,
      wr: inTop && rank === 1 ? d.replay : null,
      runs: { t120: t, gapUm: d.gapUm, peakCn: d.peakCn, device: d.device, replay: inTop ? d.replay : null, created: d.now },
      drop,
      result: { board: d.board, status: 'accepted', rank: inTop ? rank : null, n, cutoff: cutoffOf(top), aiBeaten: t < d.par },
    };
  }

  // Daily board. `prev` is self-reported: it only stands in for the player's record while the server has none. Every
  // accepted resend (prev present), AI-beaten run or improvement of a player with a runs row writes a runs row (without
  // a replay outside the top 100), so from then on the server's own record decides and a forged prev cannot be used
  // again and again (it would move a histogram count and add an AI-beaten person on every resend).
  const ownBest = minOf(d.own?.t120, ownTop?.[2], d.own || ownTop ? undefined : d.prev);
  const firstSend = d.prev === undefined && !d.own && !ownTop;
  if (d.t120 === null) {
    // Participation without success: counts in n only (no hist, no ranking, no runs row).
    if (!firstSend) return { write: false, touchOwn: !!d.own, result: { board: d.board, status: 'notBetter', rank: ownRank, n: s.n } };
    const n = s.n + 1;
    return {
      write: true, top: s.top, n, cleared: s.cleared, aiBeaten: s.aiBeaten, hist: s.hist, wr: null, runs: null, drop: null,
      result: { board: d.board, status: 'accepted', rank: null, n },
    };
  }
  const t = d.t120;
  if (ownBest !== null && t >= ownBest) {
    return { write: false, touchOwn: !!d.own, result: { board: d.board, status: 'notBetter', rank: ownRank, n: s.n } };
  }
  if (d.fp !== null && isDuplicateRun(d.fp, t, others)) return rejectDup(d.board);
  const pos = countAtOrBelow(others, t);
  const rank = pos + 1;
  const inTop = rank <= BOARD_TOP_N;
  const n = s.n + (firstSend ? 1 : 0);
  // Counted people stay consistent whatever the self-reported prev says: ai_beaten <= cleared <= n.
  const cleared = Math.min(n, s.cleared + (ownBest === null ? 1 : 0));
  const aiBeaten = Math.min(cleared, s.aiBeaten + (t < d.par && !(ownBest !== null && ownBest < d.par) ? 1 : 0));
  const hist = s.hist.slice();
  if (ownBest !== null) {
    const ob = histBin(ownBest);
    hist[ob] = Math.max(0, hist[ob]! - 1);
  }
  hist[histBin(t)]! += 1;
  const pct = pctFromHist(hist, t, cleared);
  let top = s.top, drop: string | null = null, runs: RunsRow | null = null;
  if (inTop) {
    ({ top, drop } = insertRow(others, pos, topRow(d, t)));
    runs = { t120: t, gapUm: d.gapUm, peakCn: d.peakCn, device: d.device, replay: d.replay, created: d.now };
  } else if (d.own || d.prev !== undefined || t < d.par) {
    runs = { t120: t, gapUm: d.gapUm, peakCn: d.peakCn, device: d.device, replay: null, created: d.now };
  }
  const result: SubmitResult = { board: d.board, status: 'accepted', rank: inTop ? rank : estimateRank(hist, t), n };
  if (pct !== null) result.pct = pct;
  return { write: true, top, n, cleared, aiBeaten, hist, wr: inTop && rank === 1 ? d.replay : null, runs, drop, result };
}

/** The stored top row of this run (with the input fingerprint when there is one). */
function topRow(d: DecideInput, t: number): TopRow {
  const row: TopRow = [d.pidh, d.nameSeed, t, d.gapUm ?? NO_WALL_GAP_UM, d.device, d.now];
  if (d.fp !== null) row.push(d.fp);
  return row;
}

/** Rows with t120 <= t (equal times: the earlier submission stays ahead). */
function countAtOrBelow(rows: readonly TopRow[], t: number): number {
  let k = 0;
  while (k < rows.length && rows[k]![2] <= t) k++;
  return k;
}

function insertRow(others: readonly TopRow[], pos: number, row: TopRow): { top: TopRow[]; drop: string | null } {
  const top = [...others.slice(0, pos), row, ...others.slice(pos)];
  const drop = top.length > BOARD_TOP_N ? top[BOARD_TOP_N]![0] : null;
  return { top: top.slice(0, BOARD_TOP_N), drop };
}

/** Daily rank outside the top 100, estimated from the histogram (the same half-bin rule as pct). */
function estimateRank(hist: readonly number[], t: number): number {
  const b = histBin(t);
  let faster = 0;
  for (let i = 0; i < b; i++) faster += hist[i]!;
  return Math.max(BOARD_TOP_N + 1, Math.floor(faster + hist[b]! / 2) + 1);
}

const SQL_READ_BOARD = 'SELECT ver, top, n, cleared, ai_beaten, hist FROM boards WHERE board = ?';
const SQL_READ_OWN = 'SELECT t120 FROM runs WHERE board = ? AND pidh = ?';
const SQL_PLAY = 'INSERT OR IGNORE INTO plays (board, pidh, created) VALUES (?, ?, ?)';
const SQL_NEW_BOARD = 'INSERT OR IGNORE INTO boards (board, par) VALUES (?, ?)';
const SQL_UPDATE_BOARD =
  'UPDATE boards SET ver = ver + 1, tok = ?, top = ?, n = ?, cleared = ?, ai_beaten = ?, hist = ?, wr = COALESCE(?, wr), par = ?, updated = ? ' +
  'WHERE board = ? AND ver = ?';
const BETTER = 'runs.t120 IS NULL OR excluded.t120 < runs.t120';
const SQL_UPSERT_RUN =
  'INSERT INTO runs (board, pidh, name_seed, t120, gap_um, peak_cn, device, tries, balls, replay, created) ' +
  'SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11 WHERE EXISTS (SELECT 1 FROM boards WHERE board = ?1 AND tok = ?12) ' +
  'ON CONFLICT (board, pidh) DO UPDATE SET name_seed = excluded.name_seed, tries = excluded.tries, balls = excluded.balls, ' +
  `t120 = CASE WHEN ${BETTER} THEN excluded.t120 ELSE runs.t120 END, ` +
  `gap_um = CASE WHEN ${BETTER} THEN excluded.gap_um ELSE runs.gap_um END, ` +
  `peak_cn = CASE WHEN ${BETTER} THEN excluded.peak_cn ELSE runs.peak_cn END, ` +
  `device = CASE WHEN ${BETTER} THEN excluded.device ELSE runs.device END, ` +
  `replay = CASE WHEN ${BETTER} THEN excluded.replay ELSE runs.replay END, ` +
  `created = CASE WHEN ${BETTER} THEN excluded.created ELSE runs.created END`;
const SQL_DROP_REPLAY =
  'UPDATE runs SET replay = NULL WHERE board = ?1 AND pidh = ?2 AND EXISTS (SELECT 1 FROM boards WHERE board = ?1 AND tok = ?3)';
const SQL_TOUCH_OWN = 'UPDATE runs SET name_seed = ?, tries = ?, balls = ? WHERE board = ? AND pidh = ?';
const SQL_READ_TOK = 'SELECT tok FROM boards WHERE board = ?';

/** Steps 6-8 for one verified run. */
async function place(c: RunCtx, target: Target, run: SubmitRun, cand: Candidate): Promise<SubmitResult> {
  const { db } = c;
  const key = target.key;
  const tries = run.tries ?? 1;
  const balls = run.balls ?? null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const reads = [db.prepare(SQL_READ_BOARD).bind(key), db.prepare(SQL_READ_OWN).bind(key, c.pidh)];
    // The play population counts every verified run once per board and player, ranked or not (first attempt only).
    if (attempt === 0) reads.push(db.prepare(SQL_PLAY).bind(key, c.pidh, c.now));
    const readRes = await db.batch(reads);
    const [bRes, oRes] = readRes;
    if (attempt === 0) c.rows += rowsWritten(readRes.slice(2));
    const b = (bRes!.results[0] ?? null) as { ver: number; top: string; n: number; cleared: number; ai_beaten: number; hist: string | null } | null;
    const own = (oRes!.results[0] ?? null) as { t120: number | null } | null;
    const state: BoardState = b
      ? { exists: true, ver: b.ver, top: parseTop(b.top), n: b.n, cleared: b.cleared, aiBeaten: b.ai_beaten, hist: parseHist(b.hist) }
      : { exists: false, ver: 0, top: [], n: 0, cleared: 0, aiBeaten: 0, hist: parseHist(null) };
    const dec = decide({
      kind: target.kind, board: key, par: target.par, lite: c.lite && target.kind === 'L', now: c.now,
      pidh: c.pidh, nameSeed: c.nameSeed, device: cand.device,
      t120: cand.t120, gapUm: cand.gapUm, peakCn: cand.peakCn, replay: cand.replay, fp: cand.fp,
      prev: target.kind === 'D' ? run.prev : undefined, state, own,
    });
    if (!dec.write) {
      if (dec.touchOwn) {
        const r = await db.run(db.prepare(SQL_TOUCH_OWN).bind(c.nameSeed, tries, balls, key, c.pidh));
        c.rows += rowsWritten([r]);
      }
      return dec.result;
    }
    // Step 7: one batch; the runs writes only take effect if this request's boards update did.
    const stmts: D1PreparedStatement[] = [];
    if (!state.exists) stmts.push(db.prepare(SQL_NEW_BOARD).bind(key, target.par));
    const updIdx = stmts.length;
    stmts.push(db.prepare(SQL_UPDATE_BOARD).bind(
      c.tok, JSON.stringify(dec.top), dec.n, dec.cleared, dec.aiBeaten, dec.hist ? JSON.stringify(dec.hist) : null,
      dec.wr, target.par, c.now, key, state.ver,
    ));
    if (dec.runs) {
      const r = dec.runs;
      stmts.push(db.prepare(SQL_UPSERT_RUN).bind(
        key, c.pidh, c.nameSeed, r.t120, r.gapUm, r.peakCn, r.device, tries, balls, r.replay, r.created, c.tok,
      ));
    }
    if (dec.drop) stmts.push(db.prepare(SQL_DROP_REPLAY).bind(key, dec.drop, c.tok));
    let res: D1Result[];
    try {
      res = await db.batch(stmts);
    } catch (e) {
      if (await committed(c, key)) {
        c.rows += stmts.length;   // the batch's rows (an upper bound; its result was lost)
        return dec.result;
      }
      throw e;
    }
    c.rows += rowsWritten(res);
    if (res[updIdx]!.meta.changes === 1) return dec.result;
    // Step 8: ver conflict -> re-read and decide again, once.
  }
  return { board: run.board, status: 'deferred' };
}

/**
 * After a failed write batch: did it commit anyway (the error came from a lost response)? Only this request writes its
 * tok to this board's row, so finding it there means our boards update, and with it the guarded runs writes, went
 * through. Answering `deferred` then would make the client send the run again and a daily first send would be
 * counted twice. Costs one statement, only when the budget still has room for it and the counters write.
 */
async function committed(c: RunCtx, key: string): Promise<boolean> {
  const { db } = c;
  if (db.used + 1 + STATEMENTS_COUNTERS > STATEMENT_LIMIT) return false;
  try {
    const r = await db.first<{ tok: string | null }>(db.prepare(SQL_READ_TOK).bind(key));
    return r !== null && r.tok === c.tok;
  } catch {
    return false;
  }
}
