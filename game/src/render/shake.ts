// Trauma camera shake, outside the simulation (GAME_DESIGN.md §9.2). Owner: O5.
//
// offset = 0.05 m * trauma^2, roll = 1.2 deg * trauma^2, trauma decays by 1.8 per second.
// Smooth value noise drives the direction; reduced motion disables it entirely.

export interface Shake {
  add(trauma: number): void;
  update(dt: number): { offset: number; rollDeg: number; ox: number; oy: number };
  reset(): void;
  reducedMotion: boolean;
}

export const SHAKE_OFFSET_M = 0.05;
export const SHAKE_ROLL_DEG = 1.2;
export const SHAKE_DECAY = 1.8;

/** Hash of an integer lattice point to [-1, 1]. */
function hash1(n: number, seed: number): number {
  const s = Math.sin((n + seed * 57.13) * 127.1) * 43758.5453;
  return (s - Math.floor(s)) * 2 - 1;
}

/** 1-D smooth value noise in [-1, 1]. */
function vnoise(t: number, seed: number): number {
  const i = Math.floor(t), f = t - i;
  const u = f * f * (3 - 2 * f);
  return hash1(i, seed) * (1 - u) + hash1(i + 1, seed) * u;
}

export function createShake(reducedMotion: boolean): Shake {
  let trauma = 0;
  let t = 0;
  const out = { offset: 0, rollDeg: 0, ox: 0, oy: 0 };
  const api: Shake = {
    reducedMotion,
    add(v) {
      if (api.reducedMotion || !(v > 0)) return; // also rejects NaN, which would stick for good
      trauma = Math.min(1, trauma + v);
    },
    update(dt) {
      if (!(dt > 0)) dt = 0; // NaN-safe
      t += dt;
      trauma = Math.max(0, trauma - SHAKE_DECAY * dt);
      const k = api.reducedMotion ? 0 : trauma * trauma;
      const f = t * 22;
      out.offset = SHAKE_OFFSET_M * k;
      out.ox = out.offset * vnoise(f, 1);
      out.oy = out.offset * vnoise(f, 2);
      out.rollDeg = SHAKE_ROLL_DEG * k * vnoise(f, 3);
      return out;
    },
    reset() {
      trauma = 0;
    },
  };
  return api;
}
