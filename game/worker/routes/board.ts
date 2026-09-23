// GET /api/board/:key (GAME_DESIGN.md §7.7): the whole top 100, one row read. Owner: O9.
// Also the board's histogram (level: 153 bins, daily: 150) trimmed, once it has one, and `cleared` for daily boards.
import type { Env } from '../index';
import { Db, apiError, cutoffOf, json, parseHist, parseTop, publicRow } from '../db';
import { allowRequest, clientKey, nowMs } from '../limits';
import { dailyTarget, levelTargets } from '../verify';
import { HIST_BINS, parseBoardKey, type BoardResponse } from '../../src/shared/api';
import { LEVEL_HIST_BINS, sumHist, trimHist } from '../../src/shared/rank';

export const BOARD_CACHE_CONTROL = 'public, max-age=60';

/** "/api/board/<key>" -> key (URL-decoded), or null. */
export function boardKeyFromPath(pathname: string): string | null {
  const m = /^\/api\/board\/([^/]+)$/.exec(pathname);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return null;
  }
}

export async function handleBoard(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
  if (req.method !== 'GET') return apiError(405, 'method', { Allow: 'GET' });
  const key = boardKeyFromPath(new URL(req.url).pathname);
  if (key === null || !parseBoardKey(key)) return apiError(400, 'badRequest');
  if (!(await allowRequest(env, 'read', clientKey(req)))) return apiError(429, 'rateLimited', { 'Retry-After': '60' });

  const db = new Db(env.DB);
  const r = await db.first<{ n: number; ai_beaten: number; par: number; top: string; hist: string | null; cleared: number }>(
    db.prepare('SELECT n, ai_beaten, par, top, hist, cleared FROM boards WHERE board = ?').bind(key),
  );
  const top = parseTop(r?.top);
  const level = key.startsWith('L:');
  const current = level ? levelTargets().find((t) => t.key === key) : await dailyTarget(nowMs());
  const par = current?.key === key ? current.par : r?.par ?? 0;
  const body: BoardResponse = { key, n: r?.n ?? 0, aiBeaten: r?.ai_beaten ?? 0, par, cutoff: cutoffOf(top), top: top.map(publicRow) };
  if (r?.hist) {
    const h = parseHist(r.hist, level ? LEVEL_HIST_BINS : HIST_BINS);
    if (sumHist(h) > 0) body.hist = trimHist(h);
  }
  if (!level) body.cleared = r?.cleared ?? 0;
  return json(body, 200, { 'Cache-Control': BOARD_CACHE_CONTROL });
}
