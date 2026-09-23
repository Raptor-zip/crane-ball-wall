// Frozen copies of level physics for the simulator tests (GAME_DESIGN.md §5.1). Owner: O1.
// Golden replays, fuzz and bench must not change when src/data/levels.json is edited (fallbacks, retunes),
// so they use these copies. golden_replays.json also stores the physics it was made with.
import type { LevelPhysics } from '../../src/sim/level';

export const FIXED: Record<string, LevelPhysics> = {
  '1-1': { M: 2, m: 1, L: 1, Fmax: 40, rail: [-0.6, 2.4], startX: 0, walls: [], phases: [{ kind: 'pad', xa: 1.2, xb: 1.8 }], restDeg: 5 },
  '1-3': {
    M: 2, m: 1, L: 1, Fmax: 40, rail: [-1, 2.8], startX: 0, walls: [{ x0: 1, x1: 1.12, h: 0.55 }],
    phases: [{ kind: 'pad', xa: 1.85, xb: 2.15 }], restDeg: 3,
  },
  '2-2': {
    M: 2, m: 1, L: 1, Fmax: 40, rail: [-1, 3.2], startX: 0,
    walls: [{ x0: 1.3, x1: 1.42, h: 0.75 }, { x0: 1.84, x1: 1.96, h: 0.75 }],
    phases: [{ kind: 'pocket', xa: 1.42, xb: 1.84 }], restDeg: 3,
  },
  '2-3': {
    M: 2, m: 1, L: 1, Fmax: 40, rail: [-1, 3.2], startX: 1.63,
    walls: [{ x0: 1.3, x1: 1.42, h: 0.75 }, { x0: 1.84, x1: 1.96, h: 0.75 }],
    phases: [{ kind: 'pad', xa: -0.15, xb: 0.15 }], restDeg: 3,
  },
  '3-3': {
    M: 2, m: 1, L: 0.6, Fmax: 10, rail: [-1, 3.2], startX: 0,
    walls: [{ x0: 1, x1: 1.1, h: 0.8 }, { x0: 1.46, x1: 1.56, h: 0.8 }],
    phases: [{ kind: 'pocket', xa: 1.1, xb: 1.46 }], restDeg: 3,
  },
  '4-2': {
    M: 2, m: 1, L: 1, Fmax: 40, rail: [-0.6, 2.4], startX: 0, walls: [{ x0: 1.2, x1: 1.3, h: 0.5 }],
    phases: [{ kind: 'pad', xa: 2.24, xb: 2.44 }], restDeg: 3,
  },
  // egg.Tmax is deliberately 16, not the 18 the game now uses (v1.1 R6): freezing it keeps golden_replays.json,
  // the fuzz seeds and the bench stable across level retunes, which is the whole point of this file.
  '4-3': {
    M: 2, m: 1, L: 1, Fmax: 40, rail: [-1, 3.2], startX: 0, walls: [{ x0: 0.9, x1: 1.02, h: 0.4 }],
    phases: [{ kind: 'pad', xa: 1.6, xb: 2 }], restDeg: 3, egg: { Tmax: 16, Jmax: 0.3 },
  },
  '5-1': {
    M: 2, m: 3, L: 1, Fmax: 40, rail: [-1, 3.2], startX: 0,
    walls: [{ x0: 1.3, x1: 1.42, h: 0.7 }, { x0: 1.84, x1: 1.96, h: 0.7 }],
    phases: [{ kind: 'pocket', xa: 1.42, xb: 1.84 }], restDeg: 2.5,
  },
  '5-4': {
    M: 2, m: 1, L: 1, Fmax: 40, rail: [-1, 3.2], startX: 0,
    walls: [{ x0: 1.3, x1: 1.42, h: 0.75 }, { x0: 1.84, x1: 1.96, h: 0.75 }],
    phases: [{ kind: 'pocket', xa: 1.42, xb: 1.84 }, { kind: 'pad', xa: -0.15, xb: 0.15 }], restDeg: 3,
  },
};

export function fixedLevel(id: string): LevelPhysics {
  const p = FIXED[id];
  if (!p) throw new Error(`no fixed physics for ${id}`);
  return p;
}
