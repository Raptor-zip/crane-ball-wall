// Fixed-step accumulator loop, max 4 ticks per frame (GAME_DESIGN.md §4.8, §4.7). Owner: O3.
//
//   acc += dtReal * timeScale; while acc >= 1/60 (at most 4 times): tick(); acc -= 1/60
//   lag beyond 4 ticks is dropped (no death spiral; the game slows down instead)
//   frame(alpha = acc * 60, dtReal) once per animation frame, for interpolation between prev and cur
//
// timeScale is how many sim seconds one wall-clock second consumes (slow-mo 0.35, practice 0.5, hit-stop 0).
// paused stops the accumulator (only the wall clock stops, §4.7) while frames keep rendering.

export const TICK_DT = 1 / 60;
export const MAX_TICKS_PER_FRAME = 4;
/** A longer gap between frames (tab switch, debugger) is treated as this long. */
export const MAX_FRAME_DT = 0.25;
/** Tolerance so a 60 Hz display does not alternate 0 / 2 ticks from rounding in the frame timestamps. */
const EPS = 1e-6;

export interface LoopHooks {
  tick(): void;                              // one 60 Hz tick
  frame(alpha: number, dtReal: number): void; // once per animation frame
}
export interface Loop {
  timeScale: number;
  paused: boolean;
  start(): void;
  stop(): void;
  /** Runs one frame of dtReal seconds by hand (tests, E2E fast-forward). Returns the number of ticks run. */
  advance(dtReal: number): number;
  /** Drops the accumulated fraction (after a retry, so tick 0 starts on a clean boundary). */
  resetAccumulator(): void;
  readonly running: boolean;
}

export interface LoopEnv {
  now(): number;                                   // ms
  requestFrame(cb: (t: number) => void): number;
  cancelFrame(id: number): void;
}

function defaultEnv(): LoopEnv {
  const g = globalThis as unknown as {
    requestAnimationFrame?: (cb: (t: number) => void) => number;
    cancelAnimationFrame?: (id: number) => void;
    performance?: { now(): number };
  };
  const now = (): number => (g.performance ? g.performance.now() : Date.now());
  if (g.requestAnimationFrame && g.cancelAnimationFrame) {
    return { now, requestFrame: (cb) => g.requestAnimationFrame!(cb), cancelFrame: (id) => g.cancelAnimationFrame!(id) };
  }
  return {
    now,
    requestFrame: (cb) => setTimeout(() => cb(now()), 16) as unknown as number,
    cancelFrame: (id) => clearTimeout(id),
  };
}

export function createLoop(hooks: LoopHooks, env: LoopEnv = defaultEnv()): Loop {
  let acc = 0;
  let last = -1;
  let rafId = -1;
  let running = false;

  const loop: Loop = {
    timeScale: 1,
    paused: false,
    get running() {
      return running;
    },
    start() {
      if (running) return;
      running = true;
      last = -1;
      const onFrame = (t: number): void => {
        if (!running) return;
        const now = Number.isFinite(t) && t > 0 ? t : env.now();
        const dt = last < 0 ? 0 : (now - last) / 1000;
        last = now;
        try {
          loop.advance(dt);
        } finally {
          if (running) rafId = env.requestFrame(onFrame);
        }
      };
      rafId = env.requestFrame(onFrame);
    },
    stop() {
      running = false;
      if (rafId >= 0) env.cancelFrame(rafId);
      rafId = -1;
    },
    advance(dtReal: number) {
      const dt = Math.min(Math.max(0, Number.isFinite(dtReal) ? dtReal : 0), MAX_FRAME_DT);
      let n = 0;
      if (!loop.paused) {
        const scale = Math.max(0, Number.isFinite(loop.timeScale) ? loop.timeScale : 1);
        acc += dt * scale;
        while (acc >= TICK_DT - EPS && n < MAX_TICKS_PER_FRAME) {
          hooks.tick();
          acc -= TICK_DT;
          n++;
        }
        if (acc >= TICK_DT - EPS) acc %= TICK_DT; // drop the lag beyond 4 ticks
      }
      hooks.frame(Math.min(1, Math.max(0, acc / TICK_DT)), dt);
      return n;
    },
    resetAccumulator() {
      acc = 0;
    },
  };
  return loop;
}

// ------------------------------------------------------------------------------------ time effects

/**
 * Wall-clock time effects (§9.5, Appendix A): hit-stop and slow-mo.
 * scale() is the product of the active effects; update(dtReal) ages them in wall-clock seconds.
 */
export interface TimeFx {
  /** Scale for `seconds` of wall-clock time. */
  push(scale: number, seconds: number): void;
  /** Runs effects one after the other (e.g. crash: hit-stop 0.08 s, then 0.35x for 0.25 s). */
  sequence(steps: readonly (readonly [scale: number, seconds: number])[]): void;
  update(dtReal: number): void;
  scale(): number;
  clear(): void;
  readonly active: boolean;
}

export function createTimeFx(): TimeFx {
  let fx: { scale: number; left: number }[] = [];
  let seq: { scale: number; left: number }[] = [];
  return {
    push(scale, seconds) {
      if (seconds > 0) fx.push({ scale, left: seconds });
    },
    sequence(steps) {
      seq = steps.filter(([, s]) => s > 0).map(([scale, left]) => ({ scale, left }));
    },
    update(dtReal) {
      const dt = Math.max(0, dtReal);
      if (fx.length > 0) {
        for (const e of fx) e.left -= dt;
        fx = fx.filter((e) => e.left > 0);
      }
      let carry = dt;
      while (seq.length > 0 && carry > 0) {
        const head = seq[0]!;
        const use = Math.min(carry, head.left);
        head.left -= use;
        carry -= use;
        if (head.left <= 1e-12) seq.shift();
      }
    },
    scale() {
      let s = seq.length > 0 ? seq[0]!.scale : 1;
      for (const e of fx) s *= e.scale;
      return s;
    },
    clear() {
      fx = [];
      seq = [];
    },
    get active() {
      return fx.length > 0 || seq.length > 0;
    },
  };
}
