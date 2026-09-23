// Rule helpers of §4.5 / §4.6 shared by the stepper (run.ts) and tests. Owner: O1.
// Internal to src/sim (not part of contracts). The per-substep rule sequence itself lives in run.ts.
import { G } from './constants';
import { sincos } from './detmath';
import type { LevelPhysics, ZoneDef } from './level';

const SC = new Float64Array(2);

/** Radians of an angle given in degrees: deg*PI/180 (fixed order). */
export function degToRad(deg: number): number {
  return deg * Math.PI / 180;
}

/** E_rest = G*L*(1 - cos(restDeg*pi/180)), computed once per run with detmath (§4.6). */
export function restEnergy(phys: LevelPhysics): number {
  sincos(degToRad(phys.restDeg), SC);
  return G * phys.L * (1 - SC[1]!);
}

/** Swing energy per unit mass E = 0.5*L*L*w*w + G*L*(1 - cos(th)) (§4.6), given cos(th). */
export function swingEnergy(L: number, w: number, cs: number): number {
  return 0.5 * L * L * w * w + G * L * (1 - cs);
}

/** Zone test of §4.6 on the ball-centre x (inclusive). */
export function inZone(z: ZoneDef, bx: number): boolean {
  return z.xa <= bx && bx <= z.xb;
}
