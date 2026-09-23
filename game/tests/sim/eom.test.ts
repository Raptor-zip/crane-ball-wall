// Taut-string equations of motion vs the Python model (GAME_DESIGN.md §4.2, §10.7). Owner: O1.
// tests/fixtures/eom_py.json: ballwall.dynamics.rhs + classic RK4, h = 1/120, F held for 2 substeps per tick.
import { describe, expect, it } from 'vitest';
import eom from '../fixtures/eom_py.json';
import { stepTautForTest } from '../../src/sim/dynamics';
import { forceOfQ } from '../../src/sim/run';
import { B_TROLLEY, C_PIVOT, G, H } from '../../src/sim/constants';
import type { LevelPhysics } from '../../src/sim/level';

interface EomCase {
  name: string;
  plant: { M: number; m: number; L: number; g: number; b: number; c: number };
  Fmax: number;
  q: number[];
  F: number[];
  s0: number[];
  every: number;
  states: number[][];
  first: number[][];
  minTension: number;
}

const cases = (eom as { cases: EomCase[] }).cases;

function physOf(c: EomCase): LevelPhysics {
  return {
    M: c.plant.M, m: c.plant.m, L: c.plant.L, Fmax: c.Fmax, rail: [-100, 100], startX: 0,
    walls: [], phases: [{ kind: 'pad', xa: 50, xb: 51 }], restDeg: 3,
  };
}

function maxDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let d = 0;
  for (let i = 0; i < 4; i++) d = Math.max(d, Math.abs(a[i]! - b[i]!));
  return d;
}

describe('eom_py.json fixture', () => {
  it('uses the same plant constants and h', () => {
    expect((eom as { h: number }).h).toBe(H);
    expect(cases).toHaveLength(8);
    for (const c of cases) {
      expect([c.plant.g, c.plant.b, c.plant.c]).toEqual([G, B_TROLLEY, C_PIVOT]);
      // F[k] = q[k]*Fmax/127 in that order, i.e. forceOfQ
      c.q.forEach((q, k) => expect(forceOfQ(q, c.Fmax)).toBe(c.F[k]));
    }
  });
});

describe.each(cases.map((c) => [c.name, c] as const))('stepTautForTest vs Python: %s', (_name, c) => {
  it('agrees to 1e-9 up to 4 s and 1e-7 up to 12 s', () => {
    const phys = physOf(c);
    const s = Float64Array.from(c.s0);
    let sub = 0;
    let worst4 = 0;
    let worst12 = 0;
    let worstFirst = 0;
    for (const F of c.F) {
      for (let k = 0; k < 2; k++) {
        stepTautForTest(phys, s, F, H);
        sub++;
        if (sub <= c.first.length) worstFirst = Math.max(worstFirst, maxDiff(s, c.first[sub - 1]!));
        if (sub % c.every === 0) {
          const d = maxDiff(s, c.states[sub / c.every]!);
          if (sub <= 480) worst4 = Math.max(worst4, d);
          worst12 = Math.max(worst12, d);
        }
      }
    }
    expect(sub).toBe(1440);
    expect(worstFirst).toBeLessThanOrEqual(1e-12);
    expect(worst4).toBeLessThanOrEqual(1e-9);
    expect(worst12).toBeLessThanOrEqual(1e-7);
  });
});
