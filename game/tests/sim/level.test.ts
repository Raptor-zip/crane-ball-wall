// levelHash / canonicalJson / validateLevel (GAME_DESIGN.md §6.1) and display helpers (§5.3). Owner: O1.
import { describe, expect, it } from 'vitest';
import vectors from '../fixtures/levelhash_vectors.json';
import levelsJson from '../../src/data/levels.json';
import { canonicalJson, levelHash, validateLevel, type LevelDef, type LevelPhysics, type LevelsFile } from '../../src/sim/level';
import { ballClearanceM, levelFacts } from '../../src/sim/display';

const levels = (levelsJson as unknown as LevelsFile).levels;

describe('levelHash', () => {
  const vs = (vectors as { vectors: { id: string; physics: Record<string, unknown>; canonical: string; hash: string }[] }).vectors;
  it.each(vs.map((v) => [v.id, v] as const))('matches the Python vector %s', (_id, v) => {
    expect(canonicalJson(v.physics)).toBe(v.canonical);
    expect(levelHash(v.physics as unknown as LevelPhysics)).toBe(v.hash);
  });

  it('ignores key order and undefined keys, not values', () => {
    const a: LevelPhysics = { M: 2, m: 1, L: 1, Fmax: 40, rail: [-1, 3.2], startX: 0, walls: [], phases: [{ kind: 'pad', xa: 1, xb: 2 }], restDeg: 3 };
    const b = { restDeg: 3, phases: [{ xb: 2, xa: 1, kind: 'pad' }], walls: [], startX: 0, rail: [-1, 3.2], Fmax: 40, L: 1, m: 1, M: 2, egg: undefined } as unknown as LevelPhysics;
    expect(levelHash(b)).toBe(levelHash(a));
    expect(levelHash({ ...a, restDeg: 3.5 })).not.toBe(levelHash(a));
    expect(levelHash(a)).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('validateLevel', () => {
  it('accepts all 18 campaign levels of levels.json', () => {
    expect(levels).toHaveLength(18);
    for (const l of levels) expect(() => validateLevel(l), l.id).not.toThrow();
  });

  const base = (): LevelDef => JSON.parse(JSON.stringify(levels.find((l) => l.id === '2-2'))) as LevelDef;
  const bad: [string, (d: LevelDef) => void, RegExp][] = [
    ['walls out of order', (d) => d.physics.walls.reverse(), /order/],
    ['overlapping walls', (d) => (d.physics.walls[1]!.x0 = 1.4), /overlap/],
    ['zero-width wall', (d) => (d.physics.walls[0]!.x1 = d.physics.walls[0]!.x0), /width/],
    ['wall too high', (d) => (d.physics.walls[0]!.h = 0.96), /height/],
    ['wall off the rail', (d) => { d.physics.walls[1]!.x0 = 3.6; d.physics.walls[1]!.x1 = 3.8; }, /outside/],
    ['five walls', (d) => { d.physics.walls = [0, 1, 2, 3, 4].map((i) => ({ x0: 1 + i * 0.3, x1: 1.1 + i * 0.3, h: 0.3 })); }, /max 4/],
    ['start outside the rail', (d) => (d.physics.startX = -1), /startX/],
    ['string too short', (d) => (d.physics.L = 0.29), /L /],
    ['string too long', (d) => (d.physics.L = 1.01), /L /],
    ['no mass', (d) => (d.physics.m = 0), /m 0/],
    ['too strong', (d) => (d.physics.Fmax = 41), /Fmax/],
    ['restDeg 0', (d) => (d.physics.restDeg = 0), /restDeg/],
    ['restDeg 7', (d) => (d.physics.restDeg = 7), /restDeg/],
    ['no phases', (d) => (d.physics.phases = []), /phases/],
    ['three phases', (d) => d.physics.phases.push({ kind: 'pad', xa: 0, xb: 1 }, { kind: 'pad', xa: 0, xb: 1 }), /phases/],
    ['empty zone', (d) => (d.physics.phases[0]!.xb = d.physics.phases[0]!.xa), /empty/],
    ['zone centre off the rail', (d) => { d.physics.phases[0] = { kind: 'pad', xa: 3.3, xb: 3.5 }; d.ai.xGoal = [3.4]; }, /centre/],
    ['ball starts against a wall', (d) => (d.physics.startX = 1.25), /1 cm|string/],
    ['ball starts in the zone', (d) => (d.physics.startX = 1.63), /zone|wall/],
    ['xGoal count', (d) => (d.ai.xGoal = [1.63, 1.63]), /xGoal/],
    ['xGoal outside the zone', (d) => (d.ai.xGoal = [1.0]), /xGoal/],
    ['split on a missing wall', (d) => (d.splits = [{ wall: 2, dir: 1 }]), /split/],
    ['split on a missing phase', (d) => (d.splits = [{ phase: 1 }]), /split/],
    ['campaign without hints', (d) => delete d.hints, /hints/],
    ['egg without egg physics', (d) => (d.cargo = 'egg'), /egg/],
    ['egg that cracks at rest', (d) => { d.cargo = 'egg'; d.physics.egg = { Tmax: 9.8, Jmax: 0.3 }; }, /crack/],
    ['egg physics on a ball level', (d) => (d.physics.egg = { Tmax: 16, Jmax: 0.3 }), /ball level/],
  ];
  it.each(bad)('rejects: %s', (_n, mutate, why) => {
    const d = base();
    mutate(d);
    expect(() => validateLevel(d)).toThrow(why);
  });

  it('accepts a daily level without hints and a composed level without xGoal checks', () => {
    const d = base();
    d.world = 0;
    d.id = 'd:0';
    delete d.hints;
    expect(() => validateLevel(d)).not.toThrow();
    const c = JSON.parse(JSON.stringify(levels.find((l) => l.id === '5-4'))) as LevelDef;
    c.ai.xGoal = [];
    expect(() => validateLevel(c)).not.toThrow();
  });
});

describe('display helpers', () => {
  it('levelFacts gives the §5.1 / §5.3 numbers', () => {
    const f = levelFacts(levels.find((l) => l.id === '2-2')!.physics);
    expect(f.reqDeg.map((d) => Math.round(d * 10) / 10)).toEqual([63.9, 63.9]);
    expect(f.gapCm).toBe(42);
    expect(f.periodS).toBeCloseTo(2.006, 3);
    expect(f.beamDeg).toBeCloseTo(89.43, 2);
    expect(f.wallH).toEqual([0.75, 0.75]);
    const f33 = levelFacts(levels.find((l) => l.id === '3-3')!.physics);
    expect(Math.round(f33.reqDeg[0]! * 10) / 10).toBe(49.5);
    expect(f33.periodS).toBeCloseTo(1.554, 3);
    expect(Math.round(levelFacts(levels.find((l) => l.id === '5-3')!.physics).reqDeg[0]! * 10) / 10).toBe(73.1);
    const f11 = levelFacts(levels.find((l) => l.id === '1-1')!.physics);
    expect(f11.reqDeg).toEqual([]);
    expect(f11.gapCm).toBeNull();
    expect(levelFacts(levels.find((l) => l.id === '2-4')!.physics).gapCm).toBe(30);
  });

  it('ballClearanceM', () => {
    expect(ballClearanceM(0.07 * 0.07)).toBeCloseTo(0.01, 12);
    expect(ballClearanceM(0.06 * 0.06)).toBeCloseTo(0, 12);
    expect(ballClearanceM(Infinity)).toBe(Infinity);
  });
});
