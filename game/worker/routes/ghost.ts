// GET /api/ghost/:key/:rank (GAME_DESIGN.md §7.7): {key, rank, pidh, nameSeed, t120, replay}, 2 rows read. Owner: O9.
import type { Env } from '../index';
import { Db, apiError, blobBytes, json } from '../db';
import { allowRequest, clientKey } from '../limits';
import { b64urlEncode } from '../../src/sim/b64';
import { BOARD_TOP_N, parseBoardKey, type GhostResponse } from '../../src/shared/api';

export const GHOST_CACHE_CONTROL = 'public, max-age=300';

// One statement: the pidh at `rank` in boards.top (1 row) joined to that runs row (1 row).
const SQL_GHOST =
  'SELECT pidh, name_seed, t120, replay FROM runs WHERE board = ?1 AND pidh = ' +
  "(SELECT json_extract(top, printf('$[%d][0]', ?2 - 1)) FROM boards WHERE board = ?1)";

export async function handleGhost(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
  if (req.method !== 'GET') return apiError(405, 'method', { Allow: 'GET' });
  const m = /^\/api\/ghost\/([^/]+)\/([0-9]{1,3})$/.exec(new URL(req.url).pathname);
  let key: string | null = null;
  try {
    key = m ? decodeURIComponent(m[1]!) : null;
  } catch {
    key = null;
  }
  const rank = m ? Number(m[2]) : 0;
  if (key === null || !parseBoardKey(key) || rank < 1 || rank > BOARD_TOP_N) return apiError(400, 'badRequest');
  if (!(await allowRequest(env, 'read', clientKey(req)))) return apiError(429, 'rateLimited', { 'Retry-After': '60' });

  const db = new Db(env.DB);
  const r = await db.first<{ pidh: string; name_seed: number; t120: number | null; replay: unknown }>(
    db.prepare(SQL_GHOST).bind(key, rank),
  );
  const replay = blobBytes(r?.replay);
  if (!r || r.t120 === null || !replay || replay.length === 0) return apiError(404, 'notFound', { 'Cache-Control': 'public, max-age=60' });
  const body: GhostResponse = { key, rank, pidh: r.pidh, nameSeed: r.name_seed, t120: r.t120, replay: b64urlEncode(replay) };
  return json(body, 200, { 'Cache-Control': GHOST_CACHE_CONTROL });
}
