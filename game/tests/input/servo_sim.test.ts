// The servo and the InputManager inside the real simulator (src/sim, O1). Owner: O4.
// servo.test.ts uses its own taut integrator; this file checks the same servo against the game's
// physics with slack, so the "just short of the 0.75 m wall" tease of §3.2 stays true, and drives
// whole runs from DOM events (deck drag, keyboard) through to Success.
import { afterEach, describe, expect, it } from 'vitest';
import { servoQ } from '../../src/input/servo';
import { createInputManager, type InputManagerImpl } from '../../src/input/manager';
import { KEY_RAMP, KEY_TAP } from '../../src/input/keyboard';
import type { InputFrame } from '../../src/input/types';
import type { LevelPhysics } from '../../src/sim/level';
import { copyState, createRun, newSimState, restoreState, stepTick, type Run } from '../../src/sim/run';
import { SimEvents } from '../../src/sim/events';
import { level, restState, tick } from './plant';
import { box, key, layoutTall, ptr } from './helpers';

const target = (x: number): InputFrame => ({ intent: { kind: 'target', x }, fine: false, device: 0, targetX: x }) as InputFrame;
const EV_SNAP = 1;
const MODE_SLACK = 1;
const STATUS_RUNNING = 1;
const STATUS_SUCCESS = 2;
const deg = Math.PI / 180;
/** Swing amplitude from the pendulum energy (§4.6), L = 1. */
const ampDeg = (r: Run): number => Math.acos(Math.max(-1, 1 - (0.5 * r.s.w * r.s.w + 9.81 * (1 - Math.cos(r.s.th))) / 9.81)) / deg;

describe('servo in src/sim (§3.2, Appendix B)', () => {
  // No reachable goal so the run never ends in Success during the manoeuvre.
  const phys = level({ phases: [{ kind: 'pad', xa: 5, xb: 6 }] });

  it('1 m step: identical to the taut test plant (the string never slackens)', () => {
    const run = createRun(phys);
    const ev = new SimEvents();
    const ref = restState(0);
    let maxDiff = 0, first = -1, maxX = -Infinity;
    for (let t = 1; t <= 360; t++) {
      ev.clear();
      expect(stepTick(run, servoQ(target(1), run.s, phys, false), ev)).toBe(STATUS_RUNNING);
      tick(phys, ref, servoQ(target(1), ref, phys, false));
      expect(run.s.mode).not.toBe(MODE_SLACK);
      maxDiff = Math.max(maxDiff, Math.abs(run.s.x - ref.x));
      if (first < 0 && Math.abs(run.s.x - 1) <= 0.02) first = t / 60;
      maxX = Math.max(maxX, run.s.x);
    }
    expect(maxDiff).toBeLessThan(1e-9);
    expect(first).toBeLessThanOrEqual(0.6);
    expect(maxX - 1).toBeLessThanOrEqual(0.07);
  });

  it('dash to 1.63 m: slack on the brake, a snap of about 1.3 N·s, and a swing just short of 63.9°', () => {
    const run = createRun(phys);
    const ev = new SimEvents();
    let maxDeg = 0, slackTicks = 0, maxJ = 0;
    for (let t = 1; t <= 240; t++) {
      ev.clear();
      stepTick(run, servoQ(target(1.63), run.s, phys, false), ev);
      if (run.s.mode === MODE_SLACK) slackTicks++;
      for (let i = 0; i < ev.n; i++) if (ev.kind[i] === EV_SNAP) maxJ = Math.max(maxJ, ev.a[i]);
      maxDeg = Math.max(maxDeg, (Math.atan2(run.s.bx - run.s.x, 1.25 - run.s.by) * 180) / Math.PI);
    }
    expect(slackTicks).toBeGreaterThan(5);
    expect(maxJ).toBeGreaterThan(1.0);
    expect(maxJ).toBeLessThan(1.7);
    expect(maxDeg).toBeGreaterThan(60);
    expect(maxDeg).toBeLessThan(63.9); // the 0.75 m wall needs 63.9°: the naive dash must not make it
  });
});

/**
 * The whole chain in the game's physics: real DOM events -> InputManager -> servoQ -> src/sim stepTick,
 * with READY waiting for the first q != 0 (§4.7) exactly like the core loop.
 */
describe('InputManager + servo + src/sim closed loop', () => {
  let m: InputManagerImpl | null = null;
  afterEach(() => {
    m?.dispose();
    m = null;
    document.body.innerHTML = '';
  });

  interface Trace { run: Run; status: number; t: number; xs: number[]; frames: InputFrame[]; stopTick: number }
  /** Runs up to maxTicks; `script(t)` fires DOM events before tick t's sample. Ticks count from the first sample. */
  function drive(p: LevelPhysics, mgr: InputManagerImpl, script: (t: number, run: Run) => void, maxTicks: number, assist = false): Trace {
    const run = createRun(p);
    const ev = new SimEvents();
    const xs: number[] = [], frames: InputFrame[] = [];
    let started = false, status = STATUS_RUNNING, stopTick = -1, t = 0;
    for (; t < maxTicks; t++) {
      script(t, run);
      const f = mgr.sample(run.s);
      frames.push(f);
      if (stopTick < 0 && f.intent.kind === 'target' && frames.length > 1 && frames[frames.length - 2].intent.kind === 'velocity') stopTick = t;
      const q = servoQ(f, run.s, p, assist);
      if (!started && q === 0) {
        xs.push(run.s.x);
        continue;
      }
      started = true;
      ev.clear();
      status = stepTick(run, q, ev);
      xs.push(run.s.x);
      if (status !== STATUS_RUNNING) break;
    }
    return { run, status, t, xs, frames, stopTick };
  }

  /**
   * Press → at tick 0, release after `hold` ticks. From rest the first KEY_TAP.windowTicks ticks are the tap
   * window (R10: the 5 cm step, ramp delayed), so a dash of n ramp ticks needs hold = W + n.
   */
  const W = KEY_TAP.windowTicks;
  const press = (hold: number) => (t: number): void => {
    if (t === 0) key('keydown', 'ArrowRight');
    if (t === hold) key('keyup', 'ArrowRight');
  };

  it('keyboard stop: the trolley brakes to rest, holds there, and stays within ±5 cm after 3 s despite a ≥ 20° swing', () => {
    // 14 ramp ticks (~2.9 m/s) -> ~23° swing at the stop, 20 (full 4.0 m/s) -> ~42° (Appendix B: a 45° swing
    // tugs the trolley ±4-5 cm). At 0.2 m/s per tick the ramp needs twice the ticks of the old 0.4 ramp for
    // the same release speed and swing (was 8 and 15 ticks).
    const p = level({ phases: [{ kind: 'pad', xa: 5, xb: 6 }], rail: [-1, 4] });
    const full = KEY_RAMP.cap / KEY_RAMP.up; // 20 ticks to 4.0
    const down = KEY_RAMP.down / KEY_RAMP.perMps; // 0.8 m/s per tick
    for (const ramp of [14, full]) {
      const hold = W + ramp;
      m = createInputManager();
      m.setLevel(p);
      m.resetForRun(0);
      let maxAmp = 0;
      const tr = drive(p, m, (t, run) => {
        press(hold)(t);
        if (t > hold + 4 && t < hold + 40) maxAmp = Math.max(maxAmp, ampDeg(run));
      }, hold + 4 + 600);
      expect(tr.frames.slice(0, W).map((f) => f.intent.kind)).toEqual(Array(W).fill('target')); // the tap window
      // Released before sample 'hold' at the ramp's v: 0.8 per tick down, 0 on the last tick (5th from 4.0).
      const vRel = (tr.frames[hold - 1].intent as { v: number }).v;
      expect(vRel).toBeGreaterThan((KEY_RAMP.up / KEY_RAMP.perMps) * Math.min(ramp, full) - 0.01); // the ramp started from the trolley speed
      expect(tr.stopTick).toBe(hold + Math.ceil(vRel / down - 1e-9) - 1);
      const holdX = tr.frames[tr.frames.length - 1].targetX as number;
      expect(Math.max(...tr.xs.slice(tr.stopTick)) - holdX).toBeLessThan(0.06); // no spring-back, only the swing's tug
      for (const x of tr.xs.slice(tr.stopTick + 180)) expect(Math.abs(x - holdX)).toBeLessThanOrEqual(0.05);
      expect(maxAmp).toBeGreaterThan(20); // not trivial: the ball swings hard while the trolley holds
      m.dispose();
      m = null;
    }
  });

  it('why the latch is the default (D1): the non-default option stopLatch: false holds the stop tick x and springs back on a weak F_max', () => {
    const weak = level({ Fmax: 6, phases: [{ kind: 'pad', xa: 7, xb: 8 }], rail: [-1, 8] }); // 3-1 plant
    const springBack = (latch: boolean): { back: number; holdIsStopX: boolean } => {
      m = createInputManager({ stopLatch: latch });
      m.setLevel(weak);
      m.resetForRun(0);
      const tr = drive(weak, m, press(W + 60), W + 60 + 600);
      const stopX = (tr.frames[tr.stopTick].intent as { x: number }).x;
      const holdX = tr.frames[tr.frames.length - 1].targetX as number;
      const peak = Math.max(...tr.xs.slice(tr.stopTick));
      m.dispose();
      m = null;
      return { back: peak - holdX, holdIsStopX: holdX === stopX };
    };
    const literal = springBack(false);
    expect(literal.holdIsStopX).toBe(true);
    expect(literal.back).toBeGreaterThan(0.5); // coasts > 50 cm past the hold point and drives back
    const latched = springBack(true);
    expect(latched.holdIsStopX).toBe(false);
    expect(latched.back).toBeLessThan(0.1);
  });

  it('a deck drag onto a 1-1 pad ends in Success; the anti-sway assist (idle frames only) makes it much sooner', () => {
    const p11 = level({ rail: [-0.6, 2.4], phases: [{ kind: 'pad', xa: 1.2, xb: 1.8 }], restDeg: 5 });
    const results: number[] = [];
    for (const assist of [false, true]) {
      const L = layoutTall();
      const scene = box(0, 0, 390, L.scene.h), deck = box(0, L.scene.h, 390, L.deck!.h);
      m = createInputManager();
      m.attach(scene, deck, { screenToRailX: () => null }, L);
      m.setLevel(p11);
      m.resetForRun(0);
      const y = L.scene.h + 120, goal = 100 + (1.5 / 3.0) * 390; // 1.5 m on a 3.0 m rail over 390 px
      let px = 100;
      const tr = drive(p11, m, (t) => {
        if (t === 0) ptr(deck, 'pointerdown', px, y);
        else if (px < goal) {
          px = Math.min(goal, px + 12);
          ptr(deck, 'pointermove', px, y);
          if (px === goal) ptr(deck, 'pointerup', px, y); // let go: the target stays (crane-game cursor)
        }
      }, 3600, assist);
      expect(tr.status).toBe(STATUS_SUCCESS);
      expect(Math.abs(tr.run.s.x - 1.5)).toBeLessThan(0.05);
      expect(tr.frames[tr.frames.length - 1].device).toBe(1);
      results.push(tr.run.s.score / 120);
      m.dispose();
      m = null;
      document.body.innerHTML = '';
    }
    expect(results[1]).toBeLessThan(12);
    expect(results[1]).toBeLessThan(results[0] / 2);
  });

  it('practice rewind (§3.5): after restoreState the trolley holds at the restored x, it does not race to the stale hold point', () => {
    const p = level({ phases: [{ kind: 'pad', xa: 5, xb: 6 }], rail: [-1, 4] });
    const mgr = createInputManager();
    m = mgr;
    mgr.setLevel(p);
    mgr.resetForRun(0);
    const run = createRun(p);
    const ev = new SimEvents();
    const step = (): InputFrame => {
      const f = mgr.sample(run.s);
      ev.clear();
      expect(stepTick(run, servoQ(f, run.s, p, false), ev)).toBe(STATUS_RUNNING);
      return f;
    };
    const ticks = (n: number): void => {
      for (let t = 0; t < n; t++) step();
    };
    key('keydown', 'ArrowRight');
    ticks(KEY_TAP.windowTicks + 23); // tap window, the 20-tick ramp to 4.0 and 3 ticks at full speed
    key('keyup', 'ArrowRight');
    ticks(200); // braked and holding (latched) to the right
    const ring = newSimState();
    copyState(run.s, ring); // what the session's rewind ring holds for "5 s ago"
    const restoredX = run.s.x;
    key('keydown', 'ArrowLeft');
    ticks(KEY_TAP.windowTicks + 16); // a dash to 3.2 m/s
    key('keyup', 'ArrowLeft');
    ticks(200); // now holding far to the left
    key('keydown', 'ArrowLeft', { shift: true }); // then creep further left (fine: no big swing)
    ticks(60);
    key('keyup', 'ArrowLeft');
    ticks(120);
    const stale = mgr.debug().targetX as number;
    expect(restoredX - stale).toBeGreaterThan(0.8);

    restoreState(run, ring); // session.rewind(5)
    const first = step();
    expect(first.targetX).toBe(restoredX);
    let worst = 0;
    for (let t = 0; t < 300; t++) {
      step();
      worst = Math.max(worst, Math.abs(run.s.x - restoredX));
    }
    expect(worst).toBeLessThan(0.06); // only the swing's tug (±5 cm), not a ~1 m dash back to the stale point
    expect(mgr.sample(run.s).device).toBe(3);
  });

  it('a keyboard dash-and-release onto a 1-1 pad ends in Success (the hold keeps the trolley over the pad)', () => {
    const p11 = level({ rail: [-0.6, 2.4], phases: [{ kind: 'pad', xa: 1.2, xb: 1.8 }], restDeg: 5 });
    m = createInputManager();
    m.setLevel(p11);
    m.resetForRun(0);
    // 32 ramp ticks (20 up to 4.0, 12 at full speed): released so that it brakes to rest near the pad centre
    // 1.5 m (at 0.2 m/s per tick, 28-38 ramp ticks all end on the pad; the old 0.4 ramp used 26).
    const tr = drive(p11, m, press(W + 32), 3600, true);
    expect(Math.abs(tr.run.s.x - 1.5)).toBeLessThan(0.3);
    expect(tr.status).toBe(STATUS_SUCCESS);
    expect(tr.frames[tr.frames.length - 1].device).toBe(3);
  });
});
