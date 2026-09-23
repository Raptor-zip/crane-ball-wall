// JST day arithmetic and daily-level selection, shared by client and Worker (GAME_DESIGN.md §7.5). Owner: O3.
// No DOM. All remainders are non-negative: ((a % n) + n) % n.
import type { DailyDef } from '../sim/level';

/**
 * 2026-09-23 00:00 JST (= 2026-09-22T15:00:00Z) in ms: the launch day (was 2026-10-01, moved per §7.5). Never change after launch.
 * Every JST day before it has dayIndex 0 (with a different level each weekday): the client tells those days apart by
 * their JST calendar day (jstDayNumber, SaveV1.daily.jstDay), never by dayIndex alone.
 */
export const DAILY_EPOCH = Date.UTC(2026, 8, 22, 15, 0, 0);
export const JST_OFFSET_MS = 9 * 3600 * 1000;
export const DAY_MS = 86400000;
export const DAILY_BALLS = 5;
export const PERM_SEED = 'yurapita-daily-v1';

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

/** Public-domain xmur3 string hash (bryc); returns a generator of 32-bit unsigned seeds. */
export function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

/** Public-domain mulberry32 PRNG (bryc); returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let permCache: readonly number[] | null = null;

/** Fixed permutation of [0..11] from mulberry32(xmur3('yurapita-daily-v1')()) via Fisher-Yates (i = 11..1). */
export function perm12(): number[] {
  if (!permCache) {
    const rand = mulberry32(xmur3(PERM_SEED)());
    const p = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    for (let i = 11; i >= 1; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = p[i]!;
      p[i] = p[j]!;
      p[j] = t;
    }
    permCache = p;
  }
  return permCache.slice();
}

/** Days since 1970-01-01 of the JST calendar date of nowMs. */
export function jstDayNumber(nowMs: number): number {
  return Math.floor((nowMs + JST_OFFSET_MS) / DAY_MS);
}

/** UTC ms of the 00:00 JST that starts the JST day of nowMs. */
export function jstMidnight(nowMs: number): number {
  return jstDayNumber(nowMs) * DAY_MS - JST_OFFSET_MS;
}

/** max(0, floor((JST midnight of nowMs - DAILY_EPOCH) / 86400000)). */
export function dayIndexAt(nowMs: number): number {
  return Math.max(0, Math.floor((jstMidnight(nowMs) - DAILY_EPOCH) / DAY_MS));
}

/** JST weekday of nowMs, Monday = 0 ... Sunday = 6 (1970-01-01 was a Thursday). */
export function jstWeekday(nowMs: number): number {
  return mod(jstDayNumber(nowMs) + 3, 7);
}

/** UTC ms of 00:00 JST of the JST calendar day `jstDay` (inverse of jstDayNumber). */
export function jstDayStartMs(jstDay: number): number {
  return jstDay * DAY_MS - JST_OFFSET_MS;
}

/** ms since 00:00 JST of the JST day of nowMs (0 <= t < DAY_MS). */
export function jstTimeOfDay(nowMs: number): number {
  return mod(nowMs + JST_OFFSET_MS, DAY_MS);
}

/**
 * 00:00-02:00 JST: yesterday's daily board still takes runs (§7.8 step 2).
 * worker/verify.ts DAILY_GRACE_MS is the server side of this rule and must keep the same value.
 */
export const DAILY_GRACE_MS = 2 * 3600 * 1000;

/** The Worker takes runs for the daily of JST calendar day `jstDay` at nowMs: that day, or the day before until 02:00 JST. */
export function dailyDayOpen(jstDay: number, nowMs: number): boolean {
  const today = jstDayNumber(nowMs);
  return jstDay === today || (jstDay === today - 1 && jstTimeOfDay(nowMs) < DAILY_GRACE_MS);
}

/** "YYYY-MM-DD" of the JST date (counters keys, logs). */
export function jstDateString(nowMs: number): string {
  return new Date(jstDayNumber(nowMs) * DAY_MS).toISOString().slice(0, 10);
}

/** UTC ms of 00:00 JST of the given dayIndex (inverse of dayIndexAt for dayIndex >= 0). */
export function dayStartMs(dayIndex: number): number {
  return DAILY_EPOCH + dayIndex * DAY_MS;
}

export interface DailyPick { dayIndex: number; n: number; poolIndex: number; level: DailyDef }

/**
 * tier[w][perm12[floor(dayIndex / 7) mod 12]] from the pool (84 entries, 12 per tier in file order).
 * Robust to a short pool: an index past the end of a tier wraps; an empty tier falls back to pool[dayIndex mod size].
 * Throws only on an empty pool.
 */
export function pickDaily(pool: readonly DailyDef[], nowMs: number): DailyPick {
  if (pool.length === 0) throw new Error('pickDaily: empty daily pool');
  const dayIndex = dayIndexAt(nowMs);
  const w = jstWeekday(nowMs);
  const tier: number[] = [];
  for (let i = 0; i < pool.length; i++) if (pool[i]!.tier === w + 1) tier.push(i);
  const k = Math.floor(dayIndex / 7);
  let poolIndex: number;
  if (tier.length > 0) {
    const slot = perm12()[mod(k, 12)]!;
    poolIndex = tier[mod(slot, tier.length)]!;
  } else {
    poolIndex = mod(dayIndex, pool.length);
  }
  return { dayIndex, n: dayIndex + 1, poolIndex, level: pool[poolIndex]! };
}
