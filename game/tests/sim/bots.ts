// Deterministic bots for golden replays, fuzz-free regression and fixtures (GAME_DESIGN.md §10.7). Owner: O1.
//
// A bot is a closed-loop policy q = f(state, tick) run on the real simulator; it records the q sequence.
// Only deterministic operations are used (detmath sincos, + - * /, Math.round/abs/min/max), so the same
// bot produces the same q sequence on every engine. The servo is the §3.2 formula inlined here
// (the production servo lives in src/input/servo.ts, owned by O4).
import { Q_MAX } from '../../src/sim/constants';
import { sincos } from '../../src/sim/detmath';
import { SimEvents } from '../../src/sim/events';
import type { LevelPhysics } from '../../src/sim/level';
import { createRun, Status, stepTick, type SimState } from '../../src/sim/run';

const SC = new Float64Array(2);

export const KX = 5.0;
export const KV_PER_KG = 20 / 3;
export const V_CAP = 4.0;
export const V_CAP_FINE = 1.0;
export const ASSIST_KA = 3.0;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** q of a force F (N): clamp(round(F*127/Fmax), -127, 127). */
export function qOfForce(F: number, Fmax: number): number {
  return clamp(Math.round((F * Q_MAX) / Fmax), -Q_MAX, Q_MAX);
}

/** §3.2 servo, 'target' intent (optionally fine and with the §3.6 anti-sway assist). Returns q. */
export function servoTarget(s: SimState, phys: LevelPhysics, xt: number, fine = false, assist = false): number {
  const vcap = fine ? V_CAP_FINE : V_CAP;
  let vc = clamp(KX * (xt - s.x), -vcap, vcap);
  if (assist) {
    sincos(s.th, SC);
    vc += ASSIST_KA * phys.L * SC[0]!;
  }
  const KV = KV_PER_KG * (phys.M + phys.m);
  const F = clamp(KV * (vc - s.v), -phys.Fmax, phys.Fmax);
  return qOfForce(F, phys.Fmax);
}

export type Policy = (s: SimState, tick: number) => number;

/** Runs a policy from the level start until the run ends or maxTicks; returns the q sequence. */
export function runBot(phys: LevelPhysics, policy: Policy, maxTicks: number): Int8Array {
  const run = createRun(phys);
  const ev = new SimEvents();
  const qs: number[] = [];
  for (let k = 0; k < maxTicks; k++) {
    const q = clamp(policy(run.s, k), -Q_MAX, Q_MAX);
    qs.push(q);
    if (stepTick(run, q, ev) !== Status.Running) break;
  }
  return Int8Array.from(qs);
}

// ---- the six bots of §10.7 ------------------------------------------------------------------------

/** dash-brake: plain servo to a target (accelerate, brake, let the ball swing). */
export function dashBrake(xt: number): (p: LevelPhysics) => Policy {
  return (p) => (s) => servoTarget(s, p, xt);
}

/** pump: push against the swing (resonance) for `pumpTicks`, then servo to xt with the assist. */
export function pump(pumpTicks: number, xt: number): (p: LevelPhysics) => Policy {
  return (p) => {
    const xc = p.startX;
    return (s, k) => {
      if (k < pumpTicks) {
        if (s.x > xc + 0.6) return -Q_MAX;
        if (s.x < xc - 0.6) return Q_MAX;
        return s.w > 0 ? -Q_MAX : Q_MAX;
      }
      return servoTarget(s, p, xt, false, true);
    };
  };
}

/** slam-stop: target 0.3 m beyond the right rail end: full speed into the stopper, then stay pinned. */
export function slamStop(): (p: LevelPhysics) => Policy {
  return (p) => (s) => servoTarget(s, p, p.rail[1] + 0.3);
}

/** slack-snap: full throttle, then full reverse (the string goes slack and snaps), then hold with the assist. */
export function slackSnap(accTicks: number, brakeTicks: number): (p: LevelPhysics) => Policy {
  return (p) => {
    let hold = NaN;
    return (s, k) => {
      if (k < accTicks) return Q_MAX;
      if (k < accTicks + brakeTicks) return -Q_MAX;
      if (hold !== hold) hold = s.x;
      return servoTarget(s, p, hold, false, true);
    };
  };
}

/** carry: slow (fine) servo with the anti-sway assist to the target: arrives calm. */
export function carry(xt: number): (p: LevelPhysics) => Policy {
  return (p) => (s) => servoTarget(s, p, xt, true, true);
}

/** random-seeded: piecewise-constant random q (mulberry32), held 5..40 ticks. */
export function randomSeeded(seed: number): (p: LevelPhysics) => Policy {
  return () => {
    let a = seed >>> 0;
    const rnd = (): number => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    let q = 0;
    let left = 0;
    return () => {
      if (left <= 0) {
        q = Math.floor(rnd() * 255) - 127;
        if (q === 0) q = 1;
        left = 5 + Math.floor(rnd() * 36);
      }
      left--;
      return q;
    };
  };
}

/**
 * random-seeded, random-walk flavour: q moves by a random step of -30..+30 every tick (mulberry32), like a
 * jittery touch drag. On 1-1 with seed 1001 it holds the trolley against the right end while the ball swings
 * and reaches the §4.4 step 8 edge case where the free xdd turns back within a substep (run.ts railHitTaut).
 */
export function randomWalk(seed: number): (p: LevelPhysics) => Policy {
  return () => {
    let a = seed >>> 0;
    const rnd = (): number => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    let q = 1;
    return () => {
      q = clamp(q + Math.floor(rnd() * 61) - 30, -Q_MAX, Q_MAX);
      return q;
    };
  };
}

// ---- 1-1 clearing bot (bot_1-1_success.json) --------------------------------------------------------

/**
 * Bang-bang opening (+127 for a ticks, -127 for b ticks) followed by the fine servo with the assist
 * holding the trolley where the braking ended. A deterministic grid search picks (a, b) with the best
 * score. Used to build tests/fixtures/bot_1-1_success.json.
 */
export function bangBang(a: number, b: number): (p: LevelPhysics) => Policy {
  return (p) => {
    let hold = NaN;
    return (s, k) => {
      if (k < a) return Q_MAX;
      if (k < a + b) return -Q_MAX;
      if (hold !== hold) hold = s.x;
      return servoTarget(s, p, hold, true, true);
    };
  };
}
