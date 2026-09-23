// Keyboard parity and fragile cargo (R10) in the game's real physics (src/sim) with the real level data. Owner: O4.
//
// Real DOM key events -> InputManager -> servoQ -> src/sim stepTick, READY waiting for the first q != 0 (§4.7).
// - Fragile cargo: on 4-3 (egg; Tmax is read from src/data/levels.json, so O2's fallback / retune is what is
//   tested) a full-speed keyboard press from rest no longer cracks the egg, whatever the hold time, and neither
//   does a plain drag; with the old 4.0 m/s caps they did. Slamming the rail end (端ドン) still cracks it
//   (a re-tension impulse above Jmax): the caps limit speed, they do not soften the stopper.
// - Key taps: a press released within 150 ms moves the trolley 5 cm (Shift: 1 cm) and it settles there.
// - 2-2: taps park the trolley at 1.63 m within 1 cm and the run succeeds.
import { afterEach, describe, expect, it } from 'vitest';
import levelsJson from '../../src/data/levels.json';
import { KEY_TAP } from '../../src/input/keyboard';
import { createInputManager, type InputManagerImpl } from '../../src/input/manager';
import { FRAGILE, servoQ } from '../../src/input/servo';
import type { InputFrame } from '../../src/input/types';
import type { LevelPhysics, LevelsFile } from '../../src/sim/level';
import { createRun, setTautStateForTest, stepTick, type Run } from '../../src/sim/run';
import { SimEvents } from '../../src/sim/events';
import { key } from './helpers';

const STATUS_RUNNING = 1;
const STATUS_SUCCESS = 2;
const STATUS_CRASH = 3;
const CRASH_EGG = 5;
const deg = Math.PI / 180;

const LEVELS = (levelsJson as unknown as LevelsFile).levels;
function physicsOf(id: string): LevelPhysics {
  const def = LEVELS.find((l) => l.id === id);
  if (!def) throw new Error(`level ${id} missing`);
  return def.physics;
}
/** The same level as the input side sees it before R10: no egg, so the 4.0 / 1.0 m/s caps (control runs). */
const withoutEggCaps = (p: LevelPhysics): LevelPhysics => ({ ...p, egg: undefined });

/** Swing amplitude from the pendulum energy (§4.6). */
const ampDeg = (r: Run, L: number): number =>
  Math.acos(Math.max(-1, 1 - (0.5 * L * r.s.w * r.s.w + 9.81 * (1 - Math.cos(r.s.th))) / 9.81)) / deg;

interface Rig {
  m: InputManagerImpl;
  run: Run;
  status: number;
  maxT: number;
  /** One 60 Hz tick like the core loop; READY waits for the first q != 0. */
  step(): InputFrame;
}

let live: InputManagerImpl[] = [];
afterEach(() => {
  for (const m of live) m.dispose();
  live = [];
  key('keyup', 'ArrowLeft');
  key('keyup', 'ArrowRight');
  key('keyup', 'ShiftLeft');
});

/** sim: the physics that is simulated; input: what the manager and the servo are told (the control runs strip the egg). */
function rig(sim: LevelPhysics, input: LevelPhysics = sim): Rig {
  const m = createInputManager({ getPads: () => [] });
  live.push(m);
  m.setLevel(input);
  m.resetForRun(sim.startX);
  const run = createRun(sim);
  const ev = new SimEvents();
  let started = false;
  const r: Rig = {
    m, run, status: STATUS_RUNNING, maxT: 0,
    step() {
      const f = m.sample(run.s);
      const q = servoQ(f, run.s, input, false);
      if (!started && q === 0 && run.s.substep === 0) return f;
      started = true;
      if (r.status === STATUS_RUNNING) {
        r.status = stepTick(run, q, ev);
        r.maxT = Math.max(r.maxT, run.s.T);
      }
      return f;
    },
  };
  return r;
}

/** Press `code` from rest, release after `hold` ticks (Infinity: never), then run on for `after` ticks or until the run ends. */
function pressRun(sim: LevelPhysics, input: LevelPhysics, code: string, hold: number, after = 300): Rig {
  const r = rig(sim, input);
  key('keydown', code);
  const end = Number.isFinite(hold) ? hold + after : 1200;
  for (let t = 0; t < end && r.status === STATUS_RUNNING; t++) {
    if (t === hold) key('keyup', code);
    r.step();
  }
  key('keyup', code);
  return r;
}

describe('fragile cargo on 4-3 (R10): every device is capped at 2.0 m/s, so a plain press or drag does not crack the egg', () => {
  const P = physicsOf('4-3');
  const Tmax = P.egg?.Tmax ?? NaN;

  it('4-3 is an egg level (Tmax from levels.json)', () => {
    expect(P.egg).toBeDefined();
    expect(Tmax).toBeGreaterThan(P.m * 9.81);
  });

  it('a full-speed keyboard press from rest (any hold time, or held until the wall) never cracks the egg; the old 4.0 m/s caps did', () => {
    let wall = 0;
    for (const hold of [...Array.from({ length: 120 }, (_, i) => i + 1), Infinity]) {
      const r = pressRun(P, P, 'ArrowRight', hold);
      expect(r.run.s.crash?.kind ?? 0, `hold ${hold}`).not.toBe(CRASH_EGG);
      expect(r.maxT, `hold ${hold}`).toBeLessThan(Tmax);
      if (r.status === STATUS_CRASH) wall++; // the ball meets the 0.40 m wall (the level's point), not a cracked egg
    }
    expect(wall).toBeGreaterThan(90);
    // Control: the same presses with the pre-R10 caps (4.0 m/s) crack the egg.
    for (const hold of [30, 60, Infinity]) {
      const r = pressRun(P, withoutEggCaps(P), 'ArrowRight', hold);
      expect(r.run.s.crash?.kind, `old caps, hold ${hold}`).toBe(CRASH_EGG);
    }
  });

  it('pressing away from the wall: no crack as long as the trolley does not slam the rail end', () => {
    // The trolley reaches the stopper at x = -1 after ~0.65 s of holding; slamming it re-tensions the string
    // with J > Jmax, which cracks the egg by design (the honest rail end, §4.4), so the presses stop short.
    for (let hold = 1; hold <= 36; hold++) {
      const r = pressRun(P, P, 'ArrowLeft', hold);
      expect(r.status, `hold ${hold}`).toBe(STATUS_RUNNING);
      expect(r.maxT).toBeLessThan(Tmax);
    }
    const old = pressRun(P, withoutEggCaps(P), 'ArrowLeft', 30);
    expect(old.run.s.crash?.kind).toBe(CRASH_EGG);
  });

  it('a plain drag (the target dropped anywhere on the rail at once) never cracks the egg; with the old caps most did', () => {
    const drop = (x: number, input: LevelPhysics): { kind: number; maxT: number } => {
      const run = createRun(P);
      const ev = new SimEvents();
      const f = { intent: { kind: 'target', x }, fine: false, device: 1, targetX: x } as InputFrame;
      let maxT = 0;
      for (let t = 0; t < 480 && stepTick(run, servoQ(f, run.s, input, false), ev) === STATUS_RUNNING; t++) maxT = Math.max(maxT, run.s.T);
      return { kind: run.s.crash?.kind ?? 0, maxT };
    };
    let oldCracks = 0, n = 0;
    for (let x = P.rail[0] + 0.1; x <= P.rail[1] + 1e-9; x += 0.05) {
      const now = drop(x, P);
      expect(now.kind, `target ${x.toFixed(2)}`).not.toBe(CRASH_EGG);
      expect(now.maxT).toBeLessThan(Tmax);
      if (drop(x, withoutEggCaps(P)).kind === CRASH_EGG) oldCracks++;
      n++;
    }
    expect(oldCracks).toBeGreaterThan(n / 2);
  });

  it('the caps are 2.0 m/s and 0.5 m/s fine', () => {
    expect(FRAGILE).toEqual({ vCap: 2.0, vCapFine: 0.5 });
  });
});

describe('key taps in the real physics (R10)', () => {
  const P = physicsOf('2-2'); // default plant, start 0, the first wall 1.3 m away

  it('a 5 cm tap moves the trolley 5 cm and settles; any press up to 150 ms is the same step (a started burst is cancelled)', () => {
    for (let hold = 1; hold <= KEY_TAP.maxTicks; hold++) {
      const r = rig(P);
      key('keydown', 'ArrowRight');
      let maxX = -Infinity;
      for (let t = 0; t < 240; t++) {
        if (t === hold) key('keyup', 'ArrowRight');
        const f = r.step();
        if (t >= hold) expect(f.targetX, `hold ${hold}`).toBe(P.startX + KEY_TAP.stepM);
        maxX = Math.max(maxX, r.run.s.x);
      }
      expect(r.status).toBe(STATUS_RUNNING);
      expect(Math.abs(r.run.s.x - 0.05), `hold ${hold}`).toBeLessThan(0.004);
      expect(maxX - 0.05, `hold ${hold}: overshoot`).toBeLessThan(0.006);
      expect(Math.abs(r.run.s.v)).toBeLessThan(0.02);
      expect(ampDeg(r.run, P.L), `hold ${hold}: swing`).toBeLessThan(P.restDeg); // settled: below the level's rest limit
    }
  });

  it('a Shift tap is 1 cm; four quick taps are 20 cm; a longer press (> 150 ms) is a dash, not a tap', () => {
    const fineTap = rig(P);
    key('keydown', 'ShiftLeft');
    key('keydown', 'ArrowRight', { shift: true });
    for (let t = 0; t < 4; t++) fineTap.step();
    key('keyup', 'ArrowRight', { shift: true });
    key('keyup', 'ShiftLeft');
    for (let t = 0; t < 180; t++) fineTap.step();
    expect(Math.abs(fineTap.run.s.x - 0.01)).toBeLessThan(0.003);

    const quick = rig(P);
    for (let i = 0; i < 4; i++) {
      key('keydown', 'KeyD');
      for (let t = 0; t < 5; t++) quick.step();
      key('keyup', 'KeyD');
      for (let t = 0; t < 7; t++) quick.step();
    }
    for (let t = 0; t < 240; t++) quick.step();
    expect(quick.m.debug().targetX).toBeCloseTo(0.2, 12);
    expect(Math.abs(quick.run.s.x - 0.2)).toBeLessThan(0.015); // held there, the swing of the 20 cm move still tugs a little

    // 17 ticks (283 ms): 10 ramp ticks after the tap window, up to 2.0 m/s at 0.2 m/s per tick (the old 0.4
    // ramp got there with maxTicks + 6); the trolley ends well beyond three 5 cm taps.
    const dash = pressRun(P, P, 'ArrowRight', KEY_TAP.maxTicks + 8, 240);
    expect(dash.run.s.x).toBeGreaterThan(0.15);
  });
});

describe('2-2 precise parking with the keyboard (R10)', () => {
  const P = physicsOf('2-2');
  const GOAL = 1.63; // the pocket centre (ai.xGoal)

  /**
   * The ball has just been brought into the pocket and the trolley stands off-centre with a small swing; the
   * player reads the hold point (the target ring) and taps: 5 cm steps, Shift for the last cm.
   */
  function park(x0: number, swingDeg: number): Rig {
    const r = rig(P);
    setTautStateForTest(r.run, x0, 0, swingDeg * deg, 0);
    const tap = (code: string, fine: boolean): void => {
      if (fine) key('keydown', 'ShiftLeft');
      key('keydown', code, { shift: fine });
      for (let t = 0; t < 5; t++) r.step(); // ~80 ms
      key('keyup', code, { shift: fine });
      if (fine) key('keyup', 'ShiftLeft');
      for (let t = 0; t < 12; t++) r.step();
    };
    for (let i = 0; i < 12 && r.status === STATUS_RUNNING; i++) {
      const err = GOAL - (r.m.debug().targetX ?? r.run.s.x);
      if (Math.abs(err) < KEY_TAP.stepFineM / 2) break;
      tap(err > 0 ? 'ArrowRight' : 'ArrowLeft', Math.abs(err) < 0.03);
    }
    for (let t = 0; t < 60 * 40 && r.status === STATUS_RUNNING; t++) r.step();
    return r;
  }

  it('taps park the trolley at 1.63 m within 1 cm at rest and the run succeeds', () => {
    for (const [x0, swing] of [[1.54, 3], [1.70, 3], [1.52, 0], [1.745, 2]]) {
      const r = park(x0, swing);
      expect(r.status, `from ${x0}`).toBe(STATUS_SUCCESS);
      expect(Math.abs(r.run.s.x - GOAL), `from ${x0}`).toBeLessThan(0.01);
      expect(Math.abs(r.run.s.v)).toBeLessThan(0.05);
      expect(r.m.sample(r.run.s).device).toBe(3);
    }
  });
});
