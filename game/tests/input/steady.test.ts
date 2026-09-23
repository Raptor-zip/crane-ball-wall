// Steady assist (GAME_DESIGN.md §3.7): LQR hold near the goal, in the real simulator. Owner: O4.
import { describe, expect, it } from 'vitest';
import { servoQ, steadyGains, steadyGoal, STEADY } from '../../src/input/servo';
import type { InputFrame } from '../../src/input/types';
import { createRun, stepTick } from '../../src/sim/run';
import { SimEvents } from '../../src/sim/events';
import { level } from './plant';

const idle = (x: number): InputFrame => ({ intent: { kind: 'idle' }, fine: false, device: 0, targetX: x }) as InputFrame;
const target = (x: number): InputFrame => ({ intent: { kind: 'target', x }, fine: false, device: 0, targetX: x }) as InputFrame;
const STATUS_RUNNING = 1;
const STATUS_SUCCESS = 2;

/** Drag to x for 15 ticks (the manager's idle delay), then let go; seconds to Success or null. */
function dragAndRelease(steady: boolean, x: number, startX = 0): number | null {
  const phys = level({ startX });
  const run = createRun(phys);
  const ev = new SimEvents();
  for (let t = 1; t <= 60 * 25; t++) {
    const st = stepTick(run, servoQ(t <= 15 ? target(x) : idle(x), run.s, phys, false, steady), ev);
    if (st === STATUS_SUCCESS) return t / 60;
    if (st !== STATUS_RUNNING) return null;
  }
  return null;
}

describe('steady assist (§3.7)', () => {
  const phys = level(); // pad [1.2, 1.8]

  it('acts only on idle frames with a hold point within reach of the zone, pulled into the zone', () => {
    const s = createRun(phys).s;
    expect(steadyGoal(target(1.5), s, phys)).toBeNull();
    expect(steadyGoal(idle(1.5), s, phys)).toBe(1.5);
    expect(steadyGoal(idle(1.2 - STEADY.reach + 0.01), s, phys)).toBeCloseTo(1.2 + STEADY.inset, 12);
    expect(steadyGoal(idle(1.8 + 0.1), s, phys)).toBeCloseTo(1.8 - STEADY.inset, 12);
    expect(steadyGoal(idle(1.2 - STEADY.reach - 0.01), s, phys)).toBeNull();
    expect(steadyGoal(idle(0.3), s, phys)).toBeNull(); // far from the goal: a brake fling swings freely
  });

  it('the LQR gains are finite and cached per plant', () => {
    const k = steadyGains(phys);
    expect(k.every(Number.isFinite)).toBe(true);
    expect(steadyGains(level())).toBe(k);
    expect(steadyGains(level({ L: 0.6 }))).not.toBe(k);
  });

  it('a 1.5 m drag released over the pad: Success in under 4 s (without it the swing takes > 14 s)', () => {
    const on = dragAndRelease(true, 1.5);
    const off = dragAndRelease(false, 1.5);
    expect(on).not.toBeNull();
    expect(on!).toBeLessThan(4);
    expect(off === null || off > 14).toBe(true);
  });

  it('released 25 cm short of the pad, the ball is still settled on it', () => {
    const on = dragAndRelease(true, 1.2 - 0.25);
    expect(on).not.toBeNull();
    expect(on!).toBeLessThan(5);
  });

  it('servoQ without steady is unchanged (the assist is opt-in per call)', () => {
    const s = createRun(phys).s;
    s.th = 0.2;
    expect(servoQ(idle(1.5), s, phys, false)).toBe(servoQ(idle(1.5), s, phys, false, false));
    expect(servoQ(idle(1.5), s, phys, false, true)).not.toBe(servoQ(idle(1.5), s, phys, false, false));
  });
});
