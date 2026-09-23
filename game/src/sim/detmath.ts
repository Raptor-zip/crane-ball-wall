// Deterministic sincos / atan2k (GAME_DESIGN.md §4.3). Owner: O1.
//
// Only + - * / and comparisons (plus Math.abs / round) are used, so the results are bit-identical on
// every IEEE-754 engine (V8, SpiderMonkey, JavaScriptCore, workerd). The polynomials are the fdlibm
// kernels (__kernel_sin / __kernel_cos with the correction term y = 0, s_atan.c, e_atan2.c).

// ---- sincos -----------------------------------------------------------------------------------

const PIO4 = 7.85398163397448278999e-1;   // pi/4 (reduction threshold)
const INVPIO2 = 6.36619772367581382433e-1; // 2/pi
const PIO2_1 = 1.57079632673412561417e+0;  // first 33 bits of pi/2
const PIO2_1T = 6.07710050650619224932e-11; // pi/2 - PIO2_1

const S1 = -1.66666666666666324348e-1;
const S2 = 8.33333333332248946124e-3;
const S3 = -1.98412698298579493134e-4;
const S4 = 2.75573137070700676789e-6;
const S5 = -2.50507602534068634195e-8;
const S6 = 1.58969099521155010221e-10;

const C1 = 4.16666666666666019037e-2;
const C2 = -1.38888888888741095749e-3;
const C3 = 2.48015872894767294178e-5;
const C4 = -2.75573143513906633035e-7;
const C5 = 2.08757232129817482790e-9;
const C6 = -1.13596475577881948265e-11;

const ARG = new Float64Array(1);

/**
 * Writes [sin(x), cos(x)] into out[0], out[1]. Allocation free.
 * Computed on a = |x|; the sign of x is applied to sin only, so sin(-x) = -sin(x) and cos(-x) = cos(x)
 * hold bit for bit (including sin(-0) = -0).
 */
export function sincos(x: number, out: Float64Array): void {
  ARG[0] = x;
  sincosAt(ARG, 0, out);
}

/**
 * sincos of src[i] (same result as sincos(src[i], out)). The simulation's hot loop uses this form so that
 * no double crosses a call boundary (V8 would box it into a fresh HeapNumber when the call is not inlined).
 */
export function sincosAt(src: Float64Array, i: number, out: Float64Array): void {
  const x = src[i]!;
  if (x === 0) {
    out[0] = x; // keeps the sign of zero
    out[1] = 1;
    return;
  }
  const a = x < 0 ? -x : x;
  if (!(a < Infinity)) {
    // NaN or +-Infinity
    out[0] = NaN;
    out[1] = NaN;
    return;
  }
  let r: number;
  let quadrant: number;
  if (a <= PIO4) {
    r = a;
    quadrant = 0;
  } else {
    const n = Math.round(a * INVPIO2);
    r = (a - n * PIO2_1) - n * PIO2_1T;
    quadrant = ((n % 4) + 4) % 4;
  }
  const z = r * r;
  const ks = r + r * z * (S1 + z * (S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)))));
  const hz = 0.5 * z;
  const w = 1 - hz;
  const c = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
  const kc = w + (((1 - w) - hz) + z * c);
  let s: number;
  let co: number;
  if (quadrant === 0) {
    s = ks;
    co = kc;
  } else if (quadrant === 1) {
    s = kc;
    co = -ks;
  } else if (quadrant === 2) {
    s = -ks;
    co = -kc;
  } else {
    s = -kc;
    co = ks;
  }
  out[0] = x < 0 ? -s : s;
  out[1] = co;
}

// ---- atan / atan2 (fdlibm s_atan.c, e_atan2.c) --------------------------------------------------

const ATANHI0 = 4.63647609000806093515e-1; // atan(0.5) hi
const ATANHI1 = 7.85398163397448278999e-1; // atan(1.0) hi
const ATANHI2 = 9.82793723247329054082e-1; // atan(1.5) hi
const ATANHI3 = 1.57079632679489655800e+0; // atan(inf) hi
const ATANLO0 = 2.26987774529616870924e-17;
const ATANLO1 = 3.06161699786838301793e-17;
const ATANLO2 = 1.39033110312309984516e-17;
const ATANLO3 = 6.12323399573676603587e-17;

const AT0 = 3.33333333333329318027e-1;
const AT1 = -1.99999999998764832476e-1;
const AT2 = 1.42857142725034663711e-1;
const AT3 = -1.11111104054623557880e-1;
const AT4 = 9.09088713343650656196e-2;
const AT5 = -7.69187620504482999495e-2;
const AT6 = 6.66107313738753120669e-2;
const AT7 = -5.83357013379057348645e-2;
const AT8 = 4.97687799461593236017e-2;
const AT9 = -3.65315727442169155270e-2;
const AT10 = 1.62858201153657823623e-2;

const TWO66 = 7.378697629483821e19; // 2^66
const TWOM27 = 7.450580596923828e-9; // 2^-27
const TWO60 = 1.152921504606847e18; // 2^60
const TWOM60 = 8.673617379884035e-19; // 2^-60

const PI_O_4 = 7.8539816339744827900e-1;
const PI_O_2 = 1.5707963267948965580e+0;
const PI = 3.1415926535897931160e+0;
const PI_LO = 1.2246467991473531772e-16;

const A2 = new Float64Array(3);

/**
 * fdlibm atan2 port (e_atan2.c quadrant handling + s_atan.c). Deterministic across engines.
 * The exponent-difference tests (|y/x| > 2^60, < 2^-60) are done on |y| and |x| numerically.
 */
export function atan2k(y: number, x: number): number {
  A2[0] = y;
  A2[1] = x;
  atan2kAt(A2, A2, 2);
  return A2[2]!;
}

/**
 * atan2k(src[0], src[1]) written to out[i]. Calls nothing, so the simulation's hot loop never passes a
 * double across a call boundary (see sincosAt).
 */
export function atan2kAt(src: Float64Array, out: Float64Array, i: number): void {
  const y = src[0]!;
  const x = src[1]!;
  if (x !== x || y !== y) {
    out[i] = x + y; // NaN
    return;
  }
  // e_atan2.c: pick the argument of atan (or its value directly) and the quadrant fix-up mm
  let v = 0; // argument for the s_atan.c kernel
  let z = 0; // atan value when known without the kernel
  let useKernel = true;
  let mm: number;
  if (x === 1) {
    v = y; // atan2(y, 1) = atan(y)
    mm = 0;
  } else {
    // sign bits (-0 counts as negative), m = 2*sign(x) + sign(y)
    const m = (y < 0 || (y === 0 && 1 / y < 0) ? 1 : 0) | (x < 0 || (x === 0 && 1 / x < 0) ? 2 : 0);
    const ay = y < 0 ? -y : y;
    const ax = x < 0 ? -x : x;
    if (ay === 0) {
      // atan(+-0, +anything) = +-0; atan(+-0, -anything) = +-pi
      out[i] = m === 0 || m === 1 ? y : m === 2 ? PI : -PI;
      return;
    }
    if (ax === 0) {
      out[i] = m & 1 ? -PI_O_2 : PI_O_2;
      return;
    }
    if (ax === Infinity) {
      if (ay === Infinity) out[i] = m === 0 ? PI_O_4 : m === 1 ? -PI_O_4 : m === 2 ? 3.0 * PI_O_4 : -3.0 * PI_O_4;
      else out[i] = m === 0 ? 0 : m === 1 ? -0 : m === 2 ? PI : -PI;
      return;
    }
    if (ay === Infinity) {
      out[i] = m & 1 ? -PI_O_2 : PI_O_2;
      return;
    }
    mm = m;
    if (ay > TWO60 * ax) {
      z = PI_O_2 + 0.5 * PI_LO;
      mm &= 1;
      useKernel = false;
    } else if (m & 2 && ay < TWOM60 * ax) {
      z = 0.0;
      useKernel = false;
    } else {
      v = ay / ax;
    }
  }
  if (useKernel) {
    // s_atan.c; the high-word tests are replaced by comparisons of |v| (7/16, 11/16, 19/16, 39/16)
    if (v !== v) {
      z = v + v;
    } else {
      const neg = v < 0;
      let t = neg ? -v : v;
      if (t >= TWO66) {
        z = neg ? -ATANHI3 - ATANLO3 : ATANHI3 + ATANLO3;
      } else if (t < TWOM27) {
        z = v;
      } else {
        let id: number;
        if (t < 0.4375) {
          id = -1;
          t = v;
        } else if (t < 1.1875) {
          if (t < 0.6875) {
            id = 0;
            t = (2.0 * t - 1.0) / (2.0 + t);
          } else {
            id = 1;
            t = (t - 1.0) / (t + 1.0);
          }
        } else if (t < 2.4375) {
          id = 2;
          t = (t - 1.5) / (1.0 + 1.5 * t);
        } else {
          id = 3;
          t = -1.0 / t;
        }
        const zz = t * t;
        const w = zz * zz;
        const s1 = zz * (AT0 + w * (AT2 + w * (AT4 + w * (AT6 + w * (AT8 + w * AT10)))));
        const s2 = w * (AT1 + w * (AT3 + w * (AT5 + w * (AT7 + w * AT9))));
        if (id < 0) {
          z = t - t * (s1 + s2);
        } else {
          const hi = id === 0 ? ATANHI0 : id === 1 ? ATANHI1 : id === 2 ? ATANHI2 : ATANHI3;
          const lo = id === 0 ? ATANLO0 : id === 1 ? ATANLO1 : id === 2 ? ATANLO2 : ATANLO3;
          const r = hi - ((t * (s1 + s2) - lo) - t);
          z = neg ? -r : r;
        }
      }
    }
  }
  out[i] = mm === 0 ? z : mm === 1 ? -z : mm === 2 ? PI - (z - PI_LO) : (z - PI_LO) - PI;
}
