// Target servo -> quantised force q (GAME_DESIGN.md §3.2, §3.6, Appendix A). Owner: O4.
//
// Every device only produces an Intent; this servo turns (intent, state) into the 8-bit force q
// once per 60 Hz tick. Fragile cargo (R10): on egg levels (phys.egg) every intent's speed cap is
// FRAGILE (2.0 m/s, fine 0.5) instead of SERVO.vCap / vCapFine, so a plain drag or key press does not
// crack the egg (the keyboard and gamepad also scale their own commands to it, manager.setLevel). Only q is simulated and recorded, so the tuning below can change after
// release without breaking replays, ghosts or rankings (§3.1).
//
// Not part of the deterministic simulation: Math.sin is fine here (q is what gets replayed).
import type { LevelPhysics } from '../sim/level';
import type { SimState } from '../sim/run';
import type { InputFrame } from './types';

export interface ServoTuning { kx: number; kvPerKg: number; vCap: number; vCapFine: number; assistKa: number }
export const SERVO: ServoTuning = { kx: 5.0, kvPerKg: 20 / 3, vCap: 4.0, vCapFine: 1.0, assistKa: 3.0 };

/**
 * Steady assist ("ゆれ止め", §3.7, ranked, on by default): with an idle hold point near the goal zone, an LQR state
 * feedback on (distance of x to the zone, v, th, w) pulls the trolley into the zone and brings the ball to rest.
 * - reach: the hold point may be this far outside the current zone [m] (far from it the assist is off, so a brake
 *   fling towards a wall still swings freely).
 * - inset: the goal is clamped to [xa + inset, xb - inset] (at most a quarter of the zone width) [m].
 * - calm: under this fraction of the rest energy (§4.6) the swing is already small enough: plain hold at the goal
 *   (a hold that the player already earned is not delayed by the LQR moving the trolley).
 * - q / r: LQR weights on (x, v, th, w) and F (tuned on the default plant: 20° -> rest over the goal in ~2 s,
 *   45° in ~2.3 s; the old KX + KA sin th hold needs 5.6 s / 9.4 s).
 */
export const STEADY = { reach: 0.30, inset: 0.03, calm: 1.3, q: [4, 0.1, 10, 0.1] as const, r: 0.01 } as const;

/** Speed caps on egg levels (R10 fragile cargo) [m/s]. */
export const FRAGILE = { vCap: 2.0, vCapFine: 0.5 } as const;

/** q range (Appendix A Q_MAX; duplicated so the input module does not need sim values at runtime). */
export const Q_LIMIT = 127;
/** Targets may sit up to this far outside the rail so the trolley can be slammed into a stopper (§3.2 端ドン). */
export const TARGET_OVER_RAIL = 0.30;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Clamp a target x to [rail[0] - 0.30, rail[1] + 0.30] (§3.2). */
export function clampTarget(x: number, phys: LevelPhysics): number {
  return clamp(x, phys.rail[0] - TARGET_OVER_RAIL, phys.rail[1] + TARGET_OVER_RAIL);
}

/** The servo's speed cap [m/s] on a level: SERVO.vCap / vCapFine, or FRAGILE on egg levels. */
export function speedCap(phys: LevelPhysics, fine: boolean): number {
  if (phys.egg) return fine ? FRAGILE.vCapFine : FRAGILE.vCap;
  return fine ? SERVO.vCapFine : SERVO.vCap;
}

/** Velocity-loop gain for a plant: KV = 20/3 * (M + m) N*s/m (20 on the default 3 kg plant). */
export function servoKv(phys: LevelPhysics): number {
  return SERVO.kvPerKg * (phys.M + phys.m);
}

/**
 * Quantise a force: q = clamp(round(F * 127 / Fmax), -127, 127) (D4). Always an integer in
 * [-127, 127]: never -0, NaN or a fraction, whatever F and Fmax are (0 for NaN, a non-positive Fmax
 * or an undefined ratio such as Infinity / Infinity; ±127 for an infinite F).
 */
export function quantizeForce(F: number, Fmax: number): number {
  if (!(Fmax > 0)) return 0;
  const r = (F * Q_LIMIT) / Fmax;
  if (r !== r) return 0; // NaN
  if (r >= Q_LIMIT) return Q_LIMIT;
  if (r <= -Q_LIMIT) return -Q_LIMIT;
  return Math.round(r) | 0; // | 0 turns Math.round's -0 (e.g. for -0.3) into 0
}

/**
 * The trolley velocity command of §3.2 for position / velocity / idle intents (null for 'force').
 * Exposed for tests and for the render/HUD side (e.g. a tether that shows the command).
 */
export function servoVcmd(f: InputFrame, s: SimState, phys: LevelPhysics, assist: boolean): number | null {
  const vcap = speedCap(phys, f.fine);
  const it = f.intent;
  let vCmd: number;
  switch (it.kind) {
    case 'force':
      return null;
    case 'target': {
      const xt = Number.isFinite(it.x) ? clampTarget(it.x, phys) : s.x;
      vCmd = clamp(SERVO.kx * (xt - s.x), -vcap, vcap);
      break;
    }
    case 'velocity':
      vCmd = Number.isFinite(it.v) ? clamp(it.v, -vcap, vcap) : 0;
      break;
    case 'idle': {
      // x_hold = the last target (carried in f.targetX), else the current x.
      const xh = f.targetX !== null && Number.isFinite(f.targetX) ? clampTarget(f.targetX, phys) : s.x;
      vCmd = clamp(SERVO.kx * (xh - s.x), -vcap, vcap);
      // Anti-sway assist (§3.6, unranked runs only): only while the intent is idle.
      if (assist) vCmd += SERVO.assistKa * phys.L * Math.sin(s.th);
      break;
    }
  }
  return vCmd;
}

/**
 * §3.2: one quantised force per 60 Hz tick (vcap = speedCap(phys, fine): 4.0 / 1.0, egg levels 2.0 / 0.5).
 *   target:   v_cmd = clamp(KX (x_t - x), ±vcap)
 *   velocity: v_cmd = clamp(v, ±vcap)
 *   idle:     v_cmd = clamp(KX (x_hold - x), ±vcap) [+ KA L sin(th) with assist]
 *   F = clamp(KV (v_cmd - v), ±Fmax); force intent: F = f
 *   q = clamp(round(F 127 / Fmax), ±127)
 */
export function servoQ(f: InputFrame, s: SimState, phys: LevelPhysics, assist: boolean, steady = false): number {
  const Fmax = phys.Fmax;
  let F: number;
  const band = steady ? steadyBand(f, s, phys) : null;
  // Anywhere inside the band is on the goal: the position error is the distance to the band (0 inside), so over
  // the goal the LQR only kills the swing and the trolley comes to rest (§4.6 wants |v| < REST_V) where it is.
  const ex = band ? s.x - clamp(s.x, band[0], band[1]) : 0;
  if (band && !calm(s, phys)) {
    const K = steadyGains(phys);
    F = clamp(-(K[0] * ex + K[1] * s.v + K[2] * s.th + K[3] * s.w), -Fmax, Fmax);
  } else if (band) {
    // Already (nearly) at rest: the plain hold at the nearest point of the band.
    const vCmd = clamp(-SERVO.kx * ex, -speedCap(phys, f.fine), speedCap(phys, f.fine));
    F = clamp(servoKv(phys) * (vCmd - s.v), -Fmax, Fmax);
  } else if (f.intent.kind === 'force') {
    F = f.intent.f;
  } else {
    const vCmd = servoVcmd(f, s, phys, assist) ?? 0;
    F = clamp(servoKv(phys) * (vCmd - s.v), -Fmax, Fmax);
  }
  return quantizeForce(F, Fmax); // integer in [-127, 127], never -0 (D4)
}

/**
 * Where the steady assist takes the ball on this frame (drawn as the target ring), or null when it does not act:
 * only on idle frames, with a hold point within STEADY.reach of the current zone (the hold point clamped into the
 * zone, STEADY.inset from its edges).
 */
export function steadyGoal(f: InputFrame, s: SimState, phys: LevelPhysics): number | null {
  const b = steadyBand(f, s, phys);
  if (!b) return null;
  const xh = f.targetX !== null && Number.isFinite(f.targetX) ? f.targetX : s.x;
  return clamp(xh, b[0], b[1]);
}

/** The trolley x range the steady assist settles in ([xa + inset, xb - inset] of the current zone), or null. */
function steadyBand(f: InputFrame, s: SimState, phys: LevelPhysics): [number, number] | null {
  if (f.intent.kind !== 'idle') return null;
  const z = phys.phases[Math.min(s.phase | 0, phys.phases.length - 1)];
  if (!z) return null;
  const xh = f.targetX !== null && Number.isFinite(f.targetX) ? f.targetX : s.x;
  if (xh < z.xa - STEADY.reach || xh > z.xb + STEADY.reach) return null;
  const inset = Math.min(STEADY.inset, (z.xb - z.xa) / 4);
  return [z.xa + inset, z.xb - inset];
}

/** Swing energy (§4.6) under STEADY.calm of the level's rest energy: the steady assist only holds the trolley. */
function calm(s: SimState, phys: LevelPhysics): boolean {
  const L = phys.L;
  const E = 0.5 * L * L * s.w * s.w + 9.81 * L * (1 - Math.cos(s.th));
  const eRest = 9.81 * L * (1 - Math.cos((phys.restDeg * Math.PI) / 180));
  return E < STEADY.calm * eRest;
}

type Gains = readonly [number, number, number, number];
const gainCache = new Map<string, Gains>();

/**
 * Discrete LQR gains (60 Hz, force held over the tick) of the cart-pendulum linearised at th = 0 (§4.2 with
 * B_TROLLEY 0.3, C_PIVOT 0.002), weights STEADY.q / STEADY.r. Riccati iteration; cached per (M, m, L).
 */
export function steadyGains(phys: LevelPhysics): Gains {
  const key = `${phys.M}|${phys.m}|${phys.L}`;
  const hit = gainCache.get(key);
  if (hit) return hit;
  const { M, m, L } = phys;
  const G = 9.81, Bt = 0.3, Cp = 0.002, h = 1 / 60;
  const det = m * L * L * M, a22 = m * L * L, a12 = m * L;
  const A = [
    [0, 1, 0, 0],
    [0, (-a22 * Bt) / det, (a12 * m * G * L) / det, (a12 * Cp) / det],
    [0, 0, 0, 1],
    [0, (a12 * Bt) / det, (-(M + m) * m * G * L) / det, (-(M + m) * Cp) / det],
  ];
  const Bc = [0, a22 / det, 0, -a12 / det];
  const n = [0, 1, 2, 3];
  const mul = (X: number[][], Y: number[][]): number[][] => n.map((i) => n.map((j) => n.reduce((a, k) => a + X[i]![k]! * Y[k]![j]!, 0)));
  const A2 = mul(A, A), A3 = mul(A2, A);
  // zero-order hold to third order: Ad = I + Ah + A²h²/2 + A³h³/6, Bd = (Ih + Ah²/2 + A²h³/6) B
  const Ad = n.map((i) => n.map((j) => (i === j ? 1 : 0) + A[i]![j]! * h + (A2[i]![j]! * h * h) / 2 + (A3[i]![j]! * h ** 3) / 6));
  const Bd = n.map((i) => n.reduce((a, k) => a + ((i === k ? h : 0) + (A[i]![k]! * h * h) / 2 + (A2[i]![k]! * h ** 3) / 6) * Bc[k]!, 0));
  let P: number[][] = n.map((i) => n.map((j) => (i === j ? STEADY.q[i]! : 0)));
  let K = [0, 0, 0, 0];
  for (let it = 0; it < 4000; it++) {
    const PA = mul(P, Ad);
    const PB = n.map((i) => n.reduce((a, k) => a + P[i]![k]! * Bd[k]!, 0));
    const BPB = n.reduce((a, k) => a + Bd[k]! * PB[k]!, 0);
    const BPA = n.map((j) => n.reduce((a, k) => a + Bd[k]! * PA[k]![j]!, 0));
    const Kn = BPA.map((v) => v / (STEADY.r + BPB));
    const AtPA = n.map((i) => n.map((j) => n.reduce((a, k) => a + Ad[k]![i]! * PA[k]![j]!, 0)));
    P = n.map((i) => n.map((j) => AtPA[i]![j]! - BPA[i]! * Kn[j]! + (i === j ? STEADY.q[i]! : 0)));
    const done = Kn.every((v, i) => Math.abs(v - K[i]!) <= 1e-12 * (1 + Math.abs(v)));
    K = Kn;
    if (done) break;
  }
  const g: Gains = [K[0]!, K[1]!, K[2]!, K[3]!];
  gainCache.set(key, g);
  return g;
}
