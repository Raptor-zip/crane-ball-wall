// Module-scope warm-up: simulate the bundled 5 s bot replay 3 times (GAME_DESIGN.md §7.8). Owner: O9.
// It runs during isolate startup (counted in the 1 s startup limit, not in request CPU) and logs its duration once.
// Note: the Workers clock does not advance while code runs, so in production the logged ms is usually 0; the real
// cost shows up in the "Worker Startup Time" that `wrangler deploy` prints (M12).
import { simulateReplay } from '../src/sim/replay';
import { levelTarget } from './verify';

export const WARMUP_LEVEL = '2-2';
export const WARMUP_TICKS = 300;   // 5 s
export const WARMUP_RUNS = 3;

/**
 * The bundled bot: a touch-like input that changes q on almost every tick (the worst case for decoding) and keeps
 * the ball hanging near the start, so a run lasts its full length instead of ending early in a crash.
 * q = 40·cos(2π·t/30 ticks) (0.5 s, far above the pendulum frequency; the cosine phase has no net drift) plus a
 * deterministic dither of ±0..3 that alternates sign in pairs (no net impulse). The first q is 40, never 0 (§7.8 step 3).
 */
export function botQs(ticks: number): Int8Array {
  const qs = new Int8Array(ticks);
  let s = 0x9e3779b9 >>> 0;
  let d = 0;
  for (let t = 0; t < ticks; t++) {
    if ((t & 1) === 0) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      d = (s >>> 16) % 4;
    }
    const dither = (t & 1) === 0 ? d : -d;
    const q = Math.round(40 * Math.cos((2 * Math.PI * t) / 30)) + dither;
    qs[t] = Math.max(-127, Math.min(127, q === 0 && t === 0 ? 1 : q));
  }
  return qs;
}

let logged = false;

/** Returns the elapsed ms (0 if the simulation is unavailable). Never throws: a failure must not break the Worker. */
export function warmup(): number {
  const t0 = Date.now();
  try {
    const t = levelTarget(WARMUP_LEVEL);
    if (!t) return 0;
    const qs = botQs(WARMUP_TICKS);
    for (let i = 0; i < WARMUP_RUNS; i++) simulateReplay(t.phys, qs);
  } catch (e) {
    if (!logged) console.warn(JSON.stringify({ evt: 'warmup-failed', err: String(e) }));
    logged = true;
    return 0;
  }
  const ms = Date.now() - t0;
  if (!logged) console.log(JSON.stringify({ evt: 'warmup', ms, runs: WARMUP_RUNS, ticks: WARMUP_TICKS }));
  logged = true;
  return ms;
}
