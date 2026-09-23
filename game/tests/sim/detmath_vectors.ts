// Fixed detmath vectors (GAME_DESIGN.md §10.7): 32 sincos inputs and 32 atan2k inputs with the expected
// output bit patterns (IEEE-754 binary64, big-endian hex). Generated once with Node; every engine must match.
// Owner: O1. Shared by tests/sim/detmath.test.ts and tests/browser/golden.browser.test.ts.

const DV = new DataView(new ArrayBuffer(8));
/** IEEE-754 binary64 bit pattern of x as 16 hex digits (big-endian). */
export function f64hex(x: number): string {
  DV.setFloat64(0, x);
  return DV.getUint32(0).toString(16).padStart(8, '0') + DV.getUint32(4).toString(16).padStart(8, '0');
}

/** [x, sin(x) bits, cos(x) bits] */
export const SINCOS_VECTORS: [number, string, string][] = [
  [0, '0000000000000000', '3ff0000000000000'],
  [-0, '8000000000000000', '3ff0000000000000'],
  [1e-300, '01a56e1fc2f8f359', '3ff0000000000000'],
  [-2.5e-9, 'be25798ee2308c3a', '3ff0000000000000'],
  [0.00001, '3ee4f8b588e1e8a2', '3feffffffff920c8'],
  [0.1, '3fb98eaecb8bcb2c', '3fefd712f9a817c1'],
  [-0.3, 'bfd2e9cd95baba33', '3fee921dd42f09ba'],
  [0.5, '3fdeaee8744b05f0', '3fec1528065b7d50'],
  [0.7853981633974483, '3fe6a09e667f3bcc', '3fe6a09e667f3bcd'],
  [-0.7853981633974484, 'bfe6a09e667f3bcd', '3fe6a09e667f3bcc'],
  [1, '3feaed548f090cee', '3fe14a280fb5068c'],
  [-1.2345, 'bfee351c8409f41d', '3fd51e9b9f0886ae'],
  [1.5707963267948966, '3ff0000000000000', '3c91a62633100000'],
  [-1.5707963267948966, 'bff0000000000000', '3c91a62633100000'],
  [2, '3fed18f6ead1b446', 'bfdaa22657537205'],
  [2.356194490192345, '3fe6a09e667f3bcd', 'bfe6a09e667f3bcc'],
  [-3, 'bfc210386db6d55b', 'bfefae04be85e5d2'],
  [3.141592653589793, '3ca1a62633100000', 'bff0000000000000'],
  [-3.141592653589793, 'bca1a62633100000', 'bff0000000000000'],
  [3.5, 'bfd6733b7eba621f', 'bfedf77403c11a5f'],
  [4.71238898038469, 'bff0000000000000', 'bcaa79394ca00000'],
  [-5.123, '3fed570ea162c784', '3fd98bfec920aa2a'],
  [6.283185307179586, 'bcb1a62633100000', '3ff0000000000000'],
  [-6.3, 'bf9137a9c2cb3e7e', '3feffed789fc7a41'],
  [7.0685834705770345, '3fe6a09e667f3bca', '3fe6a09e667f3bce'],
  [8, '3fefa8d2a028cf7b', 'bfc29fbebf632f94'],
  [-8.75, 'bfe3fdbd16ccddc8', 'bfe8fcb01649e710'],
  [9.42477796076938, '3cba79394ca00000', 'bff0000000000000'],
  [-9.999999, '3fe1689d337a28e3', 'bfead9adad1e0d89'],
  [10, 'bfe1689ef5f34f53', 'bfead9ac890c6b1f'],
  [0.3490658503988659, '3fd5e3a8748a0bf5', '3fee11f642522d1c'],
  [-1.1135, 'bfecb6449b9e21d8', '3fdc41ed448a826b'],
];

/** [y, x, atan2k(y, x) bits] */
export const ATAN2_VECTORS: [number, number, string][] = [
  [0, 1, '0000000000000000'],
  [1, 1, '3fe921fb54442d18'],
  [-1, 1, 'bfe921fb54442d18'],
  [1, -1, '4002d97c7f3321d2'],
  [-1, -1, 'c002d97c7f3321d2'],
  [0.3, 0.9, '3fd4978fa3269ee1'],
  [-0.42, 0.13, 'bff4547b0b257f96'],
  [2.5, 0.01, '3ff911990c2b3bcc'],
  [0.001, 1.25, '3f4a36e28d4912d9'],
  [-0.999, 0.05, 'bff85525cddc006d'],
  [1e-10, 1, '3ddb7cdfd9d7bdbb'],
  [0.4375, 1, '3fda64eec3cc23fd'],
  [0.6875, 1, '3fe345f01cce37bb'],
  [1.1875, 1, '3febde70ed439fe7'],
  [2.4375, 1, '3ff2e75728833a54'],
  [-0.43749999999999994, 1, 'bfda64eec3cc23fc'],
  [0.95, -0.2, '3ffc73e2e46d7f74'],
  [-0.2, -0.95, 'c00779078c2f83eb'],
  [3, 4, '3fe4978fa3269ee1'],
  [-4, 3, 'bfedac670561bb4f'],
  [0.7071067811865476, 0.7071067811865475, '3fe921fb54442d19'],
  [1e-20, -1, '400921fb54442d18'],
  [0, -1, '400921fb54442d18'],
  [-0, -1, 'c00921fb54442d18'],
  [5, 0, '3ff921fb54442d18'],
  [-5, 0, 'bff921fb54442d18'],
  [0.6, 0.8, '3fe4978fa3269ee0'],
  [-0.8, 0.6, 'bfedac670561bb50'],
  [0.123456789, 0.987654321, '3fbfd5ba95db0a6b'],
  [1.5, 0.25, '3ff67d8863bc99bd'],
  [-0.05, 1.0000001, 'bfa994256cbaecfd'],
  [0.99, 0.01, '3ff8f89c0339bf7f'],
];
