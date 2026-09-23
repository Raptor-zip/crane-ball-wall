// Physical invariants of the stepper (GAME_DESIGN.md §4.4, §10.7 ①-⑥). Owner: O1.
import { describe, expect, it } from 'vitest';
import eom from '../fixtures/eom_py.json';
import { G, H, RAIL_Y } from '../../src/sim/constants';
import { sincos } from '../../src/sim/detmath';
import { ACC, accel, railStopW, rk4PinnedP, SNAP, snapImpulse, stepTautForTest } from '../../src/sim/dynamics';
import { Ev, SimEvents } from '../../src/sim/events';
import type { LevelPhysics } from '../../src/sim/level';
import {
  createRun, Mode, setSlackStateForTest, setTautStateForTest, Status, stepTick, substepForTest, type Run, type SimState,
} from '../../src/sim/run';

function level(over: Partial<LevelPhysics> = {}): LevelPhysics {
  return {
    M: 2, m: 1, L: 1, Fmax: 40, rail: [-1, 3.2], startX: 0, walls: [],
    phases: [{ kind: 'pad', xa: 3.0, xb: 3.1 }], restDeg: 3, ...over,
  };
}

/** Mechanical energy: ballwall.dynamics.energy while taut, the same thing from the ball's world state while slack. */
function energy(p: LevelPhysics, s: SimState): number {
  if (s.mode === Mode.Taut) {
    const cs = Math.cos(s.th);
    const kin = 0.5 * (p.M + p.m) * s.v * s.v + p.m * p.L * s.v * s.w * cs + 0.5 * p.m * p.L * p.L * s.w * s.w;
    return kin + p.m * G * p.L * (1 - cs);
  }
  return 0.5 * p.M * s.v * s.v + 0.5 * p.m * (s.bvx * s.bvx + s.bvy * s.bvy) + p.m * G * (s.by - (RAIL_Y - p.L));
}

/** Swing amplitude [deg] of the ball relative to a resting pivot, from its energy (valid taut or slack). */
function ampDeg(p: LevelPhysics, s: SimState): number {
  const rvx = s.bvx - s.v;
  const E = 0.5 * (rvx * rvx + s.bvy * s.bvy) + G * (s.by - (RAIL_Y - p.L));
  const c = 1 - E / (G * p.L);
  return (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
}

function countEvents(ev: SimEvents, kind: Ev): number {
  let n = 0;
  for (let i = 0; i < ev.n; i++) if (ev.kind[i] === kind) n++;
  return n;
}

describe('① passive system (F = 0): energy never increases', () => {
  const starts: [string, Partial<LevelPhysics>, number, number, number, number][] = [
    // name, level, x, v, th, w
    ['20 deg swing', {}, 1, 0, 0.35, 0],
    ['70 deg swing', {}, 1, 0, 1.2, 0],
    ['85 deg swing', {}, 1, 0, 1.48, 0],
    ['moving trolley + swing', {}, 0, 1.5, -0.6, 2.0],
    ['heavy ball', { m: 3 }, 1, 0, 1.0, 0],
    ['short string', { L: 0.6 }, 1, -1, 0.8, -1],
    ['into the rail end', {}, 3.0, 2.0, 0.3, -1.0],
    ['into the left end (slack at the stop)', {}, -0.8, -3.0, 0.2, 2.5],
  ];
  it.each(starts)('%s', (_n, over, x, v, th, w) => {
    const p = level(over);
    const run = createRun(p);
    setTautStateForTest(run, x, v, th, w);
    const ev = new SimEvents();
    let e0 = energy(p, run.s);
    let worstRise = -Infinity;
    let steps = 0;
    // every substep for 20 s
    for (let k = 0; k < 20 * 120; k++) {
      ev.clear();
      const st = substepForTest(run, 0, ev);
      if (st !== Status.Running) break;
      steps++;
      const e = energy(p, run.s);
      worstRise = Math.max(worstRise, e - e0);
      e0 = e;
    }
    expect(steps, 'the scenario must run the whole 20 s').toBe(20 * 120);
    expect(worstRise).toBeLessThanOrEqual(1e-9);
  });
});

describe('② free-trolley Snap', () => {
  it('conserves x momentum to 1e-12 and never adds energy (random configurations)', () => {
    let seed = 5;
    const rnd = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    let worstP = 0;
    let worstE = -Infinity;
    let worstVr = 0;
    for (let i = 0; i < 20000; i++) {
      const M = 1 + rnd() * 3;
      const m = 0.5 + rnd() * 3;
      const th = (rnd() * 2 - 1) * 1.5;
      const sn = Math.sin(th);
      const cs = Math.cos(th);
      const v = (rnd() * 2 - 1) * 4;
      const bvx = (rnd() * 2 - 1) * 5;
      const bvy = (rnd() * 2 - 1) * 5;
      const vr = (bvx - v) * sn - bvy * cs;
      if (!(vr > 0)) continue;
      snapImpulse(M, m, sn, cs, vr, bvx, bvy, v, false);
      const p0 = M * v + m * bvx;
      const p1 = M * SNAP[3]! + m * SNAP[1]!;
      worstP = Math.max(worstP, Math.abs(p1 - p0) / Math.max(1, Math.abs(p0)));
      const e0 = 0.5 * M * v * v + 0.5 * m * (bvx * bvx + bvy * bvy);
      const e1 = 0.5 * M * SNAP[3]! ** 2 + 0.5 * m * (SNAP[1]! ** 2 + SNAP[2]! ** 2);
      worstE = Math.max(worstE, e1 - e0);
      // the radial relative velocity is removed
      worstVr = Math.max(worstVr, Math.abs((SNAP[1]! - SNAP[3]!) * sn - SNAP[2]! * cs) / (1 + Math.abs(vr)));
    }
    expect(worstVr).toBeLessThan(1e-12);
    expect(worstP).toBeLessThanOrEqual(1e-12);
    expect(worstE).toBeLessThanOrEqual(1e-12);
  });

  it('in the stepper: a slack ball snapping taut keeps M*v + m*bvx and loses energy', () => {
    const p = level();
    const run = createRun(p);
    // trolley at rest with F = 0 (no force, no friction), ball just outside the circle flying outwards
    const th = 0.5;
    const bx = 1 + 1.0005 * Math.sin(th);
    const by = RAIL_Y - 1.0005 * Math.cos(th);
    setSlackStateForTest(run, 1, 0, bx, by, 1.2, -0.4);
    const s = run.s;
    const px0 = p.m * s.bvx;
    const e0 = energy(p, s);
    const ev = new SimEvents();
    substepForTest(run, 0, ev);
    const snaps = [...Array(ev.n).keys()].filter((i) => ev.kind[i] === Ev.Snap);
    expect(snaps).toHaveLength(1);
    expect(s.mode).toBe(Mode.Taut);
    // ballistic flight keeps bvx; the trolley had no force: total x momentum is conserved
    expect(Math.abs(p.M * s.v + p.m * s.bvx - px0)).toBeLessThanOrEqual(1e-12);
    expect(energy(p, s)).toBeLessThanOrEqual(e0 + 1e-12);
  });
});

describe('③ taut rail-end stop', () => {
  it('conserves p_theta = m L cos(th) v + m L^2 w to 1e-12', () => {
    const m = 1;
    const L = 1;
    let worst = 0;
    for (let i = 0; i <= 200; i++) {
      const th = -1.4 + (2.8 * i) / 200;
      const cs = Math.cos(th);
      for (const v of [-4, -1.5, 0.3, 2, 4]) {
        for (const w of [-3, 0, 1.7]) {
          const p0 = m * L * cs * v + m * L * L * w;
          const w1 = railStopW(L, v, cs, w);
          const p1 = m * L * cs * 0 + m * L * L * w1;
          worst = Math.max(worst, Math.abs(p1 - p0));
        }
      }
    }
    expect(worst).toBeLessThanOrEqual(1e-12);
  });

  it('in the stepper: the stop applies exactly w += v*cs/L (p_theta conserved), then swings on the fixed pivot', () => {
    const p = level({ rail: [-1, 2.0] });
    for (const [th, v, w] of [[0.4, 1.5, 0.5], [0.9, 3.0, -1.2], [0.05, 0.4, 2.0]] as const) {
      const run = createRun(p);
      // the trolley sits exactly on the end moving into it: the impact happens at the start of the substep
      // (f = 0), and the rest of the substep is the pendulum on the fixed pivot (the string pulls: xdd >= 0)
      setTautStateForTest(run, 2.0, v, th, w);
      const ev = new SimEvents();
      substepForTest(run, 0, ev);
      const sc = new Float64Array(2);
      sincos(th, sc);
      const y = Float64Array.of(th, railStopW(p.L, v, sc[1]!, w));
      // p_theta = m L cos(th) v + m L^2 w before the stop equals m L^2 w' after it (v' = 0)
      expect(Math.abs(p.m * p.L * p.L * y[1]! - (p.m * p.L * sc[1]! * v + p.m * p.L * p.L * w))).toBeLessThanOrEqual(1e-12);
      rk4PinnedP(Float64Array.of(p.M, p.m, p.L, 0, H), y);
      expect([run.s.th, run.s.w]).toEqual([y[0], y[1]]);
      expect([run.s.x, run.s.v, run.s.pinned, run.s.mode]).toEqual([2.0, 0, 1, Mode.Taut]);
      const hits = [...Array(ev.n).keys()].filter((i) => ev.kind[i] === Ev.StopHit);
      expect(hits).toHaveLength(1);
      expect([ev.a[hits[0]!], ev.b[hits[0]!], ev.c[hits[0]!]]).toEqual([1, v, 1]);
    }
  });

  it('in the stepper: a taut StopHit pins the trolley and keeps the string taut', () => {
    const p = level({ rail: [-1, 2.0] });
    const run = createRun(p);
    // ball ahead of the trolley (sn > 0) moving right: the string pulls, stays taut
    setTautStateForTest(run, 1.99, 2.0, 0.4, 0.5);
    const ev = new SimEvents();
    stepTick(run, 0, ev);
    const k = [...Array(ev.n).keys()].find((i) => ev.kind[i] === Ev.StopHit);
    expect(k).toBeDefined();
    expect(ev.a[k!]).toBe(1);
    expect(ev.c[k!]).toBe(1);
    expect(run.s.pinned).toBe(1);
    expect(run.s.x).toBe(2.0);
    expect(run.s.v).toBe(0);
    expect(run.s.mode).toBe(Mode.Taut);
  });
});

describe('④ integration step', () => {
  it('120 Hz and 240 Hz agree within 1 mm after 10 s on taut inputs', () => {
    for (const c of (eom as { cases: { name: string; plant: { M: number; m: number; L: number }; F: number[] }[] }).cases) {
      const phys = level({ M: c.plant.M, m: c.plant.m, L: c.plant.L });
      const a = new Float64Array(4);
      const b = new Float64Array(4);
      for (let k = 0; k < 600; k++) {
        const F = c.F[k]!;
        for (let j = 0; j < 2; j++) stepTautForTest(phys, a, F, 1 / 120);
        for (let j = 0; j < 4; j++) stepTautForTest(phys, b, F, 1 / 240);
      }
      const L = c.plant.L;
      const dx = Math.abs(a[0]! - b[0]!);
      const dBall = Math.hypot(a[0]! + L * Math.sin(a[2]!) - b[0]! - L * Math.sin(b[2]!), L * Math.cos(a[2]!) - L * Math.cos(b[2]!));
      expect(dx, c.name).toBeLessThanOrEqual(1e-3);
      expect(dBall, c.name).toBeLessThanOrEqual(1e-3);
    }
  });
});

describe('⑤ trolley pinned against the rail end', () => {
  function servoIntoEnd(run: Run, target: number): number {
    // §3.2 servo (inline, test only): position target beyond the rail end
    const s = run.s;
    const KV = (20 / 3) * (run.phys.M + run.phys.m);
    const vc = Math.max(-4, Math.min(4, 5 * (target - s.x)));
    const F = Math.max(-run.phys.Fmax, Math.min(run.phys.Fmax, KV * (vc - s.v)));
    return Math.max(-127, Math.min(127, Math.round((F * 127) / run.phys.Fmax)));
  }
  it.each([0, 0.25, 0.5])('holding 2 s with a %f rad swing: no Snap and no SlackBegin', (th0) => {
    const p = level({ rail: [-0.6, 2.4] });
    const run = createRun(p);
    setTautStateForTest(run, 2.4, 0, th0, 0, 1);
    const ev = new SimEvents();
    let snaps = 0;
    let slacks = 0;
    for (let k = 0; k < 120; k++) {
      stepTick(run, servoIntoEnd(run, 2.4 + 0.3), ev);
      snaps += countEvents(ev, Ev.Snap);
      slacks += countEvents(ev, Ev.SlackBegin);
      expect(run.s.x).toBe(2.4);
      expect(run.s.pinned).toBe(1);
    }
    expect(run.s.status).toBe(Status.Running);
    expect(snaps).toBe(0);
    expect(slacks).toBe(0);
  });
});

describe('⑤b trolley resting against the end while the free xdd turns within a substep', () => {
  it('keeps the pendulum swinging on the fixed pivot (no freeze, no zero-speed StopHit)', () => {
    // Pinned at the right end, the ball left of the pivot and swinging right. With F just below the force that
    // balances the string's pull, the free xdd is slightly negative at the start of the substep (step 2 releases
    // the trolley) but positive later in it, so the free RK4 step ends beyond the end. The end must hold the
    // trolley; this used to re-integrate nothing and freeze the ball in mid-swing for as long as F stayed put.
    const p = level({ rail: [-0.6, 2.4] });
    const th0 = -0.3;
    const w0 = 2.5;
    accel(p.M, p.m, p.L, 0, th0, w0, 0);
    const a0 = ACC[0]!;
    accel(p.M, p.m, p.L, 0, th0, w0, 1);
    const F0 = -a0 / (ACC[0]! - a0); // xdd(F0) = 0 (xdd is linear in F)
    for (const dF of [-0.05, -0.01, -1e-4]) {
      const F = F0 + dF;
      accel(p.M, p.m, p.L, 0, th0, w0, F);
      expect(ACC[0]!).toBeLessThan(0);
      const run = createRun(p);
      setTautStateForTest(run, 2.4, 0, th0, w0, 1);
      const ev = new SimEvents();
      const y = Float64Array.of(th0, w0);
      const par = Float64Array.of(p.M, p.m, p.L, F, H);
      let stopHits = 0;
      for (let k = 0; k < 12; k++) {
        ev.clear();
        substepForTest(run, F, ev);
        stopHits += countEvents(ev, Ev.StopHit);
        rk4PinnedP(par, y);
        expect([run.s.th, run.s.w], `substep ${k + 1}, dF ${dF}`).toEqual([y[0], y[1]]);
        expect([run.s.x, run.s.v, run.s.pinned]).toEqual([2.4, 0, 1]);
      }
      expect(run.s.th).toBeGreaterThan(th0 + 0.2);
      expect(stopHits).toBe(0);
    }
  });
});

describe('⑥ 4-2 end slam', () => {
  it.each([0, 127])('trolley at 2 m/s with the ball passing underneath at rest: < 0.5 deg after the stop (q = %i)', (q) => {
    const p = level({ rail: [-0.6, 2.4], walls: [{ x0: 1.2, x1: 1.3, h: 0.5 }], phases: [{ kind: 'pad', xa: 2.24, xb: 2.44 }] });
    const run = createRun(p);
    // the ball hangs 1 cm ahead and is at rest in the world (w = -v/(L cos th)); the trolley reaches the
    // end 1 cm later, i.e. just as the ball passes underneath it
    const th0 = 0.01 / p.L;
    setTautStateForTest(run, 2.4 - 0.01, 2.0, th0, -2.0 / (p.L * Math.cos(th0)));
    const ev = new SimEvents();
    const s = run.s;
    // the stop happens in the first substep; look at the state right after it
    substepForTest(run, (q * p.Fmax) / 127, ev);
    const hit = [...Array(ev.n).keys()].find((i) => ev.kind[i] === Ev.StopHit);
    expect(hit).toBeDefined();
    expect(ev.sub[hit!]).toBe(1);
    expect(s.x).toBe(2.4);
    expect(s.status).toBe(Status.Running);
    expect(ampDeg(p, s)).toBeLessThan(0.5);
  });
});
