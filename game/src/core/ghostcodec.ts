// Ghost channel codec: delta + zigzag + LEB128 varint + base64url (GAME_DESIGN.md §8.2). Owner: O3.
// Must match game/tools/ghostcodec.py (tests/fixtures/ghostcodec_vectors.json).
//
//   quantise : x -> round(x * 1e4) (0.1 mm), th -> round(th * 1e4), F -> round(F * 10)   (Math.round)
//   layout   : first value as is, then differences to the previous value
//   varint   : zigzag (n >= 0 ? 2n : -2n-1), unsigned LEB128 (7 bits, low group first)
//   text     : base64url without padding
//
// Arithmetic uses plain numbers (not 32-bit bit operations) so values up to 2^52 survive.

export type GhostChannel = 'x' | 'th' | 'f';
export const CHANNEL_SCALE: Readonly<Record<GhostChannel, number>> = { x: 1e4, th: 1e4, f: 10 };

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64_INV: Int16Array = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < 64; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

function b64urlFromBytes(bytes: ArrayLike<number>, len: number): string {
  let out = '';
  let i = 0;
  for (; i + 2 < len; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
  }
  const rest = len - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]!;
  }
  return out;
}

function bytesFromB64url(s: string): Uint8Array {
  if (s.length % 4 === 1) throw new Error('ghostcodec: bad base64url length');
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const v = c < 128 ? B64_INV[c]! : -1;
    if (v < 0) throw new Error(`ghostcodec: bad base64url character at ${i}`);
    acc = ((acc << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

/** Quantises a channel with Math.round (ties towards +inf, like tools/ghostcodec.py js_round). */
export function quantize(values: ArrayLike<number>, channel: GhostChannel): number[] {
  const k = CHANNEL_SCALE[channel];
  const out = new Array<number>(values.length);
  for (let i = 0; i < values.length; i++) out[i] = Math.round(values[i]! * k) + 0; // + 0 turns -0 into 0
  return out;
}

/** Quantised integers -> base64url string. */
export function encodeChannel(values: ArrayLike<number>): string {
  const bytes: number[] = [];
  let prev = 0;
  for (let i = 0; i < values.length; i++) {
    const n = Math.round(values[i]!);
    const d = i === 0 ? n : n - prev;
    prev = n;
    let z = d >= 0 ? 2 * d : -2 * d - 1;
    for (;;) {
      const low = z % 128;
      z = Math.floor(z / 128);
      if (z > 0) {
        bytes.push(low | 0x80);
      } else {
        bytes.push(low);
        break;
      }
    }
  }
  return b64urlFromBytes(bytes, bytes.length);
}

/** base64url string -> quantised integers. Throws on malformed input (bad characters, truncated varint). */
export function decodeChannel(s: string): Int32Array {
  const data = bytesFromB64url(s);
  const out: number[] = [];
  let prev = 0;
  let z = 0;
  let mul = 1;
  let pending = false;
  for (let i = 0; i < data.length; i++) {
    const byte = data[i]!;
    z += (byte & 0x7f) * mul;
    if (byte & 0x80) {
      mul *= 128;
      pending = true;
      if (mul > 2 ** 49) throw new Error('ghostcodec: varint too long');
      continue;
    }
    const d = z % 2 === 0 ? z / 2 : -(z + 1) / 2;
    prev = out.length === 0 ? d : prev + d;
    out.push(prev);
    z = 0;
    mul = 1;
    pending = false;
  }
  if (pending) throw new Error('ghostcodec: truncated varint');
  return Int32Array.from(out);
}

/** decodeChannel followed by division by the channel scale. */
export function decodeChannelValues(s: string, channel: GhostChannel): Float64Array {
  const ints = decodeChannel(s);
  const k = CHANNEL_SCALE[channel];
  const out = new Float64Array(ints.length);
  for (let i = 0; i < ints.length; i++) out[i] = ints[i]! / k;
  return out;
}

/** quantize + encodeChannel. */
export function encodeChannelValues(values: ArrayLike<number>, channel: GhostChannel): string {
  return encodeChannel(quantize(values, channel));
}
