// Servo and input acceptance tests (GAME_DESIGN.md §3.2, §3.3, §10.7 tests/input/servo.test.ts). Owner: O4.
//
// Closed-loop tests here integrate the taut-string EOM of §4.2 themselves (tests/input/plant.ts: RK4 at
// 120 Hz, force held per 60 Hz tick): the taut model is exactly what the Appendix B servo numbers were
// measured on. tests/input/servo_sim.test.ts runs the same servo (and the whole InputManager) in the
// game's real physics (src/sim, with slack and rail ends).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SERVO, servoQ, servoVcmd, clampTarget, quantizeForce } from '../../src/input/servo';
import { createInputManager, type InputManagerImpl } from '../../src/input/manager';
import { KEY_RAMP, KEY_TAP } from '../../src/input/keyboard';
import { DECK_LAYOUT, controlSurface } from '../../src/input/pointer';
import type { InputFrame, Intent, RailMapper } from '../../src/input/types';
import type { SimState } from '../../src/sim/run';
import type { LevelsFile } from '../../src/sim/level';
import { level, restState, tick } from './plant';
import levelsJson from '../../src/data/levels.json';
import { box, key, layoutTall, layoutWide, ptr } from './helpers';
import { mockWideView } from './mockCamera';

const frame = (intent: Intent, targetX: number | null = null, fine = false): InputFrame =>
  ({ intent, fine, device: 0, targetX }) as InputFrame;
/** The egg level's string limit (§5.1 level 4-3), read from the data so the assertion cannot go stale. */
const EGG_TMAX_43 = (levelsJson as LevelsFile).levels.find((l) => l.id === '4-3')!.physics.egg!.Tmax;
const deg = Math.PI / 180;
/** Swing amplitude from the pendulum energy E = L²w²/2 + gL(1 − cos th) (§4.6, L = 1). */
const amplitudeDeg = (s: SimState): number =>
  Math.acos(1 - (0.5 * s.w * s.w + 9.81 * (1 - Math.cos(s.th))) / 9.81) / deg;

describe('servoQ (§3.2)', () => {
  const p = level();

  it('uses the Appendix A tuning', () => {
    expect(SERVO).toEqual({ kx: 5.0, kvPerKg: 20 / 3, vCap: 4.0, vCapFine: 1.0, assistKa: 3.0 });
  });

  it('target: v_cmd = clamp(KX (x_t - x), ±4), F = KV (v_cmd - v), q = round(127 F / Fmax)', () => {
    const s = restState(0);
    // 0.1 m ahead: v_cmd 0.5, F = 20 * 0.5 = 10 N, q = round(31.75) = 32
    expect(servoVcmd(frame({ kind: 'target', x: 0.1 }), s, p, false)).toBeCloseTo(0.5, 12);
    expect(servoQ(frame({ kind: 'target', x: 0.1 }), s, p, false)).toBe(32);
    // far away: v_cmd capped at 4, F = 80 N clamped to Fmax -> 127
    expect(servoVcmd(frame({ kind: 'target', x: 3 }), s, p, false)).toBe(4);
    expect(servoQ(frame({ kind: 'target', x: 3 }), s, p, false)).toBe(127);
    expect(servoQ(frame({ kind: 'target', x: -3 }), s, p, false)).toBe(-127);
    // moving at 3.5 m/s towards a far target: F = 20 * (4 - 3.5) = 10 N
    s.v = 3.5;
    expect(servoQ(frame({ kind: 'target', x: 3 }), s, p, false)).toBe(32);
  });

  it('fine mode caps the command at 1.0 m/s (ball levels; the keyboard ramp itself stops at 0.5, R10)', () => {
    const s = restState(0);
    expect(servoVcmd(frame({ kind: 'target', x: 1 }, 1, true), s, p, false)).toBe(1);
    expect(servoQ(frame({ kind: 'target', x: 1 }, 1, true), s, p, false)).toBe(64); // F = 20 N -> 63.5 -> 64
    expect(servoVcmd(frame({ kind: 'velocity', v: -4 }, null, true), s, p, false)).toBe(-1);
  });

  it('velocity: v_cmd = clamp(v, ±vcap)', () => {
    const s = restState(0);
    expect(servoVcmd(frame({ kind: 'velocity', v: 9 }), s, p, false)).toBe(4);
    expect(servoQ(frame({ kind: 'velocity', v: 0.3 }), s, p, false)).toBe(19); // F = 6 N -> 19.05
    s.v = 0.3;
    expect(servoQ(frame({ kind: 'velocity', v: 0.3 }), s, p, false)).toBe(0);
  });

  it('idle holds the last target (targetX), else the current x', () => {
    const s = restState(0.2);
    expect(servoVcmd(frame({ kind: 'idle' }, 0.3), s, p, false)).toBeCloseTo(0.5, 12);
    expect(servoVcmd(frame({ kind: 'idle' }, null), s, p, false)).toBe(0);
    s.v = 0.5; // no target: a pure velocity damper
    expect(servoQ(frame({ kind: 'idle' }, null), s, p, false)).toBe(-32);
  });

  it('assist adds KA L sin(th) only to idle frames (§3.6)', () => {
    const s = restState(0, 0.2);
    const add = 3 * 1.0 * Math.sin(0.2);
    expect(servoVcmd(frame({ kind: 'idle' }, 0), s, p, true)).toBeCloseTo(add, 12);
    expect(servoVcmd(frame({ kind: 'idle' }, 0), s, p, false)).toBe(0);
    expect(servoVcmd(frame({ kind: 'target', x: 0 }, 0), s, p, true)).toBe(0);
    expect(servoVcmd(frame({ kind: 'velocity', v: 0 }), s, p, true)).toBe(0);
    const L6 = level({ L: 0.6 });
    expect(servoVcmd(frame({ kind: 'idle' }, 0), s, L6, true)).toBeCloseTo(3 * 0.6 * Math.sin(0.2), 12);
  });

  it('force: F = f directly, quantised against Fmax', () => {
    const s = restState(0);
    s.v = 2; // the servo state does not matter for a direct force
    expect(servoQ(frame({ kind: 'force', f: 40 }), s, p, false)).toBe(127);
    expect(servoQ(frame({ kind: 'force', f: -10 }), s, p, false)).toBe(-32);
    expect(servoQ(frame({ kind: 'force', f: 0 }), s, p, false)).toBe(0);
    expect(servoQ(frame({ kind: 'force', f: 1e9 }), s, p, false)).toBe(127);
    const weak = level({ Fmax: 6 });
    expect(servoQ(frame({ kind: 'force', f: 1.5 }), s, weak, false)).toBe(32); // 0.25 Fmax
  });

  it('KV scales with the plant mass (5-1: M 2 + m 3 kg)', () => {
    const heavy = level({ m: 3.0 });
    const s = restState(0);
    // KV = 20/3 * 5 = 33.3 N s/m; v_cmd 0.3 -> F = 10 N -> q = 32
    expect(servoQ(frame({ kind: 'velocity', v: 0.3 }), s, heavy, false)).toBe(32);
  });

  it('clamps the target to [rail0 - 0.30, rail1 + 0.30]', () => {
    const p42 = level({ rail: [-0.6, 2.4] });
    expect(clampTarget(10, p42)).toBeCloseTo(2.7, 12);
    expect(clampTarget(-10, p42)).toBeCloseTo(-0.9, 12);
    const s = restState(2.6);
    expect(servoVcmd(frame({ kind: 'target', x: 50 }), s, p42, false)).toBeCloseTo(0.5, 12);
    expect(servoVcmd(frame({ kind: 'idle' }, -50), restState(-0.8), p42, false)).toBeCloseTo(-0.5, 12);
  });

  it('always returns an integer in [-127, 127] (never -0 or NaN)', () => {
    let seed = 7;
    const rnd = (): number => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32) * 2 - 1;
    const kinds: Intent['kind'][] = ['idle', 'target', 'velocity', 'force'];
    for (let i = 0; i < 5000; i++) {
      const s = restState(rnd() * 3, rnd() * 1.5);
      s.v = rnd() * 6;
      const k = kinds[i % 4];
      const it: Intent = k === 'idle' ? { kind: 'idle' } : k === 'target' ? { kind: 'target', x: rnd() * 8 }
        : k === 'velocity' ? { kind: 'velocity', v: rnd() * 8 } : { kind: 'force', f: rnd() * 80 };
      const q = servoQ(frame(it, i % 3 ? rnd() * 4 : null, i % 5 === 0), s, p, i % 2 === 0);
      expect(Number.isInteger(q)).toBe(true);
      expect(Math.abs(q)).toBeLessThanOrEqual(127);
      expect(Object.is(q, -0)).toBe(false);
    }
    expect(servoQ(frame({ kind: 'target', x: NaN }), restState(0), p, false)).toBe(0);
    expect(quantizeForce(-0.001, 40)).toBe(0);
    expect(Object.is(quantizeForce(-0.001, 40), -0)).toBe(false);
  });

  /** D4: an integer in [-127, 127], never -0, NaN or a fraction. */
  const isQ = (q: number): boolean => Number.isInteger(q) && q >= -127 && q <= 127 && !Object.is(q, -0);

  it('D4: quantizeForce is an integer in [-127, 127] for every F / Fmax, including non-finite and -0', () => {
    const odd = [NaN, Infinity, -Infinity, 0, -0, Number.MIN_VALUE, -Number.MIN_VALUE, 1e-300, -1e-300, 1e308, -1e308,
      Number.MAX_VALUE, -Number.MAX_VALUE, 0.5, -0.5, 40, -40, 40 / 254, -40 / 254];
    for (const F of odd) {
      for (const Fmax of [...odd, 6, 1e-12]) {
        const q = quantizeForce(F, Fmax);
        expect(isQ(q), `F=${F} Fmax=${Fmax} -> ${q}`).toBe(true);
      }
    }
    expect(quantizeForce(Infinity, Infinity)).toBe(0); // undefined ratio
    expect(quantizeForce(Infinity, 40)).toBe(127);
    expect(quantizeForce(-Infinity, 40)).toBe(-127);
    expect(quantizeForce(40, Number.MIN_VALUE)).toBe(127);
    expect(quantizeForce(1, -40)).toBe(0); // no valid Fmax
    expect(quantizeForce(40, NaN)).toBe(0);
  });

  it('D4: finite values keep the §3.2 rounding: round(127 F / Fmax) then clamp (half steps round up)', () => {
    const ref = (F: number, Fmax: number): number => {
      const q = Math.round((F * 127) / Fmax);
      return q > 127 ? 127 : q < -127 ? -127 : q === 0 ? 0 : q;
    };
    for (let k = -140; k <= 140; k++) {
      for (const d of [-0.5, -0.4999999, 0, 0.4999999, 0.5]) {
        const F = ((k + d) * 40) / 127;
        const q = quantizeForce(F, 40);
        expect(q, `k=${k} d=${d}`).toBe(ref(F, 40));
        expect(isQ(q)).toBe(true);
      }
    }
    expect(quantizeForce((-0.5 * 40) / 127, 40)).toBe(0); // Math.round(-0.5) is -0: reported as 0
    expect(quantizeForce((0.5 * 40) / 127, 40)).toBe(1);
  });

  it('D4: servoQ is an integer in [-127, 127] for non-finite states, intents, targets and plants', () => {
    const bad = [NaN, Infinity, -Infinity, -0, 1e308, -1e308];
    const intents: Intent[] = [{ kind: 'idle' }];
    for (const b of bad) intents.push({ kind: 'target', x: b }, { kind: 'velocity', v: b }, { kind: 'force', f: b });
    const plants = [p, level({ Fmax: Infinity }), level({ Fmax: NaN }), level({ Fmax: 0 }), level({ M: NaN }),
      level({ L: Infinity }), level({ rail: [NaN, NaN] })];
    let n = 0;
    for (const ph of plants) {
      for (const it of intents) {
        for (const field of ['x', 'v', 'th', 'none'] as const) {
          for (const b of field === 'none' ? [0] : bad) {
            const s = restState(0.5, 0.2);
            if (field !== 'none') s[field] = b;
            for (const targetX of [null, 0.7, NaN, Infinity]) {
              for (const assist of [false, true]) {
                const q = servoQ(frame(it, targetX, n % 2 === 0), s, ph, assist);
                expect(isQ(q), `${JSON.stringify(it)} ${field}=${b} targetX=${targetX} -> ${q}`).toBe(true);
                n++;
              }
            }
          }
        }
      }
    }
    expect(n).toBeGreaterThan(5000);
  });
});

describe('closed loop on the default plant (§3.2, Appendix B)', () => {
  it('1 m step: first within ±2 cm by 0.6 s, overshoot ≤ 7 cm, then the swing tugs the trolley ±4-5 cm', () => {
    const p = level();
    const s = restState(0);
    let first = -1, maxX = -Infinity, maxT = 0, minT = Infinity;
    const perSecond: number[] = [];
    for (let t = 1; t <= 360; t++) {
      const q = servoQ(frame({ kind: 'target', x: 1 }, 1), s, p, false);
      expect(Math.abs(q)).toBeLessThanOrEqual(127);
      minT = Math.min(minT, tick(p, s, q));
      maxT = Math.max(maxT, s.T);
      if (first < 0 && Math.abs(s.x - 1) <= 0.02) first = t / 60;
      maxX = Math.max(maxX, s.x);
      if (t % 60 === 0) perSecond.push(s.x);
    }
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThanOrEqual(0.6);
    expect(maxX - 1).toBeLessThanOrEqual(0.07);
    expect(minT).toBeGreaterThan(0); // stays taut: the taut test model is valid for this manoeuvre
    // Appendix B (Python): x at 1..6 s = 0.996, 1.025, 0.964, 1.041, 0.956, 1.044
    const py = [0.996, 1.025, 0.964, 1.041, 0.956, 1.044];
    perSecond.forEach((x, i) => expect(Math.abs(x - py[i])).toBeLessThan(0.003));
    // §3.2: done naively, a 1 m step peaks at 18.8 N and breaks the egg of 4-3 (its Tmax read from the level
    // data, so a retune of the level cannot leave a stale number here).
    expect(maxT).toBeGreaterThan(EGG_TMAX_43);
  });

  it('holding still: a 20° swing decays to 5° in 16 s and 3° in 22 s; the assist settles it in 5.3 s (8°: 1.5 s)', () => {
    const settle = (a0: number, assist: boolean): { t5: number; t3: number; x: number } => {
      const p = level();
      const s = restState(0, a0 * deg);
      let t5 = 0, t3 = 0;
      for (let t = 1; t <= 60 * 30; t++) {
        tick(p, s, servoQ(frame({ kind: 'idle' }, 0), s, p, assist));
        const a = amplitudeDeg(s);
        if (a > 5) t5 = t / 60; // last time above: "settled below" (Appendix B definition)
        if (a > 3) t3 = t / 60;
      }
      return { t5, t3, x: s.x };
    };
    const calm = settle(20, false);
    expect(calm.t5).toBeCloseTo(16.0, 0);
    expect(calm.t3).toBeCloseTo(22.4, 0);
    const helped = settle(20, true);
    expect(helped.t3).toBeCloseTo(5.3, 0);
    expect(Math.abs(helped.x)).toBeLessThan(0.01); // the assist does not walk the trolley away
    expect(settle(8, true).t3).toBeCloseTo(1.5, 0);
  });
});

describe('InputManager in the loop', () => {
  let m: InputManagerImpl;
  beforeEach(() => {
    document.body.innerHTML = '';
    m = createInputManager();
  });
  afterEach(() => m.dispose());

  it('keyboard ramp: 20 ticks to full speed, 5 ticks to stop; the stop tick targets the trolley x of that tick', () => {
    const p = level();
    m.setLevel(p);
    m.resetForRun(0);
    const s = restState(0);
    s.v = 0.3; // already moving (≥ KEY_TAP.restV): a press is a plain ramp, no tap window (R10)
    key('keydown', 'ArrowRight');
    const full = KEY_RAMP.cap / KEY_RAMP.up; // 20 ticks at 0.2 m/s per tick
    const up: number[] = [];
    for (let i = 0; i < full + 2; i++) {
      const f = m.sample(s);
      up.push(f.intent.kind === 'velocity' ? f.intent.v : NaN);
      tick(p, s, servoQ(f, s, p, false));
    }
    expect(up.slice(0, full)).toEqual(Array.from({ length: full }, (_, i) => ((i + 1) * KEY_RAMP.up) / KEY_RAMP.perMps));
    expect(up.slice(0, 3)).toEqual([0.2, 0.4, 0.6]);
    expect(up.indexOf(4) + 1).toBe(20);
    expect(up.slice(full)).toEqual([4, 4]);
    key('keyup', 'ArrowRight');
    const down: Intent[] = [];
    let xAtStop = NaN, holdAtStop: number | null = null;
    for (let i = 0; i < 5; i++) {
      xAtStop = s.x;
      const f = m.sample(s);
      down.push(f.intent);
      holdAtStop = f.targetX;
      tick(p, s, servoQ(f, s, p, false));
    }
    expect(down.slice(0, 4)).toEqual([3.2, 2.4, 1.6, 0.8].map((v) => ({ kind: 'velocity', v })));
    expect(down[4]).toEqual({ kind: 'target', x: xAtStop }); // v_cmd reached 0 on the 5th tick
    expect(holdAtStop).toBe(xAtStop);
    // ... and from there the hold point follows the braking trolley (stop latch, D1: next test).
    expect(m.debug().latching).toBe(true);
  });

  it('keyboard fine (Shift or Z): cap 0.5 m/s (R10) reached in 3 ticks after the 1 cm tap window', () => {
    const p = level();
    m.setLevel(p);
    m.resetForRun(0);
    const s = restState(0);
    key('keydown', 'KeyZ');
    key('keydown', 'KeyD');
    const W = KEY_TAP.windowTicks;
    const frames: InputFrame[] = [];
    for (let i = 0; i < W + 5; i++) frames.push(m.sample(s));
    for (const f of frames) expect(f.fine).toBe(true);
    expect(frames.slice(0, W).map((f) => f.intent)).toEqual(Array(W).fill({ kind: 'target', x: 0.01 }));
    expect(frames.slice(W).map((f) => (f.intent.kind === 'velocity' ? f.intent.v : NaN))).toEqual([0.2, 0.4, 0.5, 0.5, 0.5]);
  });

  it('holds position after a keyboard stop: with a 20° swing the trolley is within ±5 cm after 3 s', () => {
    const p = level();
    m.setLevel(p);
    m.resetForRun(0.5);
    const s = restState(0.5);
    // A tap (R10): the hold point moves 5 cm, the keys are released and the manager holds it.
    key('keydown', 'ArrowRight');
    let f = m.sample(s);
    expect(f.intent).toEqual({ kind: 'target', x: 0.55 });
    key('keyup', 'ArrowRight');
    f = m.sample(s);
    expect(f.intent.kind).toBe('idle');
    const hold = f.targetX as number;
    expect(hold).toBe(0.55);
    // The trolley stands at the hold point and the ball now swings 20°.
    s.x = hold;
    s.th = 20 * deg;
    s.w = 0;
    let worstAfter3 = 0, worst = 0;
    for (let t = 1; t <= 600; t++) {
      f = m.sample(s);
      expect(f.intent.kind).toBe('idle');
      expect(f.targetX).toBe(hold);
      tick(p, s, servoQ(f, s, p, false));
      const d = Math.abs(s.x - hold);
      worst = Math.max(worst, d);
      if (t >= 180) worstAfter3 = Math.max(worstAfter3, d);
    }
    expect(worstAfter3).toBeLessThanOrEqual(0.05);
    expect(worst).toBeLessThanOrEqual(0.05);
    expect(amplitudeDeg(s)).toBeGreaterThan(5); // the swing itself is still there (slow decay, §3.2)
  });

  it('stop latch (D1, the default): released at speed, the trolley brakes to rest and holds there (no spring-back)', () => {
    const p = level();
    m.setLevel(p);
    m.resetForRun(0);
    const s = restState(0);
    key('keydown', 'ArrowRight');
    // tap window, then the full 20-tick ramp to 4.0 and one tick at full speed
    const held = KEY_TAP.windowTicks + KEY_RAMP.cap / KEY_RAMP.up + 1;
    for (let i = 0; i < held; i++) tick(p, s, servoQ(m.sample(s), s, p, false));
    expect(m.debug().keyV).toBe(4);
    key('keyup', 'ArrowRight');
    let rampEndX = NaN, hold = NaN, minX = Infinity;
    for (let t = 0; t < 300; t++) {
      const f = m.sample(s);
      if (Number.isNaN(rampEndX) && f.intent.kind === 'target') rampEndX = f.intent.x;
      tick(p, s, servoQ(f, s, p, false));
      hold = f.targetX ?? NaN;
      if (t > 30) minX = Math.min(minX, s.x);
    }
    // Holding the stop tick's x (the non-default option stopLatch: false) would drag the trolley ~17 cm
    // back against its own brake (0.6-2.7 m on a 6 N level: servo_sim.test.ts).
    expect(hold - rampEndX).toBeGreaterThan(0.15); // held where it came to rest
    expect(hold - minX).toBeLessThan(0.06); // afterwards only the ~40° swing tugs it (±5 cm, like Appendix B)
    expect(m.debug().latching).toBe(false);
  });

  it('deck px -> m is independent of the camera; the fine band gives 1/3', () => {
    const p = level(); // rail [-1, 3.2]: 4.2 m over the deck width
    const L = layoutTall(390, 844);
    const scene = box(0, 0, 390, L.scene.h);
    const deck = box(0, L.scene.h, 390, L.deck!.h);
    let calls = 0;
    const camera: RailMapper = { screenToRailX: () => (++calls, Math.random() * 100) }; // "moving camera"
    m.attach(scene, deck, camera, L);
    m.setLevel(p);
    m.resetForRun(0);
    const s = restState(0);
    // The control surface is the deck under the force bar (controlSurface's fallback: no surface element here).
    const surf = controlSurface({ left: 0, top: L.scene.h, width: 390, height: L.deck!.h });
    expect(surf.top).toBe(L.scene.h + DECK_LAYOUT.forceBarPx);
    const surfaceTop = surf.top, surfaceH = surf.height;
    const yCoarse = surfaceTop + surfaceH * 0.3, yFine = surfaceTop + surfaceH * 0.85;

    ptr(deck, 'pointerdown', 100, yCoarse);
    expect(m.sample(s).targetX).toBe(0); // touching never moves the target
    ptr(deck, 'pointermove', 200, yCoarse + 150); // dragging into the band does not change k
    let f = m.sample(s);
    expect(f.targetX).toBeCloseTo((100 * 4.2) / 390, 12); // k = 1: 1.077 cm/px
    expect(f.fine).toBe(false);
    ptr(deck, 'pointerup', 200, yCoarse + 150);
    const after = m.sample(s).targetX as number;
    expect(after).toBeCloseTo(1.0769, 4); // released: the target stays

    ptr(deck, 'pointerdown', 300, yFine);
    ptr(deck, 'pointermove', 200, yFine - 200); // dragging out of the band keeps k = 1/3
    f = m.sample(s);
    expect(f.targetX).toBeCloseTo(after - (100 * 4.2) / 390 / 3, 12); // 3.6 mm/px
    expect(f.fine).toBe(true);
    expect(calls).toBe(0); // the deck never asks the camera
  });

  it('wide: screenToRailX error ≤ 5 mm with a mock camera, and the same value during camera shake', () => {
    const p = level();
    const L = layoutWide(1280, 720);
    const scene = box(0, 0, 1280, 720);
    const view = mockWideView(p.rail, 1280, 720, L.hudTop);
    m.attach(scene, null, view.mapper, L);
    m.setLevel(p);
    m.resetForRun(0);
    const s = restState(0);
    const xs = [-1.2, -0.7, 0, 0.55, 1.3, 1.63, 2.2, 2.9, 3.4];
    const measure = (shakeT: number): number[] => {
      const out: number[] = [];
      let id = 10;
      for (const x of xs) {
        for (const y of [-0.3, -0.1, 0.4, 1.2]) {
          const sp = view.toScreen(x, y); // where that world point is on the reference picture
          view.shake(shakeT, x * 13 + y); // the drawn camera shakes; the mapper must not care
          ptr(scene, 'pointerdown', sp.x, sp.y, { id: ++id, type: 'mouse' });
          const f = m.sample(s);
          ptr(scene, 'pointerup', sp.x, sp.y, { id, type: 'mouse' });
          expect(f.targetX).not.toBeNull();
          expect(Math.abs((f.targetX as number) - x)).toBeLessThanOrEqual(0.005);
          out.push(f.targetX as number);
        }
      }
      return out;
    };
    const calm = measure(0);
    const shaking = measure(1);
    expect(shaking).toEqual(calm);
    // A finger held still does not follow the shaking picture either.
    const sp = view.toScreen(1.0, 0.2);
    ptr(scene, 'pointerdown', sp.x, sp.y, { id: 99 });
    const held = m.sample(s).targetX;
    for (let i = 0; i < 20; i++) {
      view.shake(1 - i / 20, i);
      expect(m.sample(s).targetX).toBe(held);
    }
  });
});

export type { SimState };
