// Fixed-step loop (GAME_DESIGN.md §4.8) and wall-clock time effects (§9.5). Owner: O3.
import { describe, expect, it } from 'vitest';
import { createLoop, createTimeFx, type LoopEnv } from '../../src/core/loop';

function counter(): { ticks: number; frames: { alpha: number; dt: number }[]; hooks: { tick(): void; frame(a: number, d: number): void } } {
  const c = {
    ticks: 0,
    frames: [] as { alpha: number; dt: number }[],
    hooks: {
      tick: () => { c.ticks++; },
      frame: (alpha: number, dt: number) => { c.frames.push({ alpha, dt }); },
    },
  };
  return c;
}

describe('fixed-step loop', () => {
  it('runs 60 ticks per second at 60, 120 and 144 Hz displays', () => {
    for (const hz of [60, 120, 144]) {
      const c = counter();
      const loop = createLoop(c.hooks);
      for (let i = 0; i < hz * 10; i++) loop.advance(1 / hz);
      expect(Math.abs(c.ticks - 600)).toBeLessThanOrEqual(1);
      for (const f of c.frames) {
        expect(f.alpha).toBeGreaterThanOrEqual(0);
        expect(f.alpha).toBeLessThan(1);
      }
    }
  });

  it('runs at most 4 ticks per frame and drops the rest', () => {
    const c = counter();
    const loop = createLoop(c.hooks);
    expect(loop.advance(0.2)).toBe(4); // 12 ticks due, 4 run
    expect(loop.advance(1 / 60)).toBe(1); // the lag was dropped, not carried
    expect(c.ticks).toBe(5);
  });

  it('timeScale slows the sim (slow-mo 0.35, practice 0.5), 0 freezes it', () => {
    const c = counter();
    const loop = createLoop(c.hooks);
    loop.timeScale = 0.5;
    for (let i = 0; i < 600; i++) loop.advance(1 / 60);
    expect(c.ticks).toBe(300);
    loop.timeScale = 0.35;
    c.ticks = 0;
    for (let i = 0; i < 600; i++) loop.advance(1 / 60);
    expect(Math.abs(c.ticks - 210)).toBeLessThanOrEqual(1);
    loop.timeScale = 0;
    c.ticks = 0;
    for (let i = 0; i < 60; i++) loop.advance(1 / 60);
    expect(c.ticks).toBe(0);
    expect(c.frames.length).toBe(1260); // frames always render
  });

  it('pause stops ticks but not frames', () => {
    const c = counter();
    const loop = createLoop(c.hooks);
    loop.paused = true;
    for (let i = 0; i < 30; i++) loop.advance(1 / 60);
    expect(c.ticks).toBe(0);
    expect(c.frames.length).toBe(30);
    loop.paused = false;
    loop.advance(1 / 60);
    expect(c.ticks).toBe(1);
  });

  it('alpha is the fraction of the next tick', () => {
    const c = counter();
    const loop = createLoop(c.hooks);
    loop.advance(1 / 120);
    expect(c.frames.at(-1)!.alpha).toBeCloseTo(0.5, 9);
    loop.resetAccumulator();
    loop.advance(0);
    expect(c.frames.at(-1)!.alpha).toBe(0);
  });

  it('clamps long frame gaps and survives NaN', () => {
    const c = counter();
    const loop = createLoop(c.hooks);
    loop.advance(5);
    expect(c.ticks).toBe(4);
    loop.advance(Number.NaN);
    expect(c.ticks).toBe(4);
  });

  it('drives itself from requestFrame when started', () => {
    const c = counter();
    let t = 0;
    const pending: ((t: number) => void)[] = [];
    const env: LoopEnv = {
      now: () => t,
      requestFrame: (cb) => pending.push(cb),
      cancelFrame: () => { pending.length = 0; },
    };
    const loop = createLoop(c.hooks, env);
    loop.start();
    for (let i = 0; i < 61; i++) {
      t += 1000 / 60;
      pending.shift()!(t);
    }
    expect(c.ticks).toBe(60); // the first frame only sets the clock
    loop.stop();
    expect(loop.running).toBe(false);
  });
});

describe('time effects', () => {
  it('crash beat: hit-stop 80 ms, 0.35x for 0.25 s, then 1x', () => {
    const fx = createTimeFx();
    fx.sequence([[0, 0.08], [0.35, 0.25]]);
    expect(fx.scale()).toBe(0);
    fx.update(0.05);
    expect(fx.scale()).toBe(0);
    fx.update(0.05); // crosses into the second step
    expect(fx.scale()).toBe(0.35);
    fx.update(0.22);
    expect(fx.scale()).toBe(0.35);
    fx.update(0.02);
    expect(fx.scale()).toBe(1);
    expect(fx.active).toBe(false);
  });

  it('slow-mo pushes multiply and expire', () => {
    const fx = createTimeFx();
    fx.push(0.35, 0.25);
    expect(fx.scale()).toBe(0.35);
    fx.push(0.5, 1);
    expect(fx.scale()).toBeCloseTo(0.175, 12);
    fx.update(0.3);
    expect(fx.scale()).toBe(0.5);
    fx.clear();
    expect(fx.scale()).toBe(1);
  });
});
