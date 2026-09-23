// Physics port proof against the research planner (GAME_DESIGN.md §8.4 item 10, §10.7). Owner: O1.
// tests/fixtures/plans_py.json: the 4 research seeds + the 2-2 `ai` plan; X[:, k] = [x, v, th, w] at t[k],
// U[k] held on [t[k], t[k+1]), each interval = 2 RK4 substeps of dt/2. The force is fed unquantised.
import { describe, expect, it } from 'vitest';
import plans from '../fixtures/plans_py.json';
import { stepTautForTest, tensionFree } from '../../src/sim/dynamics';
import { B_TROLLEY, C_PIVOT, G } from '../../src/sim/constants';
import type { LevelPhysics } from '../../src/sim/level';

interface Plan {
  name: string;
  T: number;
  N: number;
  dt: number;
  substeps: number;
  plant: { M: number; m: number; L: number; g: number; b: number; c: number };
  t: number[];
  X: number[][];
  U: number[];
}

const list = (plans as { plans: Plan[] }).plans;

function physOf(p: Plan): LevelPhysics {
  return {
    M: p.plant.M, m: p.plant.m, L: p.plant.L, Fmax: 40, rail: [-100, 100], startX: 0,
    walls: [], phases: [{ kind: 'pad', xa: 50, xb: 51 }], restDeg: 3,
  };
}

function node(p: Plan, k: number): number[] {
  return [p.X[0]![k]!, p.X[1]![k]!, p.X[2]![k]!, p.X[3]![k]!];
}

it('has the 4 research seeds and the 2-2 ai plan', () => {
  expect(list.map((p) => p.name)).toEqual(['enter_fast', 'enter_pump', 'escape_fast', 'escape_pump', '2-2/ai']);
  for (const p of list) {
    expect([p.plant.g, p.plant.b, p.plant.c]).toEqual([G, B_TROLLEY, C_PIVOT]);
    expect(p.substeps).toBe(2);
    expect(p.U).toHaveLength(p.N);
    expect(p.X[0]).toHaveLength(p.N + 1);
  }
});

describe.each(list.map((p) => [p.name, p] as const))('plan %s', (_name, p) => {
  const phys = physOf(p);
  const h = p.dt / p.substeps;

  it('per interval: X[k] -> X[k+1] within 1e-6 m / 1e-6 rad', () => {
    let worst = 0;
    const s = new Float64Array(4);
    for (let k = 0; k < p.N; k++) {
      s.set(node(p, k));
      for (let j = 0; j < p.substeps; j++) stepTautForTest(phys, s, p.U[k]!, h);
      const want = node(p, k + 1);
      for (let i = 0; i < 4; i++) {
        // x (0) and th (2) are the positions of the §8.4 criterion; check the rates with the same bound
        worst = Math.max(worst, Math.abs(s[i]! - want[i]!));
      }
    }
    expect(worst).toBeLessThanOrEqual(1e-6);
  });

  it('open loop: every node within 1e-3 m / 1e-3 rad, tension always positive', () => {
    const s = Float64Array.from(node(p, 0));
    let worst = 0;
    let minT = Infinity;
    for (let k = 0; k < p.N; k++) {
      const F = p.U[k]!;
      for (let j = 0; j < p.substeps; j++) {
        minT = Math.min(minT, tensionFree(phys.M, phys.m, phys.L, s[1]!, s[2]!, s[3]!, F));
        stepTautForTest(phys, s, F, h);
      }
      const want = node(p, k + 1);
      worst = Math.max(worst, Math.abs(s[0]! - want[0]!), Math.abs(s[2]! - want[2]!));
    }
    expect(worst).toBeLessThanOrEqual(1e-3);
    expect(minT).toBeGreaterThan(0);
  });
});
