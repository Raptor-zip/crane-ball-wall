// Servo measurements of §3.2 / Appendix B re-measured on the TypeScript simulator (GAME_DESIGN.md §11 M1). Owner: O1.
// The servo is the §3.2 formula inlined in tests/sim/bots.ts (src/input/servo.ts belongs to O4).
// Run with --reporter=verbose to see the numbers that Appendix B quotes.
import { describe, expect, it } from 'vitest';
import { G, RAIL_Y } from '../../src/sim/constants';
import { SimEvents } from '../../src/sim/events';
import type { LevelPhysics } from '../../src/sim/level';
import { levelFacts } from '../../src/sim/display';
import { createRun, forceOfQ, Mode, setTautStateForTest, Status, stepTick, substepForTest, type Run } from '../../src/sim/run';
import { servoTarget } from './bots';
import { fixedLevel } from './levels_fixed';

const DEG = 180 / Math.PI;
const OPEN: LevelPhysics = { ...fixedLevel('2-2'), walls: [], phases: [{ kind: 'pad', xa: 3.1, xb: 3.2 }] };

/** String angle of the ball relative to the pivot (taut or slack), degrees. */
function ballAngle(run: Run): number {
  const s = run.s;
  return Math.atan2(s.bx - s.x, RAIL_Y - s.by) * DEG;
}

/** Swing amplitude from the swing energy (the quantity of the §4.6 rest test), degrees. */
function amplitude(run: Run): number {
  const s = run.s;
  const L = run.phys.L;
  const E = 0.5 * L * L * s.w * s.w + G * L * (1 - Math.cos(s.th));
  return Math.acos(Math.max(-1, 1 - E / (G * L))) * DEG;
}

interface Trace { t: number; x: number; v: number; ang: number; T: number; mode: Mode; amp: number }

/**
 * Drives a run with a per-tick controller and records every substep (120 Hz) plus the events.
 * The controller sees the state at the tick boundary, like the game's 60 Hz input tick.
 */
function drive(run: Run, ctrl: (tick: number) => number, ticks: number): { tr: Trace[]; ev: [number, number, number][] } {
  const tr: Trace[] = [];
  const evs: [number, number, number][] = [];
  const ev = new SimEvents();
  for (let k = 0; k < ticks; k++) {
    const F = forceOfQ(ctrl(k), run.phys.Fmax);
    for (let j = 0; j < 2; j++) {
      ev.clear();
      if (substepForTest(run, F, ev) !== Status.Running) return { tr, ev: evs };
      for (let i = 0; i < ev.n; i++) evs.push([ev.kind[i]!, ev.sub[i]! / 120, ev.a[i]!]);
      const s = run.s;
      tr.push({ t: s.substep / 120, x: s.x, v: s.v, ang: ballAngle(run), T: s.T, mode: s.mode, amp: amplitude(run) });
    }
  }
  return { tr, ev: evs };
}

const report: string[] = [];

describe('§3.2 servo on the TS simulator (default plant, KX = 5, KV = 20 N s/m, q quantised)', () => {
  it('dash from rest to 1.63 m: the swing stays below the 63.9 deg a 0.75 m wall needs', () => {
    const run = createRun(OPEN);
    const { tr, ev } = drive(run, () => servoTarget(run.s, OPEN, 1.63), 600);
    const slackBegin = ev.find((e) => e[0] === 2);
    const snap = ev.find((e) => e[0] === 1);
    const lag = Math.min(...tr.filter((p) => !slackBegin || p.t <= slackBegin[1]).map((p) => p.ang));
    const maxSwing = Math.max(...tr.map((p) => p.ang));
    const tMax = tr.find((p) => p.ang === maxSwing)!.t;
    const slackEnd = tr.find((p) => slackBegin && p.t > slackBegin[1] && p.mode === Mode.Taut)?.t;
    const req = levelFacts(fixedLevel('2-2')).reqDeg[0]!;
    report.push(
      `dash 0 -> 1.63 m: lag ${lag.toFixed(1)} deg while accelerating; slack ${slackBegin?.[1].toFixed(3)}-${slackEnd?.toFixed(3)} s; `
      + `snap J ${snap?.[2].toFixed(2)} N s at ${snap?.[1].toFixed(3)} s; max swing ${maxSwing.toFixed(2)} deg at ${tMax.toFixed(2)} s `
      + `(needed ${req.toFixed(1)} deg); max tension ${Math.max(...tr.map((p) => p.T)).toFixed(1)} N`,
    );
    expect(slackBegin).toBeDefined();
    expect(snap).toBeDefined();
    expect(snap![2]).toBeGreaterThan(1.0);
    expect(maxSwing).toBeLessThan(req);
    expect(maxSwing).toBeGreaterThan(req - 5); // "just short": a teasing miss, not a hopeless one
  });

  it('the plain dash on 2-2 itself does not get over wall A', () => {
    const p = fixedLevel('2-2');
    const run = createRun(p);
    const ev = new SimEvents();
    let st: Status = Status.Running;
    for (let k = 0; k < 600 && st === Status.Running; k++) st = stepTick(run, servoTarget(run.s, p, 1.63), ev);
    expect(st).toBe(Status.Crash);
    report.push(`dash on 2-2: crash kind ${run.s.crash!.kind} (1 ball, 2 string) at ${(run.s.substep / 120).toFixed(3)} s on wall ${run.s.crash!.wall}`);
  });

  it('1 m step: settles within 2 cm in < 0.6 s with <= 7 cm overshoot (O4 servo test numbers)', () => {
    const run = createRun(OPEN);
    const { tr } = drive(run, () => servoTarget(run.s, OPEN, 1.0), 360);
    const first = tr.find((p) => Math.abs(p.x - 1.0) <= 0.02)!.t;
    const over = Math.max(...tr.map((p) => p.x)) - 1.0;
    const swing = Math.max(...tr.map((p) => Math.abs(p.ang)));
    const Tmax = Math.max(...tr.map((p) => p.T));
    const xs = [1, 2, 3, 4, 5, 6].map((sec) => tr.find((p) => p.t >= sec)!.x.toFixed(3));
    report.push(`1 m step: first within 2 cm at ${first.toFixed(3)} s, overshoot ${(over * 100).toFixed(1)} cm, max swing ${swing.toFixed(1)} deg, `
      + `max tension ${Tmax.toFixed(1)} N, x at 1..6 s ${xs.join(', ')}`);
    expect(first).toBeLessThan(0.6);
    expect(over).toBeLessThanOrEqual(0.07);
  });

  it('1 m step with m = 3 kg (5-1)', () => {
    const p5: LevelPhysics = { ...OPEN, m: 3 };
    const run = createRun(p5);
    const { tr } = drive(run, () => servoTarget(run.s, p5, 1.0), 360);
    const over = Math.max(...tr.map((q) => q.x)) - 1.0;
    const swing = Math.max(...tr.map((q) => Math.abs(q.ang)));
    report.push(`1 m step, m = 3 kg: overshoot ${(over * 100).toFixed(1)} cm, max swing ${swing.toFixed(1)} deg`);
    expect(over).toBeLessThan(0.15);
  });

  it('a 20 deg swing left alone (servo holding) and with the anti-sway assist', () => {
    const decay = (amp0: number, assist: boolean): [number, number] => {
      const run = createRun(OPEN);
      setTautStateForTest(run, 1.0, 0, amp0 / DEG, 0);
      const { tr } = drive(run, () => servoTarget(run.s, OPEN, 1.0, false, assist), 60 * 60);
      // settling time: from then on the amplitude stays below the threshold
      const settle = (deg: number): number => {
        let last = -1;
        tr.forEach((p, i) => {
          if (p.amp >= deg) last = i;
        });
        return last + 1 < tr.length ? tr[last + 1]!.t : NaN;
      };
      return [settle(5), settle(3)];
    };
    const [a5, a3] = decay(20, false);
    const [, b3] = decay(20, true);
    const [, c3] = decay(8, true);
    report.push(`20 deg left alone (amplitude from the swing energy, settling time): 5 deg after ${a5.toFixed(1)} s, 3 deg after ${a3.toFixed(1)} s; assist KA = 3: 20 -> 3 deg ${b3.toFixed(1)} s, 8 -> 3 deg ${c3.toFixed(1)} s`);
    expect(a3).toBeGreaterThan(a5);
    expect(b3).toBeLessThan(a3);
    console.info(`\n[Appendix B, TS simulator]\n- ${report.join('\n- ')}\n`);
  });
});
