// HTTP API wire types and ranking-key helpers (GAME_DESIGN.md §7.7). Owner: O9.
// Shared by the client (src/net) and the Worker. Must not use the DOM.
import { RANKED_MAX_TICKS, SIM_VERSION } from '../sim/constants';

/**
 * One ranking row: [pidh, nameSeed, t120, gapUm, device, created]. Also used by the UI (re-exported from src/ui/ui.ts).
 * gapUm is the minimum ball-wall clearance in µm; it is -1 on levels without walls (1-1), where there is no clearance.
 */
export type BoardRow = [pidh: string, nameSeed: number, t120: number, gapUm: number, device: number, created: number];

// ---- Limits (§7.7, §7.8) ----
export const SUBMIT_MAX_BYTES = 16384;      // request body
export const SUBMIT_MAX_RUNS = 4;           // runs per request (D1: <= 50 statements per invocation)
export const BOARD_TOP_N = 100;             // rows kept in boards.top
export const BOOT_TOP_N = 10;               // rows sent by /api/boot
export const HIST_BINS = 150;               // daily histogram: 0.2 s bins over 0..30 s
export const HIST_BIN_SUB = 24;             // 0.2 s in substeps (1/120 s)
export const NO_WALL_GAP_UM = -1;           // BoardRow.gapUm on levels without walls
/** Largest t120 of a ranked run (nTicks = ceil((t120 + 59) / 2) <= RANKED_MAX_TICKS): 5341. Bounds `prev`. */
export const MAX_RANKED_T120 = 2 * RANKED_MAX_TICKS - 59;

// ---- GET /api/boot?day=<dayIndex> ----
export interface BootBoard {
  key: string; n: number; aiBeaten: number; par: number;
  cutoff: number | null;          // 100th time, null while fewer than 100 rows
  top: BoardRow[];                // top 10 only
  wr: string | null;              // base64url replay of rank 1
}
export interface BootDaily {
  key: string;                    // "" only while the Worker has no daily pool (development builds)
  n: number; cleared: number; aiBeaten: number; par: number;
  top: BoardRow[];
  hist: number[];                 // 150 bins of 0.2 s (0..30 s, last bin >= 29.8 s)
  wr: string | null;
}
export interface BootResponse {
  v: 1; sim: number; now: number; day: number; lite: boolean; readOnly: boolean;
  boards: Record<string, BootBoard>;   // keyed by level id ("2-2")
  daily: BootDaily;
}

// ---- POST /api/submit ----
export interface SubmitRun {
  board: string; level: string;
  replay: string | null;          // null only for a daily participation without success
  t120: number | null;
  device: number;                 // DeviceTag
  tries?: number;                 // daily only
  balls?: string;                 // daily only, e.g. "XOOCX" (X fail, O ok, G gold, C crown, - unused)
  prev?: number | null;           // daily only; omitted on the first send of the day
}
export interface SubmitRequest { v: 1; secret: string; nameSeed: number; runs: SubmitRun[] }
export type SubmitStatus = 'accepted' | 'unranked' | 'notBetter' | 'rejected' | 'deferred';
/**
 * `dup`: the run repeats (or nearly repeats) the inputs of another player's run in the top 100. Public replays
 * (boot `wr`, /api/ghost, challenge links) must not be re-submittable under fresh identities.
 */
export type RejectReason = 'mismatch' | 'stale' | 'badReplay' | 'tooLong' | 'badBoard' | 'lite' | 'dup';
export interface SubmitResult {
  board: string; status: SubmitStatus;
  reason?: RejectReason;          // only with status 'rejected'
  rank?: number | null;           // level: exact rank in the top 100 (null outside); daily: exact in the top 100, estimated from hist outside
  n?: number; cutoff?: number | null;
  aiBeaten?: boolean;             // level boards: this run is faster than the AI (t120 < par)
  pct?: number;                   // daily boards with a success: "top n %" (pctFromHist)
}
export interface SubmitResponse { ok: boolean; lite: boolean; results: SubmitResult[] }

// ---- GET /api/ghost/:key/:rank ----
export interface GhostResponse { key: string; rank: number; pidh: string; nameSeed: number; t120: number; replay: string }

// ---- GET /api/board/:key ----
export interface BoardResponse { key: string; n: number; aiBeaten: number; par: number; cutoff: number | null; top: BoardRow[] }

/**
 * Error body of 400 / 403 / 404 / 405 / 413 / 415 / 429 / 500 / 503 answers.
 * 403 `forbidden`: a submit from another site; 415 `badRequest`: a submit whose Content-Type is not application/json.
 */
export interface ApiError { error: 'badRequest' | 'forbidden' | 'notFound' | 'method' | 'tooLarge' | 'rateLimited' | 'internal' | 'READ_ONLY' }

// ---- Ranking keys (§7.7 "ランキングのキー") ----
export type BoardKey =
  | { kind: 'L'; levelId: string; levelHash: string; sim: number }
  | { kind: 'D'; dayIndex: number; levelHash: string; sim: number };

/** `L:<id>:<levelHash>:s<SIM_VERSION>` */
export function levelBoardKey(levelId: string, levelHash: string, sim: number = SIM_VERSION): string {
  return `L:${levelId}:${levelHash}:s${sim}`;
}

/** `D:<dayIndex, 5 digits>:<levelHash>:s<SIM_VERSION>` */
export function dailyBoardKey(dayIndex: number, levelHash: string, sim: number = SIM_VERSION): string {
  return `D:${String(dayIndex).padStart(5, '0')}:${levelHash}:s${sim}`;
}

/** Parses a ranking key; returns null when malformed. */
export function parseBoardKey(key: string): BoardKey | null {
  if (key.length > 40) return null;
  const p = key.split(':');
  if (p.length !== 4) return null;
  const [kind, a, levelHash, s] = p as [string, string, string, string];
  if (!/^[0-9a-f]{8}$/.test(levelHash) || !/^s[1-9][0-9]{0,3}$/.test(s)) return null;
  const sim = Number(s.slice(1));
  if (kind === 'L' && /^[1-5]-[1-9]$/.test(a)) return { kind: 'L', levelId: a, levelHash, sim };
  if (kind === 'D' && /^[0-9]{5}$/.test(a)) return { kind: 'D', dayIndex: Number(a), levelHash, sim };
  return null;
}

// ---- Daily histogram (§7.7 boards.hist, §7.13 "上位 n%") ----

/** Histogram bin of a time: 0.2 s bins, the last one (149) collects everything >= 29.8 s. */
export function histBin(t120: number): number {
  return Math.max(0, Math.min(HIST_BINS - 1, Math.floor(t120 / HIST_BIN_SUB)));
}

/**
 * "Top n %" of §7.13: 100 * (people in faster bins + people in my bin / 2) / cleared, rounded to 1 decimal.
 * `hist` must already contain the player. Returns null when nobody has cleared.
 * The client shows values below 1 as "上位 1%".
 */
export function pctFromHist(hist: readonly number[], t120: number, cleared: number): number | null {
  if (!(cleared > 0)) return null;
  const b = histBin(t120);
  let faster = 0;
  for (let i = 0; i < b; i++) faster += hist[i] ?? 0;
  const pct = (100 * (faster + (hist[b] ?? 0) / 2)) / cleared;
  return Math.min(100, Math.round(pct * 10) / 10);
}

// Identity (§7.7 "識別"): pidh = first 16 hex digits of SHA-256 over the 16 raw secret bytes.
// Implemented once in src/shared/names.ts (pidhFromSecret / isValidSecret), used by the client and the Worker.
