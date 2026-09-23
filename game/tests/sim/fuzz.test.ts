// Random-input robustness of the stepper (GAME_DESIGN.md §10.7). Owner: O1.
// 5 levels x 400 random q sequences x 10 s: no NaN, the slack ball never leaves the string's circle,
// the trolley never leaves the rail, no zero-speed rail stops, no frozen pendulum, and the mechanical energy
// never exceeds the start energy plus the work done by the trolley force (friction, impulses and rail stops
// only remove energy).
import { describe, expect, it } from 'vitest';
import { G, RAIL_Y } from '../../src/sim/constants';
import { SimEvents } from '../../src/sim/events';
import type { LevelPhysics } from '../../src/sim/level';
import { createRun, Mode, resetRun, Status, stepTick, type SimState } from '../../src/sim/run';
import { fixedLevel } from './levels_fixed';
import { servoTarget } from './bots';

const LEVELS = ['1-1', '2-2', '3-3', '4-2', '5-1'];
const RUNS = 400;
const TICKS = 600;

function energy(p: LevelPhysics, s: SimState): number {
  if (s.mode === Mode.Taut) {
    const cs = Math.cos(s.th);
    return 0.5 * (p.M + p.m) * s.v * s.v + p.m * p.L * s.v * s.w * cs + 0.5 * p.m * p.L * p.L * s.w * s.w
      + p.m * G * p.L * (1 - cs);
  }
  return 0.5 * p.M * s.v * s.v + 0.5 * p.m * (s.bvx * s.bvx + s.bvy * s.bvy) + p.m * G * (s.by - (RAIL_Y - p.L));
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIELDS = ['x', 'v', 'th', 'w', 'bx', 'by', 'bvx', 'bvy', 'F', 'T', 'minD2', 'peakF'] as const;

describe.each(LEVELS)('fuzz %s', (id) => {
  it(`${RUNS} random q sequences x ${TICKS} ticks`, () => {
    const p = fixedLevel(id);
    const run = createRun(p);
    const s = run.s;
    const ev = new SimEvents();
    const L2 = p.L * p.L;
    const problems: string[] = [];
    const note = (msg: string): void => {
      if (problems.length < 8) problems.push(msg);
    };
    const ends = [0, 0, 0, 0, 0];
    let slackTicks = 0;
    let stopHits = 0;
    let worstEnergyExcess = -Infinity;
    for (let r = 0; r < RUNS; r++) {
      resetRun(run);
      const rnd = mulberry32(1000 * (LEVELS.indexOf(id) + 1) + r);
      // held random levels, random walk, bang-bang, gentle random, servo into / near the rail ends
      const style = r % 5;
      let xt = 0;
      let q = 1;
      let left = 0;
      const e0 = energy(p, s);
      let work = 0;
      let st: Status = Status.Running;
      for (let k = 0; k < TICKS; k++) {
        if (style === 0) {
          if (left-- <= 0) {
            q = Math.floor(rnd() * 255) - 127;
            left = 3 + Math.floor(rnd() * 40);
          }
        } else if (style === 1) {
          q = Math.max(-127, Math.min(127, q + Math.floor(rnd() * 61) - 30));
        } else if (style === 2) {
          if (left-- <= 0) {
            q = q > 0 ? -127 : 127;
            left = 5 + Math.floor(rnd() * 50);
          }
        } else if (style === 3) {
          if (left-- <= 0) {
            q = Math.floor(rnd() * 41) - 20;
            left = 10 + Math.floor(rnd() * 60);
          }
        } else {
          // the §3.2 servo with the target at, just beyond or just inside an end (hold the trolley against the
          // stop while the ball swings: the pinned / release logic of §4.4 steps 2 and 8)
          if (left-- <= 0) {
            const end = rnd() < 0.5 ? p.rail[0] : p.rail[1];
            xt = end + (end > 0 ? 1 : -1) * (rnd() * 0.16 - 0.04);
            left = 30 + Math.floor(rnd() * 150);
          }
          q = servoTarget(s, p, xt);
        }
        const x0 = s.x;
        const th0 = s.th;
        const w0 = s.w;
        const taut0 = s.mode === Mode.Taut;
        st = stepTick(run, q, ev);
        work += s.F * (s.x - x0);
        for (let i = 0; i < ev.n; i++) {
          if (ev.kind[i] === 3) {
            stopHits++;
            if (!(ev.b[i]! > 0)) note(`StopHit without speed, run ${r} tick ${k}`);
          }
        }
        if (st === Status.Running && taut0 && s.mode === Mode.Taut && w0 !== 0 && s.th === th0 && s.w === w0) {
          note(`frozen pendulum, run ${r} tick ${k}`);
        }
        for (const f of FIELDS) if (s[f] !== s[f]) note(`NaN ${f}, run ${r} tick ${k}`);
        if (s.mode === Mode.Slack) {
          slackTicks++;
          const dx = s.bx - s.x;
          const dy = s.by - RAIL_Y;
          if (dx * dx + dy * dy > L2 + 1e-9) note(`slack ball outside the circle, run ${r} tick ${k}`);
        }
        if (s.x < p.rail[0] || s.x > p.rail[1]) note(`trolley off the rail, run ${r} tick ${k}`);
        if (s.pinned !== 0 && s.x !== p.rail[s.pinned === 1 ? 1 : 0]) note(`pinned away from the end, run ${r} tick ${k}`);
        const excess = energy(p, s) - (e0 + work);
        if (excess > worstEnergyExcess) worstEnergyExcess = excess;
        if (st !== Status.Running) break;
      }
      ends[st]!++;
    }
    expect(problems).toEqual([]);
    expect(worstEnergyExcess).toBeLessThanOrEqual(1e-6);
    // the fuzz reaches the interesting regimes
    expect(slackTicks).toBeGreaterThan(0);
    expect(stopHits).toBeGreaterThan(0);
    expect(ends.reduce((a, b) => a + b, 0)).toBe(RUNS);
  });
});
