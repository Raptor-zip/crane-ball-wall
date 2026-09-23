// Rate limiting (RL_SUBMIT / RL_READ with in-memory token-bucket fallback), the isolate's usage counters and the
// soft / lite safety valves (GAME_DESIGN.md §7.7, §7.8 steps 9, 9b and 10, §7.10). Owner: O9.
import type { Env } from './index';
import type { Db } from './db';

// ---- Clock ----

let clockOverride: (() => number) | null = null;

/** Server time in ms. Tests can pin it with setClockForTest. */
export function nowMs(): number {
  return clockOverride ? clockOverride() : Date.now();
}

/** Test hook: pins the clock (null restores Date.now). */
export function setClockForTest(fn: (() => number) | null): void {
  clockOverride = fn;
}

/** JST calendar date "YYYY-MM-DD" (the counters key suffix). */
export function jstDate(ms: number): string {
  return new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

// ---- Rate limiting (§7.7 "レート制限") ----

export type LimitKind = 'submit' | 'read';

/** Per 60 s, per client (rateKey: an IPv4 address or an IPv6 /64). Must match wrangler.jsonc "ratelimits". */
export const RATE = { submit: 6, read: 30 } as const;
const PERIOD_MS = 60_000;
const BUCKETS_MAX = 5000;

interface Bucket { tokens: number; at: number }
const buckets: Record<LimitKind, Map<string, Bucket>> = { submit: new Map(), read: new Map() };
const fallbackLogged: Record<LimitKind, boolean> = { submit: false, read: false };

/**
 * In-memory token bucket of this isolate: capacity RATE[kind], refilled continuously over 60 s.
 * The map is kept in least-recently-used order. When it is full, buckets that have refilled completely are dropped
 * first (nothing is lost: a new bucket starts full), then the least recently used ones: a flood of new keys never
 * resets the bucket of a client that is being throttled right now.
 */
function takeToken(kind: LimitKind, key: string, now: number): boolean {
  const cap = RATE[kind];
  const map = buckets[kind];
  let b = map.get(key);
  if (b) {
    map.delete(key);   // re-inserted below: most recently used last
  } else {
    if (map.size >= BUCKETS_MAX) {
      for (const [k, v] of map) if (now - v.at >= PERIOD_MS) map.delete(k);
      for (const k of map.keys()) {
        if (map.size < BUCKETS_MAX) break;
        map.delete(k);
      }
    }
    b = { tokens: cap, at: now };
  }
  map.set(key, b);
  b.tokens = Math.min(cap, b.tokens + ((now - b.at) * cap) / PERIOD_MS);
  b.at = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

/**
 * true if the request may proceed. Uses the Workers Rate Limiting binding; when it is missing or fails,
 * falls back to the per-isolate token bucket and logs that once per isolate (M12 checks this in `wrangler tail`).
 */
export async function allowRequest(env: Env, kind: LimitKind, key: string): Promise<boolean> {
  const binding = kind === 'submit' ? env.RL_SUBMIT : env.RL_READ;
  if (binding && typeof binding.limit === 'function') {
    try {
      const { success } = await binding.limit({ key });
      return success;
    } catch (e) {
      logFallback(kind, `binding error: ${String(e)}`);
    }
  } else {
    logFallback(kind, 'no binding');
  }
  return takeToken(kind, key, nowMs());
}

function logFallback(kind: LimitKind, reason: string): void {
  if (fallbackLogged[kind]) return;
  fallbackLogged[kind] = true;
  console.log(JSON.stringify({ evt: 'rl-fallback', kind, reason }));
}

/** The rate-limit key of a request: rateKey(CF-Connecting-IP), or 'local' without the header (tests, wrangler dev). */
export function clientKey(req: Request): string {
  const ip = req.headers.get('CF-Connecting-IP');
  return ip === null ? 'local' : rateKey(ip);
}

/**
 * Rate-limit key of an address. IPv4 stays as it is (/32). IPv6 is cut to its /64: one line or VPS normally owns a
 * whole /64, so keying on the full address would give every interface id of it its own budget. IPv4-mapped IPv6
 * (::ffff:a.b.c.d) counts as the IPv4 address. Anything unparsable is used verbatim.
 */
export function rateKey(ip: string): string {
  let a = ip.trim().toLowerCase();
  if (!a.includes(':')) return a;
  if (a.startsWith('[') && a.endsWith(']')) a = a.slice(1, -1);
  const zone = a.indexOf('%');
  if (zone >= 0) a = a.slice(0, zone);
  // A trailing dotted quad (::ffff:192.0.2.1, 64:ff9b::192.0.2.1) becomes the last two hextets.
  let v4: string | null = null;
  const dq = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (dq) {
    const o = dq.slice(2, 6).map(Number);
    if (o.some((x) => x > 255)) return a;
    v4 = o.join('.');
    a = `${dq[1]}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const halves = a.split('::');
  if (halves.length > 2) return a;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return a;
  const groups = [...head, ...new Array<string>(missing).fill('0'), ...tail];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return a;
  const hex = groups.map((g) => g.padStart(4, '0'));
  if (hex.slice(0, 5).every((g) => g === '0000') && hex[5] === 'ffff') {
    return v4 ?? [hex[6]!, hex[7]!].map((g) => `${parseInt(g.slice(0, 2), 16)}.${parseInt(g.slice(2), 16)}`).join('.');
  }
  return `${hex.slice(0, 4).join(':')}::/64`;
}

// ---- Usage counters (§7.8 step 9) ----

/** Flush thresholds of the isolate counters. */
export const FLUSH_WRITES = 50;
export const FLUSH_REQUESTS = 100;
/**
 * The soft valve (§7.8 step 9b): above this estimate, optional writes stop (histogram moves, out-of-top placements,
 * daily/dup plays rows). Top-100 entries, first AI-beaten runs and daily rankings still write. Lite implies soft.
 */
export const SOFT_LIMIT = 50_000;
/** The safety valve (§7.8 step 10): estimated rows written / requests today above which the Worker goes lite. */
export const LITE_LIMIT = 80_000;

const pending = { date: '', req: 0, wr: 0 };

function roll(now: number): void {
  const d = jstDate(now);
  if (pending.date !== d) {
    // A new JST day: counts of the previous day are estimates only, drop them.
    pending.date = d;
    pending.req = 0;
    pending.wr = 0;
  }
}

/** Counts one Worker invocation of /api/*. */
export function noteRequest(now: number): void {
  roll(now);
  pending.req += 1;
}

/** Adds rows written by this isolate. */
export function noteWrites(rows: number, now: number): void {
  roll(now);
  if (rows > 0) pending.wr += rows;
}

/** true when the isolate counters should be flushed to D1 (every 50 rows written / 100 requests). */
export function counterFlushDue(now: number): boolean {
  roll(now);
  return pending.wr >= FLUSH_WRITES || pending.req >= FLUSH_REQUESTS;
}

/**
 * Writes the pending counts with ONE statement (it is the "+1 counters write" of the §7.8 statement budget)
 * and clears them. The rows it writes are counted towards the next flush.
 */
export async function flushCounters(db: Db, env: Env, now: number): Promise<void> {
  if (env.READ_ONLY === '1') return;
  roll(now);
  const entries: [string, number][] = [];
  if (pending.req > 0) entries.push([`req:${pending.date}`, pending.req]);
  if (pending.wr > 0) entries.push([`wr:${pending.date}`, pending.wr]);
  if (entries.length === 0) return;
  const req = pending.req, wr = pending.wr;
  pending.req = 0;
  pending.wr = 0;
  try {
    await db.run(
      db.prepare(`INSERT INTO counters (k, n) VALUES ${entries.map(() => '(?, ?)').join(', ')} ON CONFLICT(k) DO UPDATE SET n = n + excluded.n`)
        .bind(...entries.flat()),
    );
    pending.wr += entries.length;
  } catch (e) {
    pending.req += req;
    pending.wr += wr;
    console.error(JSON.stringify({ evt: 'counters-flush-failed', err: String(e) }));
  }
}

export interface Usage { req: number; wr: number }

/** The counters statement: today's flushed totals (one statement, 2 rows). */
export function countersStatement(db: Db, now: number): D1PreparedStatement {
  const d = jstDate(now);
  return db.prepare('SELECT k, n FROM counters WHERE k IN (?, ?)').bind(`req:${d}`, `wr:${d}`);
}

/** Today's estimate: flushed totals from D1 plus what this isolate has not flushed yet. */
export function estimateUsage(rows: readonly { k: string; n: number }[], now: number): Usage {
  roll(now);
  let req = pending.req, wr = pending.wr;
  for (const r of rows) {
    if (r.k.startsWith('req:')) req += r.n;
    else if (r.k.startsWith('wr:')) wr += r.n;
  }
  return { req, wr };
}

export function isSoft(u: Usage): boolean {
  return u.wr > SOFT_LIMIT || u.req > SOFT_LIMIT;
}

export function isLite(u: Usage): boolean {
  return u.wr > LITE_LIMIT || u.req > LITE_LIMIT;
}

/** Test hook: clears buckets and counters of this isolate. */
export function resetLimitsForTest(): void {
  buckets.submit.clear();
  buckets.read.clear();
  pending.date = '';
  pending.req = 0;
  pending.wr = 0;
  fallbackLogged.submit = false;
  fallbackLogged.read = false;
}

/** Test hook: current unflushed isolate counts. */
export function pendingForTest(): { req: number; wr: number } {
  return { req: pending.req, wr: pending.wr };
}
