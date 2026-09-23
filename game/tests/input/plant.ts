// Test-only taut-string plant for closed-loop servo tests. Owner: O4.
//
// The equations are copied from GAME_DESIGN.md §4.2 (= ballwall/dynamics.py accel) and integrated
// with classic RK4 at 120 Hz, force held for the 2 substeps of a 60 Hz tick (§4.3). It is independent
// of src/sim on purpose (a second, minimal implementation of the Appendix B setting); servo_sim.test.ts
// checks that src/sim matches it to 1e-9 while the string stays taut. The minimum tension is reported
// so a slack excursion would be visible.
import type { LevelPhysics } from '../../src/sim/level';
import type { SimState } from '../../src/sim/run';

export const G = 9.81;
export const B = 0.3;
export const C = 0.002;
export const H = 1 / 120;

export interface Plant { M: number; m: number; L: number }

function accel(p: Plant, v: number, th: number, w: number, F: number, out: Float64Array): void {
  const { M, m, L } = p;
  const sn = Math.sin(th), cs = Math.cos(th);
  const a12 = m * L * cs, a22 = m * L * L;
  const r1 = F - B * v + m * L * w * w * sn;
  const r2 = -m * G * L * sn - C * w;
  const det = m * L * L * (M + m * sn * sn);
  out[0] = (a22 * r1 - a12 * r2) / det;
  out[1] = ((M + m) * r2 - a12 * r1) / det;
}

const k = new Float64Array(2);

/** One RK4 substep of the taut model; returns the string tension at the start of the step. */
export function stepTaut(p: Plant, s: SimState, F: number, h = H): number {
  const { x, v, th, w } = s;
  accel(p, v, th, w, F, k);
  const a1 = k[0], b1 = k[1];
  const T = p.m * (G * Math.cos(th) + p.L * w * w - a1 * Math.sin(th));
  accel(p, v + 0.5 * h * a1, th + 0.5 * h * w, w + 0.5 * h * b1, F, k);
  const a2 = k[0], b2 = k[1];
  accel(p, v + 0.5 * h * a2, th + 0.5 * h * (w + 0.5 * h * b1), w + 0.5 * h * b2, F, k);
  const a3 = k[0], b3 = k[1];
  accel(p, v + h * a3, th + h * (w + 0.5 * h * b2), w + h * b3, F, k);
  const a4 = k[0], b4 = k[1];
  s.x = x + (h / 6) * (v + 2 * (v + 0.5 * h * a1) + 2 * (v + 0.5 * h * a2) + (v + h * a3));
  s.v = v + (h / 6) * (a1 + 2 * a2 + 2 * a3 + a4);
  s.th = th + (h / 6) * (w + 2 * (w + 0.5 * h * b1) + 2 * (w + 0.5 * h * b2) + (w + h * b3));
  s.w = w + (h / 6) * (b1 + 2 * b2 + 2 * b3 + b4);
  s.F = F;
  s.T = T;
  return T;
}

/** A default-plant level (§5.1 defaults) with optional overrides. */
export function level(over: Partial<LevelPhysics> = {}): LevelPhysics {
  return {
    M: 2.0, m: 1.0, L: 1.0, Fmax: 40, rail: [-1.0, 3.2], startX: 0, walls: [],
    phases: [{ kind: 'pad', xa: 1.2, xb: 1.8 }], restDeg: 3.0, ...over,
  };
}

/** A fresh SimState at rest (only the fields the servo reads matter). */
export function restState(x = 0, th = 0): SimState {
  return {
    mode: 0, pinned: 0, x, v: 0, th, w: 0, bx: 0, by: 0, bvx: 0, bvy: 0, F: 0, T: 0,
    substep: 0, status: 0, phase: 0, hold: 0, holdStart: 0, score: 0, minD2: Infinity, peakF: 0,
    near: { wall: -1, d2: Infinity, px: 0, py: 0 }, crash: null,
  } as SimState;
}

/** One 60 Hz tick: force q*Fmax/127 held over 2 substeps. Returns the minimum tension seen. */
export function tick(phys: LevelPhysics, s: SimState, q: number): number {
  const F = (q * phys.Fmax) / 127;
  const t1 = stepTaut(phys, s, F);
  const t2 = stepTaut(phys, s, F);
  s.substep += 2;
  return Math.min(t1, t2);
}
