// base64url without padding (GAME_DESIGN.md §10.4). Owner: O1.
// Hand-written (no btoa/atob) so it behaves the same in browsers, Node and workerd.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const REVERSE = new Int16Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) REVERSE[ALPHABET.charCodeAt(i)] = i;

export function b64urlEncode(b: Uint8Array): string {
  const out: string[] = [];
  const n = b.length;
  let i = 0;
  for (; i + 2 < n; i += 3) {
    const v = (b[i]! << 16) | (b[i + 1]! << 8) | b[i + 2]!;
    out.push(ALPHABET[v >> 18]!, ALPHABET[(v >> 12) & 63]!, ALPHABET[(v >> 6) & 63]!, ALPHABET[v & 63]!);
  }
  const rest = n - i;
  if (rest === 1) {
    const v = b[i]! << 16;
    out.push(ALPHABET[v >> 18]!, ALPHABET[(v >> 12) & 63]!);
  } else if (rest === 2) {
    const v = (b[i]! << 16) | (b[i + 1]! << 8);
    out.push(ALPHABET[v >> 18]!, ALPHABET[(v >> 12) & 63]!, ALPHABET[(v >> 6) & 63]!);
  }
  return out.join('');
}

/** Throws on characters outside the base64url alphabet, '=' padding, impossible lengths and non-zero tail bits. */
export function b64urlDecode(s: string): Uint8Array {
  if (typeof s !== 'string') throw new Error('b64url: not a string');
  const n = s.length;
  if (n % 4 === 1) throw new Error('b64url: invalid length');
  const out = new Uint8Array(Math.floor((n * 3) / 4));
  const sextet = (k: number): number => {
    const c = s.charCodeAt(k);
    const v = c < 128 ? REVERSE[c]! : -1;
    if (v < 0) throw new Error(`b64url: invalid character at ${k}`);
    return v;
  };
  let o = 0;
  let i = 0;
  for (; i + 3 < n; i += 4) {
    const v = (sextet(i) << 18) | (sextet(i + 1) << 12) | (sextet(i + 2) << 6) | sextet(i + 3);
    out[o++] = v >> 16;
    out[o++] = (v >> 8) & 255;
    out[o++] = v & 255;
  }
  const rest = n - i;
  if (rest === 2) {
    const v = (sextet(i) << 18) | (sextet(i + 1) << 12);
    if (v & 0xffff) throw new Error('b64url: non-canonical tail');
    out[o++] = v >> 16;
  } else if (rest === 3) {
    const v = (sextet(i) << 18) | (sextet(i + 1) << 12) | (sextet(i + 2) << 6);
    if (v & 0xff) throw new Error('b64url: non-canonical tail');
    out[o++] = v >> 16;
    out[o++] = (v >> 8) & 255;
  }
  return out;
}
