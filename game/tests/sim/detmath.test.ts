// Deterministic sincos / atan2k (GAME_DESIGN.md §4.3, §10.7). Owner: O1.
import { describe, expect, it } from 'vitest';
import { atan2k, atan2kAt, sincos, sincosAt } from '../../src/sim/detmath';
import { ATAN2_VECTORS, f64hex, SINCOS_VECTORS } from './detmath_vectors';

/** Deterministic xorshift-style generator for the sample points (test only). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe('sincos', () => {
  it('matches Math.sin / Math.cos within 5e-16 on 1e6 points of |x| <= 10', () => {
    const out = new Float64Array(2);
    const rnd = lcg(12345);
    let maxS = 0;
    let maxC = 0;
    for (let i = 0; i < 1_000_000; i++) {
      const x = (rnd() * 2 - 1) * 10;
      sincos(x, out);
      const ds = Math.abs(out[0]! - Math.sin(x));
      const dc = Math.abs(out[1]! - Math.cos(x));
      if (ds > maxS) maxS = ds;
      if (dc > maxC) maxC = dc;
    }
    expect(maxS).toBeLessThanOrEqual(5e-16);
    expect(maxC).toBeLessThanOrEqual(5e-16);
  }, 60_000);

  it('is odd / even bit for bit (sin(-x) = -sin(x), cos(-x) = cos(x))', () => {
    const a = new Float64Array(2);
    const b = new Float64Array(2);
    const rnd = lcg(777);
    let bad = 0;
    for (let i = 0; i < 200_000; i++) {
      // include values right at the reduction boundaries (n*pi/2 +- pi/4)
      const x = i < 1000 ? (i * Math.PI) / 4 + (i % 3 - 1) * 1e-12 : rnd() * 12;
      sincos(x, a);
      sincos(-x, b);
      if (!Object.is(b[0], -a[0]!) || !Object.is(b[1], a[1])) bad++;
    }
    expect(bad).toBe(0);
    sincos(-0, a);
    expect(Object.is(a[0], -0)).toBe(true);
    expect(a[1]).toBe(1);
  }, 60_000);

  it('returns NaN for NaN and infinities', () => {
    const out = new Float64Array(2);
    for (const x of [NaN, Infinity, -Infinity]) {
      sincos(x, out);
      expect(out[0]).toBeNaN();
      expect(out[1]).toBeNaN();
    }
  });

  it('reproduces the fixed 32-point bit patterns', () => {
    const out = new Float64Array(2);
    expect(SINCOS_VECTORS).toHaveLength(32);
    for (const [x, s, c] of SINCOS_VECTORS) {
      sincos(x, out);
      expect([x, f64hex(out[0]!), f64hex(out[1]!)]).toEqual([x, s, c]);
    }
  });
});

describe('atan2k', () => {
  it('matches Math.atan2 within 1e-15', () => {
    const rnd = lcg(4242);
    let maxErr = 0;
    for (let i = 0; i < 1_000_000; i++) {
      const scale = i % 4 === 0 ? 1e-3 : i % 4 === 1 ? 1 : i % 4 === 2 ? 10 : 1e3;
      const y = (rnd() * 2 - 1) * scale;
      const x = (rnd() * 2 - 1) * (i % 7 === 0 ? 1e-3 : 2);
      const d = Math.abs(atan2k(y, x) - Math.atan2(y, x));
      if (d > maxErr) maxErr = d;
    }
    expect(maxErr).toBeLessThanOrEqual(1e-15);
  }, 60_000);

  it('handles zeros, infinities and NaN like fdlibm', () => {
    const cases: [number, number][] = [
      [0, 0], [-0, 0], [0, -0], [-0, -0], [1, 0], [-1, 0], [0, 5], [-0, 5], [0, -5], [-0, -5],
      [Infinity, Infinity], [-Infinity, Infinity], [Infinity, -Infinity], [-Infinity, -Infinity],
      [3, Infinity], [-3, Infinity], [3, -Infinity], [-3, -Infinity], [Infinity, 2], [-Infinity, -2],
      [1e300, 1e-300], [1e-300, -1e300], [-1e-300, -1e300], [1e-20, 1],
    ];
    for (const [y, x] of cases) expect(Object.is(atan2k(y, x), Math.atan2(y, x))).toBe(true);
    expect(atan2k(NaN, 1)).toBeNaN();
    expect(atan2k(1, NaN)).toBeNaN();
  });

  it('is odd in y bit for bit', () => {
    const rnd = lcg(99);
    let bad = 0;
    for (let i = 0; i < 100_000; i++) {
      const y = rnd() * 3;
      const x = rnd() * 4 - 2;
      if (!Object.is(atan2k(-y, x), -atan2k(y, x))) bad++;
    }
    expect(bad).toBe(0);
  }, 60_000);

  it('reproduces the fixed 32-point bit patterns', () => {
    expect(ATAN2_VECTORS).toHaveLength(32);
    for (const [y, x, want] of ATAN2_VECTORS) expect([y, x, f64hex(atan2k(y, x))]).toEqual([y, x, want]);
  });
});

describe('array forms used by the stepper', () => {
  it('sincosAt / atan2kAt equal sincos / atan2k bit for bit', () => {
    const rnd = lcg(2024);
    const a = new Float64Array(2);
    const b = new Float64Array(2);
    const src = new Float64Array(3);
    let bad = 0;
    for (let i = 0; i < 200_000; i++) {
      const x = (rnd() * 2 - 1) * 12;
      sincos(x, a);
      src[1] = x;
      sincosAt(src, 1, b);
      if (!Object.is(a[0], b[0]) || !Object.is(a[1], b[1])) bad++;
      src[0] = (rnd() * 2 - 1) * 2;
      src[1] = (rnd() * 2 - 1) * 2;
      atan2kAt(src, src, 2);
      if (!Object.is(src[2], atan2k(src[0]!, src[1]!))) bad++;
    }
    expect(bad).toBe(0);
  }, 60_000);
});
