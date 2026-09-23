// FNV-1a 32-bit hashing (GAME_DESIGN.md §4.3). Owner: O1.

export const FNV_OFFSET = 0x811c9dc5;
export const FNV_PRIME = 0x01000193;

/** FNV-1a over bytes, continuing from h (default: offset basis). Returns an unsigned 32-bit value. */
export function fnv1a(bytes: Uint8Array, h: number = FNV_OFFSET): number {
  let x = h >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    x = Math.imul(x ^ bytes[i]!, FNV_PRIME) >>> 0;
  }
  return x;
}

const F64_BUF = new ArrayBuffer(8);
const F64_VIEW = new DataView(F64_BUF);
const F64_BYTES = new Uint8Array(F64_BUF);

/**
 * Hashes a float64 as 8 little-endian bytes (via DataView), continuing from h. Allocation free.
 * Every NaN is hashed as the canonical quiet NaN 0x7ff8000000000000, because engines may store
 * different NaN payloads (ECMA-262 SetValueInBuffer).
 */
export function fnv1aF64(x: number, h: number): number {
  if (x !== x) {
    F64_VIEW.setUint32(0, 0, true);
    F64_VIEW.setUint32(4, 0x7ff80000, true);
  } else {
    F64_VIEW.setFloat64(0, x, true);
  }
  let r = h >>> 0;
  for (let i = 0; i < 8; i++) {
    r = Math.imul(r ^ F64_BYTES[i]!, FNV_PRIME) >>> 0;
  }
  return r;
}
