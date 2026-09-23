// Taut-string equations of motion and RK4 integrators (GAME_DESIGN.md §4.2-§4.4). Owner: O1.
//
// accelAt() is ballwall/dynamics.py `accel` with the floating-point order of §4.2 fixed.
//
// Allocation: the hot path passes numbers through pre-allocated Float64Arrays (the parameter block
// `par` = [M, m, L, F, h] and state arrays) rather than as function arguments or return values. V8 boxes a
// double into a fresh HeapNumber whenever it crosses a call boundary that was not inlined, so this keeps
// stepTick free of allocations. The plain-argument wrappers at the end are for tests and tools.
import { B_TROLLEY as B_TROLLEY_, C_PIVOT as C_PIVOT_, G as G_ } from './constants';
import { sincosAt as sincosAt_ } from './detmath';
import type { LevelPhysics } from './level';

// Module-local copies of the imported values used in the hot loop. Vitest's module runner resolves every
// access to an imported binding through a getter, which made the loop ~3x slower under test; bundlers
// (Vite/Rolldown, wrangler/esbuild) produce the same code either way. Values are identical.
const B_TROLLEY = B_TROLLEY_;
const C_PIVOT = C_PIVOT_;
const G = G_;
const sincosAt = sincosAt_;

/** Parameter block of one integration step: Float64Array(5) = [M, m, L, F, h]. */
export type ParBlock = Float64Array;

const SC = new Float64Array(2);
const YS = new Float64Array(4); // RK4 stage state
const PAR = new Float64Array(5); // for the plain-argument wrappers
const YW = new Float64Array(4); // for the plain-argument wrappers

/** Output of accelAt(): [xdd, thdd, sin(th), cos(th)]. Overwritten by every call. */
export const ACC = new Float64Array(4);

/** Free-trolley accelerations of the taut system (§4.2) at y = [x, v, th, w] with par = [M, m, L, F, h], written to ACC. */
export function accelAt(par: ParBlock, y: Float64Array): void {
  const M = par[0]!;
  const m = par[1]!;
  const L = par[2]!;
  const F = par[3]!;
  const v = y[1]!;
  const w = y[3]!;
  sincosAt(y, 2, SC);
  const sn = SC[0]!;
  const cs = SC[1]!;
  const b = B_TROLLEY;
  const c = C_PIVOT;
  const a12 = m * L * cs;
  const a22 = m * L * L;
  const r1 = F - b * v + m * L * w * w * sn;
  const r2 = -m * G * L * sn - c * w;
  const det = m * L * L * (M + m * sn * sn);
  ACC[0] = (a22 * r1 - a12 * r2) / det;
  ACC[1] = ((M + m) * r2 - a12 * r1) / det;
  ACC[2] = sn;
  ACC[3] = cs;
}

/**
 * Classic RK4 of the free taut system over one step par[4] with constant force par[3].
 * y = [x, v, th, w] is updated in place (same stage order as ballwall: s + h/2*k, s + h/6*(k1+2k2+2k3+k4)).
 * k1Ready: ACC already holds accelAt(par, y) (the stepper evaluated it for the pinned and tension tests).
 */
export function rk4TautP(par: ParBlock, y: Float64Array, k1Ready: boolean): void {
  const h = par[4]!;
  const x = y[0]!;
  const v = y[1]!;
  const th = y[2]!;
  const w = y[3]!;
  const hh = h / 2;

  if (!k1Ready) accelAt(par, y);
  const k1x = v;
  const k1v = ACC[0]!;
  const k1t = w;
  const k1w = ACC[1]!;

  const v2 = v + hh * k1v;
  const th2 = th + hh * k1t;
  const w2 = w + hh * k1w;
  YS[1] = v2;
  YS[2] = th2;
  YS[3] = w2;
  accelAt(par, YS);
  const k2x = v2;
  const k2v = ACC[0]!;
  const k2t = w2;
  const k2w = ACC[1]!;

  const v3 = v + hh * k2v;
  const th3 = th + hh * k2t;
  const w3 = w + hh * k2w;
  YS[1] = v3;
  YS[2] = th3;
  YS[3] = w3;
  accelAt(par, YS);
  const k3x = v3;
  const k3v = ACC[0]!;
  const k3t = w3;
  const k3w = ACC[1]!;

  const v4 = v + h * k3v;
  const th4 = th + h * k3t;
  const w4 = w + h * k3w;
  YS[1] = v4;
  YS[2] = th4;
  YS[3] = w4;
  accelAt(par, YS);
  const k4x = v4;
  const k4v = ACC[0]!;
  const k4t = w4;
  const k4w = ACC[1]!;

  const h6 = h / 6;
  y[0] = x + h6 * (k1x + 2 * k2x + 2 * k3x + k4x);
  y[1] = v + h6 * (k1v + 2 * k2v + 2 * k3v + k4v);
  y[2] = th + h6 * (k1t + 2 * k2t + 2 * k3t + k4t);
  y[3] = w + h6 * (k1w + 2 * k2w + 2 * k3w + k4w);
}

/** thdd of the pendulum on a fixed pivot at th = YS[2], w = YS[3] (m = par[1], L = par[2]), written to ACC[1]. */
function thddPinned(par: ParBlock): void {
  const m = par[1]!;
  const L = par[2]!;
  sincosAt(YS, 2, SC);
  ACC[1] = -(G / L) * SC[0]! - C_PIVOT * YS[3]! / (m * L * L);
}

/**
 * RK4 of the pendulum on a fixed pivot (trolley pinned at a rail end, §4.4 Taut step 6):
 * thdd = -(G/L)*sin(th) - c*w/(m*L*L), step par[4]. y = [th, w] is updated in place.
 */
export function rk4PinnedP(par: ParBlock, y: Float64Array): void {
  const h = par[4]!;
  const th = y[0]!;
  const w = y[1]!;
  const hh = h / 2;
  const k1t = w;
  YS[2] = th;
  YS[3] = w;
  thddPinned(par);
  const k1w = ACC[1]!;
  const t2 = th + hh * k1t;
  const w2 = w + hh * k1w;
  const k2t = w2;
  YS[2] = t2;
  YS[3] = w2;
  thddPinned(par);
  const k2w = ACC[1]!;
  const t3 = th + hh * k2t;
  const w3 = w + hh * k2w;
  const k3t = w3;
  YS[2] = t3;
  YS[3] = w3;
  thddPinned(par);
  const k3w = ACC[1]!;
  const t4 = th + h * k3t;
  const w4 = w + h * k3w;
  const k4t = w4;
  YS[2] = t4;
  YS[3] = w4;
  thddPinned(par);
  const k4w = ACC[1]!;
  const h6 = h / 6;
  y[0] = th + h6 * (k1t + 2 * k2t + 2 * k3t + k4t);
  y[1] = w + h6 * (k1w + 2 * k2w + 2 * k3w + k4w);
}

/**
 * RK4 of the trolley alone while the string is slack (§4.4 Slack step 1): xdd = (F - b*v)/M with
 * M = par[0], F = par[3], step par[4]. y = [x, v] is updated in place.
 */
export function rk4CartP(par: ParBlock, y: Float64Array): void {
  const M = par[0]!;
  const F = par[3]!;
  const h = par[4]!;
  const x = y[0]!;
  const v = y[1]!;
  const hh = h / 2;
  const k1x = v;
  const k1v = (F - B_TROLLEY * v) / M;
  const v2 = v + hh * k1v;
  const k2x = v2;
  const k2v = (F - B_TROLLEY * v2) / M;
  const v3 = v + hh * k2v;
  const k3x = v3;
  const k3v = (F - B_TROLLEY * v3) / M;
  const v4 = v + h * k3v;
  const k4x = v4;
  const k4v = (F - B_TROLLEY * v4) / M;
  const h6 = h / 6;
  y[0] = x + h6 * (k1x + 2 * k2x + 2 * k3x + k4x);
  y[1] = v + h6 * (k1v + 2 * k2v + 2 * k3v + k4v);
}

/**
 * Taut rail-end stop (§4.4 Taut step 8, the v*sn >= 0 branch): the trolley stops dead and the
 * generalised momentum p_th = m*L*cos(th)*v + m*L^2*w is conserved: w += v*cs/L; v = 0.
 * Returns the new w. Exported for invariants ③.
 */
export function railStopW(L: number, v: number, cs: number, w: number): number {
  return w + v * cs / L;
}

/** Output of snapImpulse(): [J, bvx, bvy, v]. Overwritten by every call. */
export const SNAP = new Float64Array(4);

/**
 * Inelastic string impulse of the re-tension (§4.4 Slack step 3) for an outward radial velocity vr > 0.
 * `held` = the trolley is pinned in the direction of the impulse (then it acts as infinite mass and
 * does not move). Writes [J, bvx', bvy', v'] to SNAP. Exported for invariants ②.
 */
export function snapImpulse(M: number, m: number, sn: number, cs: number, vr: number,
  bvx: number, bvy: number, v: number, held: boolean): void {
  PAR[0] = M;
  PAR[1] = m;
  SNAP_IN[0] = sn;
  SNAP_IN[1] = cs;
  SNAP_IN[2] = vr;
  SNAP_IN[3] = bvx;
  SNAP_IN[4] = bvy;
  SNAP_IN[5] = v;
  snapImpulseA(PAR, SNAP_IN, held);
}

const SNAP_IN = new Float64Array(6);

/** snapImpulse with M = par[0], m = par[1] and inp = [sn, cs, vr, bvx, bvy, v] (the stepper's allocation-free form). */
export function snapImpulseA(par: ParBlock, inp: Float64Array, held: boolean): void {
  const M = par[0]!;
  const m = par[1]!;
  const sn = inp[0]!;
  const cs = inp[1]!;
  const vr = inp[2]!;
  const v = inp[5]!;
  const J = held ? m * vr : vr / (1 / m + sn * sn / M);
  SNAP[0] = J;
  SNAP[1] = inp[3]! - (J / m) * sn;
  SNAP[2] = inp[4]! + (J / m) * cs;
  SNAP[3] = held ? v : v + (J / M) * sn;
}

// ---- plain-argument wrappers (tests, tools) ----------------------------------------------------------

function setPar(M: number, m: number, L: number, F: number, h: number): void {
  PAR[0] = M;
  PAR[1] = m;
  PAR[2] = L;
  PAR[3] = F;
  PAR[4] = h;
}

/** accelAt with plain arguments. */
export function accel(M: number, m: number, L: number, v: number, th: number, w: number, F: number): void {
  setPar(M, m, L, F, 0);
  YW[1] = v;
  YW[2] = th;
  YW[3] = w;
  accelAt(PAR, YW);
}

/** String tension of the free-trolley taut system: T = m*(G*cs + L*w*w - xdd*sn). */
export function tensionFree(M: number, m: number, L: number, v: number, th: number, w: number, F: number): number {
  accel(M, m, L, v, th, w, F);
  const xdd = ACC[0]!;
  const sn = ACC[2]!;
  const cs = ACC[3]!;
  return m * (G * cs + L * w * w - xdd * sn);
}

/** rk4TautP with plain arguments. */
export function rk4Taut(M: number, m: number, L: number, y: Float64Array, F: number, h: number): void {
  setPar(M, m, L, F, h);
  rk4TautP(PAR, y, false);
}

/**
 * Taut-only integrator used by tests/sim/eom.test.ts, plans.test.ts and invariants ④.
 * Advances state = [x, v, th, w] by one RK4 step of length h with constant force F
 * (no rail ends, no slack, no collisions).
 */
export function stepTautForTest(phys: LevelPhysics, state: Float64Array, F: number, h: number): void {
  rk4Taut(phys.M, phys.m, phys.L, state, F, h);
}
