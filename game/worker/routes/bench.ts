// GET /api/bench?level=2-2&n=10[&ticks=2700], only when DEV=1 (GAME_DESIGN.md §7.7, M12). Owner: O9.
// Verifies the bundled bot replay n times through the same decode + re-simulation path as /api/submit, so that
// Workers Logs `cpuTime` of this request measures n verifications (M12: 45 s replay, p99 < 7 ms per request with n=1).
import type { Env } from '../index';
import { apiError, json } from '../db';
import { decodeRun, levelTarget } from '../verify';
import { botQs } from '../warmup';
import { encodeReplay, simulateReplay, DeviceTag } from '../../src/sim/replay';
import { b64urlEncode } from '../../src/sim/b64';
import { SIM_VERSION, RANKED_MAX_TICKS } from '../../src/sim/constants';

export async function handleBench(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
  if (env.DEV !== '1') return apiError(404, 'notFound');
  if (req.method !== 'GET') return apiError(405, 'method', { Allow: 'GET' });
  const q = new URL(req.url).searchParams;
  const levelId = q.get('level') ?? '2-2';
  const n = clampInt(q.get('n'), 1, 50, 1);
  const ticks = clampInt(q.get('ticks'), 1, RANKED_MAX_TICKS, RANKED_MAX_TICKS);
  const t = levelTarget(levelId);
  if (!t) return apiError(400, 'badRequest');

  const replay = b64urlEncode(encodeReplay(
    { fmt: 1, sim: SIM_VERSION, levelHash: t.hash, device: DeviceTag.Touch, flags: 0, nTicks: ticks }, botQs(ticks),
  ));
  const t0 = Date.now();
  let status = -1, simTicks = 0;
  for (let i = 0; i < n; i++) {
    const dec = decodeRun(replay, t);
    if (!dec.ok) return json({ error: dec.reason }, 500);
    const r = simulateReplay(t.phys, dec.qs);
    status = r.status;
    simTicks = r.ticks;
  }
  return json(
    { level: levelId, n, ticks, substeps: ticks * 2 * n, bytes: Math.ceil((replay.length * 3) / 4), status, simTicks, wallMs: Date.now() - t0 },
    200, { 'Cache-Control': 'no-store' },
  );
}

function clampInt(v: string | null, lo: number, hi: number, dflt: number): number {
  const x = v === null ? NaN : Number(v);
  return Number.isInteger(x) ? Math.max(lo, Math.min(hi, x)) : dflt;
}
