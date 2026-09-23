// Run lifecycle and the §4.6 rules: hold, phases, success timing, time-up, state copy / restore. Owner: O1.
import { describe, expect, it } from 'vitest';
import { pointSlabClosest, pointSlabDist2 } from '../../src/sim/collide';
import { BALL_R, G, HOLD_SUB, MAX_SUB, RAIL_Y } from '../../src/sim/constants';
import { Ev, SimEvents } from '../../src/sim/events';
import type { LevelPhysics } from '../../src/sim/level';
import { hashSimState, simulateReplay } from '../../src/sim/replay';
import {
  copyState, createRun, CrashKind, Mode, newSimState, resetRun, restoreState, setTautStateForTest, Status, stepTick,
} from '../../src/sim/run';
import { restEnergy } from '../../src/sim/rules';
import { carry, runBot, servoTarget } from './bots';
import { fixedLevel } from './levels_fixed';

const TWO_PADS: LevelPhysics = {
  M: 2, m: 1, L: 1, Fmax: 40, rail: [-1, 3.2], startX: 0, walls: [],
  phases: [{ kind: 'pad', xa: 1.35, xb: 1.65 }, { kind: 'pad', xa: -0.15, xb: 0.15 }], restDeg: 3,
};

function events(ev: SimEvents): [number, number, number, number, number][] {
  const out: [number, number, number, number, number][] = [];
  for (let i = 0; i < ev.n; i++) out.push([ev.kind[i]!, ev.sub[i]!, ev.a[i]!, ev.b[i]!, ev.c[i]!]);
  return out;
}

describe('start state', () => {
  it('is at rest, Ready, with the static tension and the proximity already filled in', () => {
    const run = createRun(fixedLevel('2-2'));
    const s = run.s;
    expect(s.status).toBe(Status.Ready);
    expect([s.x, s.v, s.th, s.w, s.bx, s.by]).toEqual([0, 0, 0, 0, 0, RAIL_Y - 1]);
    expect(s.T).toBe(1 * G);
    expect(s.mode).toBe(Mode.Taut);
    expect(s.crash).toBeNull();
    // hanging ball (0, 0.25) to wall A [1.30, 1.42] x h 0.75: 1.30 m to the face
    expect(s.near.wall).toBe(0);
    expect(s.near.d2).toBeCloseTo(1.3 * 1.3, 12);
    expect(s.minD2).toBe(s.near.d2);
    // exactly the point-to-slab distance and closest point of the hanging ball
    const cp = { x: NaN, y: NaN };
    for (const id of ['2-2', '3-3', '4-2', '5-4']) {
      const p = fixedLevel(id);
      const r = createRun(p);
      const i = r.s.near.wall;
      expect(i).toBeGreaterThanOrEqual(0);
      expect(r.s.near.d2).toBe(pointSlabClosest(p.startX, RAIL_Y - p.L, p.walls[i]!, cp));
      expect([r.s.near.px, r.s.near.py]).toEqual([cp.x, cp.y]);
      for (const w of p.walls) expect(r.s.near.d2).toBeLessThanOrEqual(pointSlabDist2(p.startX, RAIL_Y - p.L, w));
    }
    expect(run.prev).toEqual(run.cur);
    expect(run.cur).toEqual({ x: 0, bx: 0, by: RAIL_Y - 1, mode: Mode.Taut, T: G, F: 0 });
    const r11 = createRun(fixedLevel('1-1'));
    expect(r11.s.near.wall).toBe(-1);
    expect(r11.s.minD2).toBe(Infinity);
  });

  it('E_rest matches §4.6 (1.344e-2 at 3 deg, 9.33e-3 at 2.5 deg, L = 1)', () => {
    expect(restEnergy(fixedLevel('2-2'))).toBeCloseTo(1.344e-2, 5);
    expect(restEnergy(fixedLevel('5-1'))).toBeCloseTo(9.33e-3, 4);
  });
});

describe('stepTick', () => {
  it('goes Running on the first tick, keeps F = q*Fmax/127 for both substeps, clamps q and tracks peakF', () => {
    const run = createRun(fixedLevel('2-2'));
    const ev = new SimEvents();
    expect(stepTick(run, 64, ev)).toBe(Status.Running);
    expect(run.s.substep).toBe(2);
    expect(run.s.F).toBe((64 * 40) / 127);
    expect(run.cur.F).toBe(run.s.F);
    expect(run.prev.F).toBe(0);
    stepTick(run, 500, ev);
    expect(run.s.F).toBe(40);
    stepTick(run, -128, ev);
    expect(run.s.F).toBe(-40);
    stepTick(run, NaN, ev);
    expect(run.s.F).toBe(0);
    expect(run.s.peakF).toBe(40);
  });

  it('uses q exactly as the replay stores it (Int8Array: truncated to an integer, -0 is 0)', () => {
    const p = fixedLevel('2-2');
    const ev = new SimEvents();
    for (const q of [3.7, -3.7, 126.9, -0.4, -0]) {
      const a = createRun(p);
      const b = createRun(p);
      for (let k = 0; k < 30; k++) {
        stepTick(a, q, ev);
        stepTick(b, Int8Array.of(q)[0]!, ev);
      }
      expect(Object.is(a.s.F, b.s.F), `q ${q}`).toBe(true);
      expect(hashSimState(a.s, 0), `q ${q}`).toBe(hashSimState(b.s, 0));
    }
  });

  it('pose snapshots: prev is the previous tick boundary', () => {
    const run = createRun(fixedLevel('2-2'));
    const ev = new SimEvents();
    stepTick(run, 127, ev);
    const x1 = run.s.x;
    stepTick(run, 127, ev);
    expect(run.prev.x).toBe(x1);
    expect(run.cur.x).toBe(run.s.x);
    expect(run.cur.bx).toBe(run.s.bx);
    expect(run.cur.T).toBe(run.s.T);
  });

  it('does nothing after the run ended', () => {
    const p = fixedLevel('4-3');
    const run = createRun(p);
    const ev = new SimEvents();
    let st: Status = Status.Running;
    while (st === Status.Running) st = stepTick(run, 127, ev);
    expect(st).toBe(Status.Crash);
    expect(run.s.crash!.kind).toBe(CrashKind.Egg);
    const h = hashSimState(run.s, 0);
    expect(stepTick(run, 127, ev)).toBe(Status.Crash);
    expect(ev.n).toBe(0);
    expect(hashSimState(run.s, 0)).toBe(h);
  });
});

describe('hold and success (§4.6)', () => {
  it('two phases: PhaseDone after 60 held substeps, then Success; score = holdStart; nTicks = ceil((score + 59) / 2)', () => {
    const p = TWO_PADS;
    // carry to 1.5, then (after the phase) carry back to 0
    const qs = runBot(p, (s) => servoTarget(s, p, s.phase === 0 ? 1.5 : 0, true, true), 3600);
    const log: [number, number, number, number, number][] = [];
    const res = simulateReplay(p, qs, { onTick: (_t, _s, ev) => log.push(...events(ev)) });
    expect(res.status).toBe(Status.Success);
    const phaseDone = log.filter((e) => e[0] === Ev.PhaseDone);
    expect(phaseDone).toHaveLength(1);
    const [, subPD, phase0, hs0] = phaseDone[0]!;
    expect(phase0).toBe(0);
    expect(subPD).toBe(hs0 + HOLD_SUB - 1);
    const succ = log.filter((e) => e[0] === Ev.Success);
    expect(succ).toHaveLength(1);
    expect(succ[0]![2]).toBe(res.score);
    expect(succ[0]![1]).toBe(res.score! + HOLD_SUB - 1);
    expect(res.ticks).toBe(Math.ceil((res.score! + 59) / 2));
    // every hold began with HoldBegin; broken holds were reported with their length
    const begins = log.filter((e) => e[0] === Ev.HoldBegin);
    const resets = log.filter((e) => e[0] === Ev.HoldReset);
    expect(begins.length).toBe(resets.length + 2);
    for (const r of resets) expect(r[3]).toBeGreaterThan(0);
    expect(begins.filter((b) => b[2] === 1).length).toBeGreaterThan(0);
  });

  it('Taut, in the zone, E < E_rest and |v| < 0.05 are all required', () => {
    const p = fixedLevel('1-1');
    const ev = new SimEvents();
    // resting in the pad: holds
    const a = createRun(p);
    setTautStateForTest(a, 1.5, 0, 0, 0);
    stepTick(a, 0, ev);
    expect(events(ev).map((e) => e[0])).toContain(Ev.HoldBegin);
    // trolley moving at 6 cm/s: no hold
    const b = createRun(p);
    setTautStateForTest(b, 1.5, 0.06, 0, 0.06);
    stepTick(b, 0, ev);
    expect(b.s.hold).toBe(0);
    // swinging 6 deg (> 5 deg of 1-1): no hold
    const c = createRun(p);
    setTautStateForTest(c, 1.5, 0, (6 * Math.PI) / 180, 0);
    stepTick(c, 0, ev);
    expect(c.s.hold).toBe(0);
    // resting outside the pad: no hold
    const d = createRun(p);
    setTautStateForTest(d, 1.0, 0, 0, 0);
    stepTick(d, 0, ev);
    expect(d.s.hold).toBe(0);
  });

  it('times out at substep 7200 (tick 3600)', () => {
    const p = fixedLevel('2-2');
    const qs = runBot(p, carry(-0.5)(p), 4000);
    const res = simulateReplay(p, qs);
    expect(res.status).toBe(Status.Timeout);
    expect(res.ticks * 2).toBe(MAX_SUB);
    expect(qs.length).toBe(MAX_SUB / 2);
  });
});

describe('copyState / restoreState / resetRun', () => {
  it('rewinding to a copied state reproduces the continuation bit for bit', () => {
    const p = fixedLevel('1-1');
    const qs = runBot(p, (s, k) => (k < 20 ? 60 : servoTarget(s, p, 1.0, false, k > 200)), 400);
    expect(qs.length).toBe(400);
    const run = createRun(p);
    const ev = new SimEvents();
    const snap = newSimState();
    let hashAt300 = 0;
    for (let k = 0; k < qs.length; k++) {
      if (k === 100) copyState(run.s, snap);
      stepTick(run, qs[k]!, ev);
      if (k === 299) hashAt300 = hashSimState(run.s, 0);
    }
    restoreState(run, snap);
    expect(run.s.substep).toBe(200);
    expect(run.prev).toEqual(run.cur);
    expect(run.cur.x).toBe(run.s.x);
    for (let k = 100; k < 300; k++) stepTick(run, qs[k]!, ev);
    expect(hashSimState(run.s, 0)).toBe(hashAt300);
  });

  it('copies crash and near by value', () => {
    const p = fixedLevel('4-3');
    const run = createRun(p);
    const ev = new SimEvents();
    while (stepTick(run, 127, ev) === Status.Running);
    const snap = newSimState();
    copyState(run.s, snap);
    expect(snap.crash).toEqual(run.s.crash);
    expect(snap.crash).not.toBe(run.s.crash);
    expect(snap.near).not.toBe(run.s.near);
    resetRun(run);
    expect(run.s.crash).toBeNull();
    expect(snap.crash!.kind).toBe(CrashKind.Egg);
  });

  it('resetRun gives exactly the fresh start state', () => {
    const p = fixedLevel('5-4');
    const fresh = hashSimState(createRun(p).s, 0);
    const run = createRun(p);
    const ev = new SimEvents();
    for (let k = 0; k < 200; k++) stepTick(run, k % 50 < 25 ? 90 : -90, ev);
    resetRun(run);
    expect(hashSimState(run.s, 0)).toBe(fresh);
    expect(run.s.status).toBe(Status.Ready);
    expect(run.prev).toEqual(run.cur);
    // and it runs the same as a fresh run, tick for tick
    const qs = Int8Array.from({ length: 300 }, (_v, i) => (i % 40 < 20 ? 60 : -60));
    const fresh2 = createRun(p);
    const ev2 = new SimEvents();
    for (const q of qs) {
      const a = stepTick(run, q, ev);
      const b = stepTick(fresh2, q, ev2);
      expect(a).toBe(b);
      expect(hashSimState(run.s, 0)).toBe(hashSimState(fresh2.s, 0));
      if (a !== Status.Running) break;
    }
    expect(run.s.substep).toBeGreaterThan(100);
  });
});

describe('near info', () => {
  it('tracks the closest wall and its closest point', () => {
    const p = fixedLevel('2-2');
    const run = createRun(p);
    setTautStateForTest(run, 1.63, 0, 0, 0);
    const ev = new SimEvents();
    stepTick(run, 0, ev);
    // ball at (1.63, 0.25): 0.21 m from both inner faces; wall A (index 0) wins ties
    expect(run.s.near.wall).toBe(0);
    expect(Math.sqrt(run.s.near.d2)).toBeCloseTo(0.21, 9);
    expect(run.s.near.px).toBeCloseTo(1.42, 12);
    expect(run.s.near.py).toBeCloseTo(0.25, 9);
    expect(Math.sqrt(run.s.near.d2) - BALL_R).toBeCloseTo(0.15, 9);
  });
});
