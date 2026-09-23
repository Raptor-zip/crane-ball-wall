// GET /api/boot?day=<dayIndex> (GAME_DESIGN.md §7.7). Owner: O9.
// 30 s isolate memo -> Cache API (custom domains only; a no-op on workers.dev; skipped by local dev) -> D1:
// one `WHERE board IN (...)` statement for the 18 level boards + today's daily, and the counters row(s).
import type { Env } from '../index';
import { Db, apiError, blobBytes, cutoffOf, json, parseHist, parseTop, publicRow } from '../db';
import { allowRequest, clientKey, countersStatement, estimateUsage, isLite, nowMs } from '../limits';
import { dailyTarget, levelTargets, type Target } from '../verify';
import { dayIndexAt, jstDayNumber } from '../../src/shared/daily';
import { b64urlEncode } from '../../src/sim/b64';
import { SIM_VERSION } from '../../src/sim/constants';
import { BOOT_TOP_N, HIST_BINS, type BootBoard, type BootDaily, type BootResponse } from '../../src/shared/api';

export const BOOT_CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=300';
export const BOOT_MEMO_MS = 30_000;

/**
 * The isolate memo. It is keyed by the JST calendar day (not only by dayIndex): before DAILY_EPOCH every day is
 * dayIndex 0 but the daily level still changes at 00:00 JST.
 */
let memo: { jd: number; at: number; body: string } | null = null;

/** Test hook: forget the isolate memo. */
export function resetBootMemoForTest(): void {
  memo = null;
}

interface Row { board: string; n: number; cleared: number; ai_beaten: number; top: string; hist: string | null; wr: unknown }

export async function handleBoot(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (req.method !== 'GET') return apiError(405, 'method', { Allow: 'GET' });
  if (!(await allowRequest(env, 'read', clientKey(req)))) return apiError(429, 'rateLimited', { 'Retry-After': '60' });

  const now = nowMs();
  const day = dayIndexAt(now);   // the query's `day` only splits caches per day; the Worker's clock decides
  const jd = jstDayNumber(now);
  const headers = { 'Cache-Control': BOOT_CACHE_CONTROL };
  if (memo && memo.jd === jd && now - memo.at < BOOT_MEMO_MS) return json2(memo.body, headers);

  const url = new URL(req.url);
  // Local development (`wrangler dev`: DEV=1, localhost) skips the Cache API: its local emulation kept serving a
  // boot answer long past max-age, so runs never showed up in boot until .wrangler/state was removed.
  const cache = typeof caches !== 'undefined' && env.DEV !== '1' && !isLocalHost(url.hostname) ? caches.default : null;
  const cacheKey = new Request(bootCacheUrl(url.origin, now));
  if (cache) {
    try {
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
    } catch {
      // Cache API unavailable: fall through to D1.
    }
  }

  const body = JSON.stringify(await buildBoot(env, now, day));
  memo = { jd, at: now, body };
  const res = json2(body, headers);
  if (cache) ctx.waitUntil(cache.put(cacheKey, res.clone()).catch(() => undefined));
  return res;
}

/** localhost, 127.0.0.0/8, ::1 and *.localhost: a development server, never a deployed route. */
export function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || /^127\.\d+\.\d+\.\d+$/.test(h) || h === '[::1]' || h === '::1';
}

/** Cache API key of the boot response of the JST day containing `now` (clients cannot pick it). */
export function bootCacheUrl(origin: string, now: number): string {
  return `${origin}/api/boot?day=${dayIndexAt(now)}&jst=${jstDayNumber(now)}`;
}

function json2(body: string, headers: Record<string, string>): Response {
  return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
}

async function buildBoot(env: Env, now: number, day: number): Promise<BootResponse> {
  const levels = levelTargets();
  const daily = await dailyTarget(now);
  const targets: Target[] = daily ? [...levels, daily] : levels;
  const db = new Db(env.DB);
  const [boardsRes, countersRes] = await db.batch([
    db.prepare(`SELECT board, n, cleared, ai_beaten, top, hist, wr FROM boards WHERE board IN (${targets.map(() => '?').join(', ')})`)
      .bind(...targets.map((t) => t.key)),
    countersStatement(db, now),
  ]);
  const rows = new Map<string, Row>();
  for (const r of (boardsRes!.results as Row[])) rows.set(r.board, r);
  const usage = estimateUsage(countersRes!.results as { k: string; n: number }[], now);

  const boards: Record<string, BootBoard> = {};
  for (const t of levels) {
    const r = rows.get(t.key);
    const top = parseTop(r?.top);
    boards[t.levelId] = {
      key: t.key, n: r?.n ?? 0, aiBeaten: r?.ai_beaten ?? 0, par: t.par,
      cutoff: cutoffOf(top), top: top.slice(0, BOOT_TOP_N).map(publicRow), wr: wrString(r?.wr),
    };
  }
  let dailyOut: BootDaily;
  if (daily) {
    const r = rows.get(daily.key);
    dailyOut = {
      key: daily.key, n: r?.n ?? 0, cleared: r?.cleared ?? 0, aiBeaten: r?.ai_beaten ?? 0, par: daily.par,
      top: parseTop(r?.top).slice(0, BOOT_TOP_N).map(publicRow), hist: parseHist(r?.hist), wr: wrString(r?.wr),
    };
  } else {
    dailyOut = { key: '', n: 0, cleared: 0, aiBeaten: 0, par: 0, top: [], hist: new Array<number>(HIST_BINS).fill(0), wr: null };
  }
  return {
    v: 1, sim: SIM_VERSION, now, day, lite: isLite(usage), readOnly: env.READ_ONLY === '1',
    boards, daily: dailyOut,
  };
}

function wrString(v: unknown): string | null {
  const b = blobBytes(v);
  return b && b.length > 0 ? b64urlEncode(b) : null;
}
