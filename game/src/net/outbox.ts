// Pending submissions: best per board, max 20, batching limits (GAME_DESIGN.md §7.9). Owner: O8.
// Pure functions (no I/O). src/net/api.ts owns the timing (120 s interval, pagehide, backoff) and applies
// the server's answers; this module decides WHAT is queued and WHAT goes into one request.
import type { DeviceTag } from '../sim/replay';
import { parseBoardKey, type SubmitRun, type SubmitRequest } from '../shared/api';
import { RANKED_MAX_TICKS, REPLAY_MAX_BYTES } from '../sim/constants';

/** replay / t120 are null only for a daily participation without success. */
export interface PendingRun {
  board: string; level: string; replay: string | null; t120: number | null; device: DeviceTag;
  tries?: number; balls?: string; prev?: number | null; nTicks: number; queuedAt: number;
}

export const OUTBOX_MAX = 20;            // boards kept in the outbox
export const BATCH_MAX_RUNS = 4;         // runs per request (D1: 50 statements per invocation)
export const BATCH_MAX_BYTES = 16 * 1024; // request body
export const BATCH_MAX_SUBSTEPS = 5400;  // sum(nTicks * 2), the first run of a batch is exempt
export const DAILY_BALLS = 5;

/** Bytes of the request envelope around `runs` with the longest possible secret / nameSeed. */
const ENVELOPE_BYTES = utf8Len(JSON.stringify({ v: 1, secret: 'x'.repeat(22), nameSeed: 65535, runs: [] } satisfies SubmitRequest));

function utf8Len(s: string): number {
  return new TextEncoder().encode(s).length;
}

export function isDailyBoard(board: string): boolean {
  return board.startsWith('D:');
}

/** dayIndex of a daily key `D:00023:…`, null for anything else. */
export function boardDay(board: string): number | null {
  const m = /^D:(\d{5}):/.exec(board);
  return m ? Number(m[1]) : null;
}

/** Substeps the Worker re-simulates for this run (0 for a participation without replay). */
export function runSubsteps(r: PendingRun): number {
  return r.replay === null ? 0 : Math.max(0, r.nTicks) * 2;
}

/** Replay length of a successful run with this score (§4.6: nTicks = ceil((score + 59) / 2)). */
export function nTicksForScore(score: number): number {
  return Math.ceil((score + 59) / 2);
}

/** a is strictly better than b: a smaller time; any time beats a participation without success. */
export function isBetter(a: number | null, b: number | null): boolean {
  if (a === null) return false;
  return b === null || a < b;
}

/** Longest base64url text of a replay within REPLAY_MAX_BYTES (6 KB -> 8192 characters). */
export const REPLAY_MAX_CHARS = Math.ceil((REPLAY_MAX_BYTES * 4) / 3);
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const BALLS_RE = /^[XOGC-]{5}$/;
const isInt = (x: unknown, lo: number, hi: number): x is number =>
  typeof x === 'number' && Number.isInteger(x) && x >= lo && x <= hi;

/**
 * Whether the run can be sent and ranked at all. Mirrors the Worker's request shape check (a single
 * malformed run makes the whole request a 400, which would also lose the good runs batched with it)
 * and drops what the Worker would refuse anyway (badBoard key, tooLong, oversized replay).
 */
export function isSendable(r: PendingRun): boolean {
  if (typeof r !== 'object' || r === null) return false;
  if (typeof r.board !== 'string' || r.board.length > 64 || parseBoardKey(r.board) === null) return false;
  if (typeof r.level !== 'string' || r.level.length === 0 || r.level.length > 16) return false;
  if (!isInt(r.device, 0, 5)) return false;
  const daily = isDailyBoard(r.board);
  if (daily) {
    if (r.tries !== undefined && !isInt(r.tries, 0, DAILY_BALLS)) return false;
    if (r.balls !== undefined && (typeof r.balls !== 'string' || !BALLS_RE.test(r.balls))) return false;
    if (r.prev !== undefined && r.prev !== null && !isInt(r.prev, 0, 1e6)) return false;
  }
  if (r.replay === null || r.t120 === null) {
    // Only a daily participation without success may come without a replay (§7.7).
    return daily && r.replay === null && r.t120 === null;
  }
  if (typeof r.replay !== 'string' || r.replay.length > REPLAY_MAX_CHARS || !B64URL_RE.test(r.replay)) return false;
  return isInt(r.t120, 0, 1e6) && isInt(r.nTicks, 1, RANKED_MAX_TICKS);
}

/**
 * A daily run whose best cannot be ranked (a success slower than 44.5 s, or a replay above 6 KB) still
 * counts the player: it becomes a participation without success (replay / t120 null). Anything else is
 * returned unchanged.
 */
export function dailyFallback(r: PendingRun): PendingRun {
  if (!isDailyBoard(r.board) || r.replay === null || isSendable(r)) return r;
  const p: PendingRun = { ...r, replay: null, t120: null, nTicks: 0 };
  return isSendable(p) ? p : r;
}

/**
 * Keeps the best run per board (max 20 boards). Returns a new array; the input is not modified.
 * - Level boards: the new run replaces the queued one only when it is strictly faster.
 * - Daily boards: the faster run's replay / time win, the more advanced rack (more balls used) wins
 *   for tries / balls, and `prev` is taken from the newer entry.
 * - When a 21st board arrives, the oldest queued entry is evicted.
 */
export function enqueueRun(outbox: readonly PendingRun[], r: PendingRun): PendingRun[] {
  if (!isSendable(r)) return outbox.slice();
  const i = outbox.findIndex((p) => p.board === r.board);
  if (i >= 0) {
    const old = outbox[i]!;
    const next = outbox.slice();
    if (isDailyBoard(r.board)) {
      const best = isBetter(r.t120, old.t120) ? r : old;
      const rack = (r.tries ?? 0) >= (old.tries ?? 0) ? r : old;
      const merged: PendingRun = {
        board: r.board, level: best.level, replay: best.replay, t120: best.t120, device: best.device,
        nTicks: best.nTicks, queuedAt: Math.min(old.queuedAt, r.queuedAt),
      };
      if (rack.tries !== undefined) merged.tries = rack.tries;
      if (rack.balls !== undefined) merged.balls = rack.balls;
      if (r.prev !== undefined) merged.prev = r.prev;
      next[i] = merged;
    } else if (isBetter(r.t120, old.t120)) {
      next[i] = { ...r };
    }
    return next;
  }
  const next = [...outbox, { ...r }];
  while (next.length > OUTBOX_MAX) {
    let oldest = 0;
    for (let k = 1; k < next.length; k++) if (next[k]!.queuedAt < next[oldest]!.queuedAt) oldest = k;
    next.splice(oldest, 1);
  }
  return next;
}

/** The wire form of a queued run (drops nTicks / queuedAt; `prev` only on daily boards). */
export function toSubmitRun(r: PendingRun): SubmitRun {
  const s: SubmitRun = { board: r.board, level: r.level, replay: r.replay, t120: r.t120, device: r.device };
  if (isDailyBoard(r.board)) {
    if (r.tries !== undefined) s.tries = r.tries;
    if (r.balls !== undefined) s.balls = r.balls;
    if (r.prev !== undefined) s.prev = r.prev;
  }
  return s;
}

export interface BatchOptions {
  /** lite mode (§7.8 10): level boards stay queued, daily boards are still sent. */
  skipLevels?: boolean;
  /** Boards already in flight in another request. */
  exclude?: ReadonlySet<string>;
}

/** Send order: daily boards first (they expire after a day), then oldest first. */
function sendOrder(outbox: readonly PendingRun[]): PendingRun[] {
  return outbox.slice().sort((a, b) =>
    (isDailyBoard(a.board) ? 0 : 1) - (isDailyBoard(b.board) ? 0 : 1) || a.queuedAt - b.queuedAt);
}

/**
 * Takes the next batch: up to 4 runs, 16 KB body, sum(nTicks*2) <= 5400 (the first run is exempt).
 * A run that does not fit is skipped and later (smaller) runs are still considered.
 */
export function takeBatch(outbox: readonly PendingRun[], opts: BatchOptions = {}): SubmitRun[] {
  const out: SubmitRun[] = [];
  let bytes = ENVELOPE_BYTES;
  let substeps = 0;
  for (const r of sendOrder(outbox)) {
    if (out.length >= BATCH_MAX_RUNS) break;
    if (!isSendable(r) || opts.exclude?.has(r.board)) continue;
    if (opts.skipLevels && !isDailyBoard(r.board)) continue;
    const s = toSubmitRun(r);
    const b = utf8Len(JSON.stringify(s)) + (out.length > 0 ? 1 : 0);
    const sub = runSubsteps(r);
    if (bytes + b > BATCH_MAX_BYTES) continue;
    if (out.length > 0 && substeps + sub > BATCH_MAX_SUBSTEPS) continue;
    out.push(s);
    bytes += b;
    substeps += sub;
  }
  return out;
}

// ---- daily (§7.9: one send a day, a second one only when the day's record improved) ----

export type DailyBall = 'ok' | 'gold' | 'crown' | 'fail' | null;

/** "XOGC-" (X fail, O ok, G gold, C crown, - unused), always 5 characters. */
export function ballsString(balls: readonly DailyBall[]): string {
  let s = '';
  for (let i = 0; i < DAILY_BALLS; i++) {
    const b = balls[i] ?? null;
    s += b === 'fail' ? 'X' : b === 'ok' ? 'O' : b === 'gold' ? 'G' : b === 'crown' ? 'C' : '-';
  }
  return s;
}

/** Balls used so far. */
export function ballsUsed(balls: readonly DailyBall[]): number {
  let n = 0;
  for (let i = 0; i < DAILY_BALLS; i++) if ((balls[i] ?? null) !== null) n++;
  return n;
}

/** The part of SaveV1.daily this module reads (structurally the same object). */
export interface DailySendState {
  dayIndex: number; balls: readonly DailyBall[]; bestSub: number | null; bestReplay: string | null;
  submitted: 'none' | 'partial' | 'final'; lastSentT120: number | null;
}

/** `prev` for a send of `state`'s day: omitted before the first accepted send, else the last accepted t120. */
export function dailyPrev(state: DailySendState): number | null | undefined {
  return state.submitted === 'none' ? undefined : state.lastSentT120;
}

/** §7.9: send when nothing was sent yet today, or after a partial send when the record improved. */
export function dailySendDue(state: DailySendState): boolean {
  if (ballsUsed(state.balls) === 0) return false;
  if (state.submitted === 'none') return true;
  if (state.submitted === 'partial') return isBetter(state.bestSub, state.lastSentT120);
  return false;
}

/**
 * The daily run to queue now, or null when §7.9 says nothing is due.
 * `board` is dailyBoardKey(dayIndex, levelHash) and `level` the daily id (e.g. "d:17").
 * A best run that cannot be ranked (no replay because it exceeded 6 KB, or longer than 45 s) is
 * reported as a participation without success so the player is still counted.
 */
export function dailyPendingRun(state: DailySendState, ctx: { board: string; level: string; device: DeviceTag; now: number }): PendingRun | null {
  if (boardDay(ctx.board) !== state.dayIndex || !dailySendDue(state)) return null;
  const used = ballsUsed(state.balls);
  let replay: string | null = null;
  let t120: number | null = null;
  let nTicks = 0;
  if (state.bestSub !== null && state.bestReplay !== null && nTicksForScore(state.bestSub) <= RANKED_MAX_TICKS) {
    replay = state.bestReplay;
    t120 = state.bestSub;
    nTicks = nTicksForScore(state.bestSub);
  }
  const r: PendingRun = {
    board: ctx.board, level: ctx.level, replay, t120, device: ctx.device,
    tries: used, balls: ballsString(state.balls), nTicks, queuedAt: ctx.now,
  };
  const prev = dailyPrev(state);
  if (prev !== undefined) r.prev = prev;
  return r;
}

/** A level PB to queue (board = levelBoardKey(id, levelHash)). nTicks follows from the score (§4.6). */
export function levelPendingRun(board: string, level: string, replay: string, score: number, device: DeviceTag, now: number): PendingRun {
  return { board, level, replay, t120: score, device, nTicks: nTicksForScore(score), queuedAt: now };
}
