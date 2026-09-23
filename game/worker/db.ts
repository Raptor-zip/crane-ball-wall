// D1 access helpers, the per-request statement budget and board-row codecs (GAME_DESIGN.md §7.7, §7.8). Owner: O9.
import { BOARD_TOP_N, HIST_BINS, type ApiError, type BoardRow } from '../src/shared/api';
import { isFingerprint } from './dup';

/** D1 free plan: 50 statements per invocation; we stay at or below this (§7.8 step 1). */
export const STATEMENT_LIMIT = 49;
/** Worst case of one run: read 2 + write 4, and the same again for one conflict retry. */
export const STATEMENTS_PER_RUN = 12;
/** The counters flush at the end of a submit. */
export const STATEMENTS_COUNTERS = 1;

/**
 * D1 wrapper that counts every statement it issues (one per statement inside a batch).
 * All Worker D1 access goes through it so the budget in §7.8 step 1 is exact.
 */
export class Db {
  used = 0;
  constructor(readonly d1: D1Database) {}

  prepare(sql: string): D1PreparedStatement {
    return this.d1.prepare(sql);
  }
  async first<T>(stmt: D1PreparedStatement): Promise<T | null> {
    this.used += 1;
    return stmt.first<T>();
  }
  async all<T>(stmt: D1PreparedStatement): Promise<T[]> {
    this.used += 1;
    return (await stmt.all<T>()).results;
  }
  async run(stmt: D1PreparedStatement): Promise<D1Result> {
    this.used += 1;
    return stmt.run();
  }
  async batch<T = unknown>(stmts: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.used += stmts.length;
    return this.d1.batch<T>(stmts);
  }
  /** "used + 12 + 1 <= 49" before starting the next run (§7.8 step 1). */
  canStartRun(): boolean {
    return this.used + STATEMENTS_PER_RUN + STATEMENTS_COUNTERS <= STATEMENT_LIMIT;
  }
}

/** Rows written according to D1 (what the free plan bills). */
export function rowsWritten(results: readonly D1Result[]): number {
  let n = 0;
  for (const r of results) n += Number(r.meta?.rows_written ?? r.meta?.changes ?? 0) || 0;
  return n;
}

// ---- boards rows ----

/**
 * A row of `boards.top` as stored: the wire BoardRow plus the fingerprint of the run's inputs (worker/dup.ts).
 * Rows written before the fingerprint existed have no 7th element. Answers carry BoardRow only (publicRow).
 */
export type TopRow = [pidh: string, nameSeed: number, t120: number, gapUm: number, device: number, created: number, fp?: string];

/** Parsed `boards.top`: at most 100 rows, ascending by (t120, created). Bad JSON reads as empty. */
export function parseTop(json: string | null | undefined): TopRow[] {
  if (!json) return [];
  try {
    const v: unknown = JSON.parse(json);
    if (!Array.isArray(v)) return [];
    const out: TopRow[] = [];
    for (const r of v) {
      if (Array.isArray(r) && (r.length === 6 || r.length === 7) && typeof r[0] === 'string' && typeof r[2] === 'number') {
        const row: TopRow = [r[0], Number(r[1]) | 0, r[2], Number(r[3]), Number(r[4]) | 0, Number(r[5])];
        if (isFingerprint(r[6])) row.push(r[6]);
        out.push(row);
      }
    }
    return out.slice(0, BOARD_TOP_N);
  } catch {
    return [];
  }
}

/** The wire form of a stored row (§7.7 BoardRow: the fingerprint stays on the server). */
export function publicRow(r: TopRow): BoardRow {
  return [r[0], r[1], r[2], r[3], r[4], r[5]];
}

/** Parsed daily `boards.hist` (always 150 non-negative integers). */
export function parseHist(json: string | null | undefined): number[] {
  const h = new Array<number>(HIST_BINS).fill(0);
  if (!json) return h;
  try {
    const v: unknown = JSON.parse(json);
    if (Array.isArray(v)) for (let i = 0; i < HIST_BINS; i++) h[i] = Math.max(0, Number(v[i]) | 0);
  } catch {
    // keep zeros
  }
  return h;
}

/** cutoff of §7.7: the 100th time, or null while fewer than 100 rows. */
export function cutoffOf(top: readonly TopRow[]): number | null {
  return top.length >= BOARD_TOP_N ? top[BOARD_TOP_N - 1]![2] : null;
}

/** D1 returns BLOB columns as number[] (ArrayBuffer / Uint8Array tolerated too). */
export function blobBytes(v: unknown): Uint8Array | null {
  if (v == null) return null;
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (Array.isArray(v)) return Uint8Array.from(v as number[]);
  return null;
}

/** 16 hex digits of randomness: the optimistic-lock token of one request (§7.8 step 7). */
export function randomTok(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

// ---- HTTP helpers ----

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

export function apiError(status: number, error: ApiError['error'], headers: Record<string, string> = {}): Response {
  const body: ApiError = { error };
  return json(body, status, { 'Cache-Control': 'no-store', ...headers });
}
