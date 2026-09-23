// Level histogram, rank estimates and the results-card standing (GAME_DESIGN.md §7.7 「面のヒストグラムと順位の推定」). Owner: O9.
// Shared by the Worker (submit answers), src/net, src/core and src/ui, so the server and every screen give the same
// number for the same data. Pure: no DOM, no clock.
import { BOARD_TOP_N, BOOT_TOP_N, MAX_RANKED_T120, histBin, type BoardRow, type SubmitStatus } from './api';

// ---- Level histogram layout ----

export const LEVEL_HIST_BINS = 153;

/** Level histogram bin: 0.05 s below 4 s (0-79), 0.2 s below 12 s (80-119), 1 s after (120-152; 152 holds >= 44 s). */
export function levelBin(t120: number): number {
  const t = Math.max(0, Math.floor(t120));
  return t < 480 ? Math.floor(t / 6) : t < 1440 ? 80 + Math.floor((t - 480) / 24) : Math.min(152, 120 + Math.floor((t - 1440) / 120));
}

/** [lo, hi) of a bin in t120. Bin 152 ends at MAX_RANKED_T120 + 1 (5342). The ranges tile 0..5341 exactly. */
export function levelBinRange(b: number): [number, number] {
  if (b < 80) return [6 * b, 6 * b + 6];
  if (b < 120) return [480 + 24 * (b - 80), 504 + 24 * (b - 80)];
  if (b < 152) return [1440 + 120 * (b - 120), 1560 + 120 * (b - 120)];
  return [5280, MAX_RANKED_T120 + 1];
}

// ---- Histogram arrays (wire and DB: dense, trailing zeros trimmed) ----

/** A wire/DB histogram as a dense array of `bins` counts; null when malformed (not an array, too long, a negative or non-integer entry). */
export function padHist(h: unknown, bins: number): number[] | null {
  if (!Array.isArray(h) || h.length > bins) return null;
  const out = new Array<number>(bins).fill(0);
  for (let i = 0; i < h.length; i++) {
    const x: unknown = h[i];
    if (typeof x !== 'number' || !Number.isSafeInteger(x) || x < 0) return null;
    out[i] = x;
  }
  return out;
}

/** Drops trailing zeros ([] for an empty histogram). */
export function trimHist(h: readonly number[]): number[] {
  let end = h.length;
  while (end > 0 && !(h[end - 1]! > 0)) end--;
  return h.slice(0, end);
}

export function sumHist(h: readonly number[]): number {
  let s = 0;
  for (const x of h) s += x;
  return s;
}

// ---- Level rank ----

const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));

/** The part of bin b below t, (t − lo) / (hi − lo), kept in [0, 1] (the estimator spreads a bin's count evenly). */
function binShare(b: number, t: number): number {
  const [lo, hi] = levelBinRange(b);
  return clamp((t - lo) / (hi - lo), 0, 1);
}

/**
 * Rank of time `t` against a level histogram (GAME_DESIGN.md §7.7 「面のヒストグラム」).
 * `own` = the time this player is already counted with in `hist` (removed first; null when not counted).
 * - t < cutoff, or cutoff null (the top-100 region; a preview only, the server has the exact rank there):
 *     f = Σ_{i<b} h[i] + h[b]·(t−lo_b)/(hi_b−lo_b);  rank = clamp(floor(f)+1, 1, cutoff === null ? n : min(100, n)).
 *     Returns null when the histogram is empty.
 * - t >= cutoff: every counted time below the cutoff is in `top`. bc = levelBin(cutoff); K = max(0, Σ_{i<=bc} h[i] − 100).
 *     b == bc: f = K·(t−cutoff)/(hi_bc−cutoff);  b > bc: f = K + Σ_{bc<i<b} h[i] + h[b]·(t−lo_b)/(hi_b−lo_b).
 *     rank = clamp(101 + floor(f), 101, max(101, n)). Returns null when Σh < 100 (the hist does not cover the top 100 yet).
 * n = Σh (after removing `own`) + 1. The result is monotonic in t, continuous at bin edges, and a tie with the cutoff gives 101.
 * `hist` may be short (trimmed): missing bins count 0; bad entries count 0; entries past LEVEL_HIST_BINS are ignored.
 */
export function estimateLevelRank(hist: readonly number[], cutoff: number | null, t: number, own: number | null): { rank: number; n: number } | null {
  const h = new Array<number>(LEVEL_HIST_BINS).fill(0);
  const len = Math.min(LEVEL_HIST_BINS, hist.length);
  for (let i = 0; i < len; i++) h[i] = Math.max(0, Math.floor(Number(hist[i]) || 0));
  if (own !== null) {
    const ob = levelBin(own);
    if (h[ob]! > 0) h[ob]! -= 1;
  }
  const total = sumHist(h);
  const n = total + 1;
  const b = levelBin(t);
  if (cutoff === null || t < cutoff) {
    if (total === 0) return null;
    let f = h[b]! * binShare(b, t);
    for (let i = 0; i < b; i++) f += h[i]!;
    return { rank: clamp(Math.floor(f) + 1, 1, cutoff === null ? n : Math.min(BOARD_TOP_N, n)), n };
  }
  if (total < BOARD_TOP_N) return null;
  const bc = levelBin(cutoff);
  let upTo = 0;
  for (let i = 0; i <= bc; i++) upTo += h[i]!;
  const K = Math.max(0, upTo - BOARD_TOP_N);
  let f: number;
  if (b === bc) {
    const hi = levelBinRange(bc)[1];
    f = hi > cutoff ? K * clamp((t - cutoff) / (hi - cutoff), 0, 1) : 0;
  } else {
    f = K + h[b]! * binShare(b, t);
    for (let i = bc + 1; i < b; i++) f += h[i]!;
  }
  return { rank: clamp(BOARD_TOP_N + 1 + Math.floor(f), BOARD_TOP_N + 1, Math.max(BOARD_TOP_N + 1, n)), n };
}

/** "上位 x%" of a level: rank/n rounded UP to one decimal, 0.1..100 (never flattering). Shown with fmtPct. */
export function levelPct(rank: number, n: number): number {
  return Math.min(100, Math.max(0.1, Math.ceil((1000 * rank) / n) / 10));
}

// ---- Daily rank ----

/**
 * Daily rank outside the top 100, estimated from the 150-bin histogram (the same half-bin rule as pctFromHist).
 * Moved from worker/routes/submit.ts (estimateRank); same result. Missing bins of a short (trimmed) array count 0.
 */
export function estimateDailyRank(hist: readonly number[], t: number): number {
  const b = histBin(t);
  let faster = 0;
  for (let i = 0; i < b; i++) faster += hist[i] ?? 0;
  return Math.max(BOARD_TOP_N + 1, Math.floor(faster + (hist[b] ?? 0) / 2) + 1);
}

// ---- Results card ----

/** The stamp for a confirmed answer: only `accepted` with rank <= 100. */
export function stampKind(status: SubmitStatus, rank: number | null, was: number | null): 'in' | 'up' | 'wr' | null {
  if (status !== 'accepted' || rank === null || rank > BOARD_TOP_N) return null;
  if (rank === 1) return 'wr';                       // copy: was === 1 ? 世界記録更新！ : 世界一！
  if (was === null || was > BOARD_TOP_N) return 'in';
  return was > rank ? 'up' : null;
}

/** A board as the client sees it. complete: `top` is the whole top 100 (BoardResponse), not the first 10 (BootBoard). */
export interface BoardSnapshot { top: readonly BoardRow[]; cutoff: number | null; hist: readonly number[] | null; complete: boolean }
export interface LocalRank { rank: number | null; n: number | null; pct: number | null; candidate: boolean; exact: boolean }

/**
 * Where time t of player `me` would stand in `b`. `counted` = the player's plays time (LevelProgress.sentSub) or null.
 * others = top without me; k = rows of others with t120 <= t (the earlier submission stays ahead on ties).
 * - me's own row in top has exactly t120 === t: rank = its position, candidate = true, exact = true.
 * - me's own row in top is slower than t (a PB): rank = k + 1, candidate = true, exact = false. Every row with t120 <= t
 *   is ahead of my row, so k <= its index and the slot is known even when my row is the last one of the boot top 10.
 * - k < others.length, or the list is complete [b.complete || top.length < BOOT_TOP_N] and k + 1 <= 100 (the server's
 *   own "enters the top 100" rule): rank = k + 1, candidate = true, exact = false.
 * - else if cutoff === null || t < cutoff: candidate = true, rank = estimate clamped to [others.length + 1, 100] (null without hist).
 * - else: candidate = false, rank = estimate (>= 101) or null, pct = levelPct.
 * n = estimate n when a hist exists (at least rank), else null.
 */
export function localRank(b: BoardSnapshot, t: number, me: string, counted: number | null): LocalRank {
  const ownIdx = b.top.findIndex((r) => r[0] === me);
  const others = ownIdx >= 0 ? b.top.filter((_, i) => i !== ownIdx) : b.top;
  let k = 0;
  while (k < others.length && others[k]![2] <= t) k++;
  const e = b.hist ? estimateLevelRank(b.hist, b.cutoff, t, counted) : null;
  const withN = (rank: number | null, candidate: boolean, exact: boolean): LocalRank => {
    const n = e ? Math.max(e.n, rank ?? 0) : null;
    const pct = !candidate && rank !== null && n !== null ? levelPct(rank, n) : null;
    return { rank, n, pct, candidate, exact };
  };
  if (ownIdx >= 0 && b.top[ownIdx]![2] === t) return withN(ownIdx + 1, true, true);
  if (ownIdx >= 0 && t < b.top[ownIdx]![2]) return withN(k + 1, true, false);
  const complete = b.complete || b.top.length < BOOT_TOP_N;
  if (k < others.length || (complete && k + 1 <= BOARD_TOP_N)) return withN(k + 1, true, false);
  if (b.cutoff === null || t < b.cutoff) {
    return withN(e ? clamp(e.rank, others.length + 1, BOARD_TOP_N) : null, true, false);
  }
  return withN(e ? e.rank : null, false, false);
}

/** What the results card shows under the time (optional ResultsData.standing, GAME_DESIGN.md §9.4). */
export type StandingPhase = 'local' | 'pending' | 'confirmed' | 'queued' | 'held';
export interface Standing {
  runKey: string;            // `${board}:${t120}` of the time the row is about; the stamp animates once per results card
  forPb: boolean;            // false: a non-PB clear shows the PB's standing (muted, prefixed 自己ベスト)
  rank: number | null;       // 1-100 exact position in top; >= 101 estimate from the hist; null = unknown
  n: number | null;          // players counted (incl. me)
  pct: number | null;        // only when rank >= 101
  was: number | null;        // standing before this run (<= 100 exact; >= 101 estimate); local previews only fill it between estimates
  exact: boolean;            // rank <= 100 and taken from server data (a confirmed answer, or my own row in a server list)
  candidate: boolean;        // local judgement: the time can enter the top 100
  phase: StandingPhase;      // local: estimate only; pending: rank-in send on its way; confirmed: server answered;
                             // queued: not sent yet (offline, 429, deferred); held: lite / READ_ONLY, not counted today
  stamp: 'in' | 'up' | 'wr' | null;   // only with phase 'confirmed' (stampKind)
}
