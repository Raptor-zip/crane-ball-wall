// Segment / point vs wall-slab distances and the collision rules (GAME_DESIGN.md §4.5, §10.7). Owner: O1.
import { describe, expect, it } from 'vitest';
import {
  pointSlabDist2, segHitsSlab, segHitsSlabA, segSlabClosest, segSlabClosestA, segSlabDist2, type Vec2,
} from '../../src/sim/collide';
import { BALL_R, RAIL_Y } from '../../src/sim/constants';
import { SimEvents } from '../../src/sim/events';
import type { LevelPhysics, WallDef } from '../../src/sim/level';
import {
  CrashKind, createRun, setSlackStateForTest, setTautStateForTest, Status, stepTick,
} from '../../src/sim/run';

// Dyadic numbers so that the expected squared distances are exact in binary.
const W: WallDef = { x0: 1.25, x1: 1.5, h: 0.75 };

/** 20 known configurations: [ax, ay, bx, by, exact d2]. */
const KNOWN: [number, number, number, number, number][] = [
  [1.0, 1.0, 1.0, 0.5, 0.0625],        // 1 vertical, left of the wall
  [1.125, 0.875, 1.625, 0.875, 0.015625], // 2 horizontal, above the top
  [1.125, 0.875, 1.625, 0.625, 0],     // 3 crosses the top face
  [1.0, 1.0, 1.5, 0.5, 0],             // 4 passes exactly through the left top corner (touch = 0)
  [1.0, 1.0, 1.0, 1.0, 0.125],         // 5 degenerate point, diagonal to the corner
  [1.0, 1.0, 1.5, 1.0, 0.0625],        // 6 horizontal above, over the corner
  [0.75, 1.0, 1.25, 1.5, 0.28125],     // 7 closest to the left corner at an interior point of the segment
  [1.0, 0.5, 2.0, 0.5, 0],             // 8 fast pass straight through the wall (both ends far away)
  [1.0, 0.8125, 2.0, 0.8125, 0.00390625], // 9 skims 6.25 cm over the top
  [1.75, 0.25, 2.0, 0.0, 0.0625],      // 10 right of the wall
  [1.3125, 0.125, 1.375, 0.25, 0],     // 11 fully inside
  [1.375, 0.5, 2.0, 1.5, 0],           // 12 one end inside
  [1.375, 1.0, 1.375, 0.875, 0.015625], // 13 vertical above the top
  [1.25, 1.0, 1.25, 0.75, 0],          // 14 vertical, touching the left top corner from above
  [1.0, 2.0, 1.0, 0.0, 0.0625],        // 15 long vertical left of the face
  [1.75, 1.0, 1.75, 1.0, 0.125],       // 16 point diagonal to the right corner
  [1.0, 0.75, 2.0, 0.75, 0],           // 17 horizontal exactly at y = h (touches the top face)
  [0.5, 0.5, 1.0, 0.25, 0.0625],       // 18 below the top, left
  [1.75, 1.0, 1.75, 0.0, 0.0625],      // 19 vertical right of the face
  [1.25, 1.5, 0.75, 1.0, 0.28125],     // 20 = 7 reversed
];

/** Reference distance as in ballwall/geometry.py (sdf with hypot, string_clearance), for random checks. */
function refDist(ax: number, ay: number, bx: number, by: number, w: WallDef): number {
  const sdf = (px: number, py: number): number => {
    const cx = 0.5 * (w.x0 + w.x1);
    const hw = 0.5 * (w.x1 - w.x0);
    const qx = Math.abs(px - cx) - hw;
    const qy = py - w.h;
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0);
  };
  const pseg = (cx: number, cy: number): number => {
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.min(1, Math.max(0, ((cx - ax) * dx + (cy - ay) * dy) / Math.max(dx * dx + dy * dy, 1e-300)));
    return Math.hypot(ax + t * dx - cx, ay + t * dy - cy);
  };
  const lo = Math.min(ax, bx);
  const hi = Math.max(ax, bx);
  const overlap = hi >= w.x0 && lo <= w.x1;
  const dx = bx - ax;
  const yAt = (xq: number): number => (Math.abs(dx) < 1e-12 ? Math.min(ay, by) : ay + (by - ay) * (xq - ax) / dx);
  const xa = Math.min(Math.max(w.x0, lo), hi);
  const xb = Math.min(Math.max(w.x1, lo), hi);
  const yMin = Math.min(yAt(xa), yAt(xb));
  if (overlap && yMin <= w.h) return 0;
  return Math.max(0, Math.min(sdf(ax, ay), sdf(bx, by), pseg(w.x0, w.h), pseg(w.x1, w.h)));
}

describe('segSlabDist2', () => {
  it.each(KNOWN.map((k, i) => [i + 1, ...k] as const))('case %i', (_i, ax, ay, bx, by, want) => {
    expect(segSlabDist2(ax, ay, bx, by, W)).toBe(want);
    const cp: Vec2 = { x: NaN, y: NaN };
    expect(segSlabClosest(ax, ay, bx, by, W, cp)).toBe(want);
    // the reported closest point lies on (or in) the slab and realises the distance
    expect(cp.x).toBeGreaterThanOrEqual(W.x0);
    expect(cp.x).toBeLessThanOrEqual(W.x1);
    expect(cp.y).toBeLessThanOrEqual(W.h);
    expect(segHitsSlab(ax, ay, bx, by, W)).toBe(want === 0);
  });

  it('agrees with the geometry.py definition on 20000 random segments', () => {
    let s = 17;
    const rnd = (): number => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
    const wall: WallDef = { x0: 1.3, x1: 1.42, h: 0.75 };
    let worst = 0;
    for (let i = 0; i < 20000; i++) {
      const ax = 0.8 + rnd() * 1.2;
      const ay = rnd() * 1.3;
      const bx = i % 5 === 0 ? ax : ax + (rnd() - 0.5) * 0.4;
      const by = ay + (rnd() - 0.5) * 0.4;
      const d = Math.sqrt(segSlabDist2(ax, ay, bx, by, wall));
      worst = Math.max(worst, Math.abs(d - refDist(ax, ay, bx, by, wall)));
    }
    expect(worst).toBeLessThan(1e-12);
  });

  it('pointSlabDist2 is 0 inside and exact outside', () => {
    expect(pointSlabDist2(1.375, 0.5, W)).toBe(0);
    expect(pointSlabDist2(1.0, 0.5, W)).toBe(0.0625);
    expect(pointSlabDist2(1.375, 1.0, W)).toBe(0.0625);
    expect(pointSlabDist2(1.75, 1.0, W)).toBe(0.125);
  });
});

function lvl(walls: WallDef[], rail: [number, number] = [-1, 3.2], L = 1): LevelPhysics {
  return { M: 2, m: 1, L, Fmax: 40, rail, startX: 0, walls, phases: [{ kind: 'pad', xa: 2.9, xb: 3.0 }], restDeg: 3 };
}

describe('collision rules in the stepper', () => {
  it('(a) catches a ball that tunnels through a thin wall within one substep', () => {
    // slack ball flying at 30 m/s: 25 cm per substep, both end points are > r from the 2 cm wall
    const wall: WallDef = { x0: 1.3, x1: 1.32, h: 0.6 };
    const run = createRun(lvl([wall]));
    setSlackStateForTest(run, 1.3, 0, 1.19, 0.5, 30, 0);
    const ev = new SimEvents();
    expect(stepTick(run, 0, ev)).toBe(Status.Crash);
    expect(run.s.crash!.kind).toBe(CrashKind.Ball);
    expect(run.s.crash!.wall).toBe(0);
    expect(run.s.substep).toBe(1);
    expect(run.s.crash!.d2).toBe(0);
    // contact point: where the centre path enters the slab
    expect(run.s.crash!.px).toBeCloseTo(1.3, 12);
    expect(run.s.minD2).toBe(0);
  });

  it('(a) keeps the run alive when the ball passes at 1 mm (d2 >= r^2)', () => {
    // hanging ball drifting right towards a wall face with a 1 mm gap at the end
    const wall: WallDef = { x0: 0.4, x1: 0.5, h: 0.5 };
    const run = createRun(lvl([wall]));
    // ball centre at x = 0.4 - r - 0.001 after a tiny move: put it there and let it rest
    setTautStateForTest(run, 0.4 - BALL_R - 0.001, 0, 0, 0);
    const ev = new SimEvents();
    expect(stepTick(run, 0, ev)).toBe(Status.Running);
    expect(run.s.minD2).toBeGreaterThan(BALL_R * BALL_R);
    expect(run.s.near.wall).toBe(0);
    expect(Math.sqrt(run.s.near.d2) - BALL_R).toBeCloseTo(0.001, 9);
  });

  it('(b) crashes when the string lies across a wall top (pulling out of a pocket)', () => {
    // 2-3 situation: ball resting in the gap, trolley yanked left so the string hits wall A's corner
    const walls: WallDef[] = [{ x0: 1.3, x1: 1.42, h: 0.75 }, { x0: 1.84, x1: 1.96, h: 0.75 }];
    const run = createRun(lvl(walls));
    setTautStateForTest(run, 1.63, 0, 0, 0);
    const ev = new SimEvents();
    let st: Status = Status.Running;
    for (let k = 0; k < 120 && st === Status.Running; k++) st = stepTick(run, -127, ev);
    expect(st).toBe(Status.Crash);
    expect(run.s.crash!.kind).toBe(CrashKind.String);
    expect(run.s.crash!.wall).toBe(0);
    // the contact is on wall A (top face or its corner)
    expect(run.s.crash!.px).toBeGreaterThanOrEqual(1.3 - 1e-12);
    expect(run.s.crash!.px).toBeLessThanOrEqual(1.42 + 1e-12);
    expect(run.s.crash!.py).toBeLessThanOrEqual(0.75 + 1e-12);
  });

  it('(b) corner sweep: the string crosses a top corner between two substeps without either chord touching the slab', () => {
    // pivot pinned right above a thin, tall wall; the ball jumps over it within one substep (extreme speed)
    const wall: WallDef = { x0: 1.0, x1: 1.01, h: 0.9 };
    const run = createRun(lvl([wall], [-1, 1.005]));
    setSlackStateForTest(run, 1.005, 0, 0.8, 1.0, 0.41 * 120, 0, 1);
    const ev = new SimEvents();
    stepTick(run, 127, ev);
    expect(run.s.status).toBe(Status.Crash);
    expect(run.s.crash!.kind).toBe(CrashKind.String);
    expect([run.s.crash!.px, run.s.crash!.py]).toEqual([1.0, 0.9]);
    // neither chord intersected the slab: it was the corner sweep that fired
    expect(segHitsSlab(1.005, RAIL_Y, 0.8, 1.0, wall)).toBe(false);
  });

  it('(c) beam and (d) floor', () => {
    const run = createRun(lvl([]));
    setSlackStateForTest(run, 0, 0, 0.9, 1.2, 0, 3);
    const ev = new SimEvents();
    expect(stepTick(run, 0, ev)).toBe(Status.Crash);
    expect(run.s.crash!.kind).toBe(CrashKind.Beam);
    // the floor is out of reach for L <= 1 (validateLevel); a 1.3 m string reaches it
    const run2 = createRun(lvl([], [-1, 3.2], 1.3));
    setSlackStateForTest(run2, 0, 0, 0, 0.07, 0, -3);
    expect(stepTick(run2, 0, ev)).toBe(Status.Crash);
    expect(run2.s.crash!.kind).toBe(CrashKind.Floor);
  });

  it('WallCross fires once per crossing with the window minimum', () => {
    const wall: WallDef = { x0: 1.3, x1: 1.42, h: 0.3 };
    const run = createRun(lvl([wall]));
    // ball flying over the wall at 0.5 m height, 2 m/s to the right (slack, trolley far behind)
    setSlackStateForTest(run, 0.9, 0, 1.0, 0.55, 2, 0);
    const ev = new SimEvents();
    const crosses: number[][] = [];
    let windowMin = Infinity;
    for (let k = 0; k < 30; k++) {
      stepTick(run, 0, ev);
      for (let i = 0; i < ev.n; i++) if (ev.kind[i] === 4) crosses.push([ev.a[i]!, ev.b[i]!, ev.c[i]!]);
      if (crosses.length === 0 && Math.abs(run.s.bx - 1.36) < 0.06 + 0.3) windowMin = Math.min(windowMin, run.s.near.d2);
      if (run.s.status !== Status.Running || crosses.length > 0) break;
    }
    expect(run.s.status).toBe(Status.Running);
    expect(crosses).toHaveLength(1);
    expect(crosses[0]![0]).toBe(0);
    expect(crosses[0]![1]).toBe(1);
    // the ball keeps falling, so the window minimum is reached at the crossing (about 9 cm over the top)
    expect(crosses[0]![2]).toBeLessThanOrEqual(windowMin);
    expect(Math.sqrt(crosses[0]![2]!)).toBeGreaterThan(0.08);
    expect(Math.sqrt(crosses[0]![2]!)).toBeLessThan(0.1);
  });
});

describe('array forms used by the stepper', () => {
  it('segSlabClosestA / segHitsSlabA equal segSlabClosest / segHitsSlab bit for bit', () => {
    let s = 99;
    const rnd = (): number => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
    const walls: WallDef[] = [{ x0: 1.3, x1: 1.42, h: 0.75 }, W, { x0: 0.5, x1: 0.52, h: 0.3 }];
    const seg = new Float64Array(4);
    const out = new Float64Array(3);
    const cp: Vec2 = { x: 0, y: 0 };
    let bad = 0;
    for (let i = 0; i < 50000; i++) {
      const wall = walls[i % 3]!;
      seg[0] = 0.3 + rnd() * 1.6;
      seg[1] = rnd() * 1.3;
      seg[2] = i % 7 === 0 ? seg[0] : seg[0] + (rnd() - 0.5) * 0.5;
      seg[3] = i % 11 === 0 ? seg[1] : seg[1] + (rnd() - 0.5) * 0.5;
      segSlabClosestA(seg, wall, out);
      const d = segSlabClosest(seg[0]!, seg[1]!, seg[2]!, seg[3]!, wall, cp);
      if (!Object.is(out[0], d) || !Object.is(out[1], cp.x) || !Object.is(out[2], cp.y)) bad++;
      if (segHitsSlabA(seg, wall) !== segHitsSlab(seg[0]!, seg[1]!, seg[2]!, seg[3]!, wall)) bad++;
    }
    for (const [ax, ay, bx, by] of KNOWN) {
      seg.set([ax, ay, bx, by]);
      segSlabClosestA(seg, W, out);
      const d = segSlabClosest(ax, ay, bx, by, W, cp);
      if (!Object.is(out[0], d) || !Object.is(out[1], cp.x) || !Object.is(out[2], cp.y)) bad++;
    }
    expect(bad).toBe(0);
  });
});
