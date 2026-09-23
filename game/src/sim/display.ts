// Display-only helpers (GAME_DESIGN.md §10.1, §5.3). Owner: O1.
// This file is EXEMPT from the src/sim ban rules (§4.3): it may use Math.sqrt / acos.
// It must never be imported by the deterministic simulation code.
import { BALL_R, BEAM_Y, G, RAIL_Y } from './constants';
import type { LevelPhysics } from './level';

export interface LevelFacts { reqDeg: number[]; beamDeg: number; gapCm: number | null; periodS: number; wallH: number[] }

const RAD2DEG = 180 / Math.PI;

function acosDeg(c: number): number {
  return Math.acos(c > 1 ? 1 : c < -1 ? -1 : c) * RAD2DEG;
}

/**
 * (sqrt(minD2) - r) in metres: the ball-surface clearance for a squared centre distance.
 * +Infinity when minD2 is +Infinity (a level without walls). Used by UI and Worker.
 */
export function ballClearanceM(minD2: number): number {
  return Math.sqrt(minD2) - BALL_R;
}

/**
 * Values for the §5.3 placeholders and the HUD required-angle arc (unrounded; formatting is the UI's job):
 * - reqDeg[i]: string angle at which the ball centre passes at h_i + r, acos((RAIL_Y - h - r)/L)
 *   (0 when the wall is below the hanging ball),
 * - beamDeg: angle at which the ball hits the beam, acos((RAIL_Y + r - BEAM_Y)/L) = acos(0.01/L),
 * - gapCm: mouth width of the first pocket zone in cm, rounded to 1e-7 cm (null without a pocket),
 * - periodS: 2*pi*sqrt(L/g) (pendulum with the trolley held),
 * - wallH: wall heights in m.
 */
export function levelFacts(phys: LevelPhysics): LevelFacts {
  const L = phys.L;
  const reqDeg = phys.walls.map((w) => acosDeg((RAIL_Y - w.h - BALL_R) / L));
  const beamDeg = acosDeg((RAIL_Y + BALL_R - BEAM_Y) / L);
  const pocket = phys.phases.find((z) => z.kind === 'pocket');
  const gapCm = pocket ? Math.round((pocket.xb - pocket.xa) * 1e9) / 1e7 : null; // 1.84 - 1.42 -> 42, not 41.999...
  const periodS = 2 * Math.PI * Math.sqrt(L / G);
  return { reqDeg, beamDeg, gapCm, periodS, wallH: phys.walls.map((w) => w.h) };
}
