// Generated display names "adjective+noun#0000" and the player identity (GAME_DESIGN.md §7.7 "識別" / "表示名"). Owner: O8.
// DOM-free: shared by the client and (optionally) the Worker, so both derive the same pidh from a secret.
//
// !!! The word order below is PUBLIC DATA. Names are derived from the index, so reordering, inserting or
// !!! removing a word renames every player. Never change these lists after launch (tests/net/names.test.ts
// !!! pins them).

export interface NameWords { adj: readonly string[]; noun: readonly string[] }

export const NAME_WORDS: { ja: NameWords; en: NameWords } = {
  ja: {
    adj: [
      'しずかな', 'ゆかいな', 'まじめな', 'はやい', 'ねばりづよい', 'やさしい', 'かしこい', 'げんきな',
      'おだやかな', 'ほがらかな', 'だいたんな', 'ていねいな', 'すばやい', 'かろやかな', 'たのもしい', 'ひたむきな',
      'きままな', 'ふしぎな', 'すなおな', 'りりしい', 'あかるい', 'ゆうかんな', 'こまめな', 'さわやかな',
      'にこやかな', 'おおらかな', 'めざとい', 'ちいさな', 'まぶしい', 'のんびりした', 'ぶれない', 'きちょうめんな',
    ],
    noun: [
      'クレーン', '振り子', 'レンガ', '台車', 'ボール', 'フック', '滑車', 'レール',
      '歯車', 'ばね', 'おもり', '糸巻き', 'ワイヤー', 'ブランコ', '天びん', '定規',
      'コンパス', 'ノギス', 'スパナ', 'ボルト', 'メトロノーム', 'ジャイロ', 'ジャッキ', 'レバー',
      '磁石', 'モーター', 'ガントリー', 'ビー玉', '砂時計', 'ルーペ', 'ペンチ', 'ハンマー',
    ],
  },
  en: {
    adj: [
      'Quiet', 'Jolly', 'Earnest', 'Swift', 'Tenacious', 'Gentle', 'Clever', 'Lively',
      'Calm', 'Cheerful', 'Bold', 'Careful', 'Nimble', 'Graceful', 'Reliable', 'Devoted',
      'Carefree', 'Wondrous', 'Honest', 'Gallant', 'Bright', 'Brave', 'Diligent', 'Breezy',
      'Smiling', 'Easygoing', 'Keen', 'Little', 'Dazzling', 'Mellow', 'Steady', 'Precise',
    ],
    noun: [
      'Crane', 'Pendulum', 'Brick', 'Trolley', 'Ball', 'Hook', 'Pulley', 'Rail',
      'Gear', 'Spring', 'Bob', 'Spool', 'Wire', 'Swing', 'Balance', 'Ruler',
      'Compass', 'Caliper', 'Spanner', 'Bolt', 'Metronome', 'Gyro', 'Jack', 'Lever',
      'Magnet', 'Motor', 'Gantry', 'Marble', 'Hourglass', 'Loupe', 'Pliers', 'Hammer',
    ],
  },
};

const WORDS = 32;

/** Non-negative remainder (§7.5: every remainder is non-negative). */
function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

/** nameSeed as the uint16 it is stored as (tolerates garbage from the network). */
function seedOf(nameSeed: number): number {
  return Number.isFinite(nameSeed) ? mod(Math.trunc(nameSeed), 65536) : 0;
}

/** The 4-digit tag: parseInt(pidh.slice(0,4),16) % 10000, zero padded ("0000" for a malformed pidh). */
export function nameTag(pidh: string): string {
  const n = parseInt(String(pidh).slice(0, 4), 16);
  return String(Number.isFinite(n) ? n % 10000 : 0).padStart(4, '0');
}

export interface NameParts { adj: string; noun: string; tag: string }

/** The three pieces of a display name, for UIs that style the "#0000" tag separately. */
export function nameParts(nameSeed: number, pidh: string, lang: 'ja' | 'en'): NameParts {
  const w = lang === 'en' ? NAME_WORDS.en : NAME_WORDS.ja;
  const s = seedOf(nameSeed);
  return { adj: w.adj[s % WORDS]!, noun: w.noun[Math.floor(s / WORDS) % WORDS]!, tag: nameTag(pidh) };
}

/**
 * ADJ[seed % 32] + NOUN[floor(seed / 32) % 32] + "#" + (parseInt(pidh.slice(0,4),16) % 10000, zero padded).
 * ja: "しずかなクレーン#4821"; en (words separated by a space): "Quiet Crane#4821".
 */
export function displayName(nameSeed: number, pidh: string, lang: 'ja' | 'en'): string {
  const p = nameParts(nameSeed, pidh, lang);
  return lang === 'en' ? `${p.adj} ${p.noun}#${p.tag}` : `${p.adj}${p.noun}#${p.tag}`;
}

// ---------------------------------------------------------------------------------------------
// Randomness (crypto.getRandomValues when present; a Math.random fallback keeps the game working
// in exotic environments — the secret is then weaker, which only matters for impersonation).

/** n random bytes. */
export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  try {
    const c = (globalThis as { crypto?: Crypto }).crypto;
    if (c && typeof c.getRandomValues === 'function') {
      c.getRandomValues(out);
      return out;
    }
  } catch {
    // fall through to the fallback
  }
  let t = Date.now() >>> 0;
  for (let i = 0; i < n; i++) {
    t = (t + 0x9e3779b9) >>> 0;
    out[i] = (Math.floor(Math.random() * 256) ^ (t >>> ((i & 3) * 8))) & 0xff;
  }
  return out;
}

/** A fresh nameSeed (uint16). With `avoid`, the (adjective, noun) pair is guaranteed to differ from it. */
export function randomNameSeed(avoid?: number): number {
  const pair = (s: number): number => seedOf(s) % (WORDS * WORDS);
  for (let i = 0; i < 16; i++) {
    const b = randomBytes(2);
    const s = b[0]! | (b[1]! << 8);
    if (avoid === undefined || pair(s) !== pair(avoid)) return s;
  }
  // A degenerate random source (stubbed or broken crypto) must not hang the reroll button.
  return (seedOf(avoid ?? 0) + 1 + Math.floor(Math.random() * (WORDS * WORDS - 1))) % 65536;
}

// ---------------------------------------------------------------------------------------------
// base64url without padding (RFC 4648 §5), the same alphabet as src/sim/b64.ts. Local copy so the
// identity does not depend on the simulation module.

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function bytesToB64url(b: Uint8Array): string {
  let s = '';
  let i = 0;
  for (; i + 2 < b.length; i += 3) {
    const v = (b[i]! << 16) | (b[i + 1]! << 8) | b[i + 2]!;
    s += B64[v >> 18]! + B64[(v >> 12) & 63]! + B64[(v >> 6) & 63]! + B64[v & 63]!;
  }
  if (i < b.length) {
    const v = (b[i]! << 16) | ((i + 1 < b.length ? b[i + 1]! : 0) << 8);
    s += B64[v >> 18]! + B64[(v >> 12) & 63]!;
    if (i + 1 < b.length) s += B64[(v >> 6) & 63]!;
  }
  return s;
}

/** null when `s` is not canonical unpadded base64url. */
export function b64urlToBytes(s: string): Uint8Array | null {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const c0 = B64.indexOf(s[i]!), c1 = B64.indexOf(s[i + 1]!);
    const c2 = i + 2 < s.length ? B64.indexOf(s[i + 2]!) : 0;
    const c3 = i + 3 < s.length ? B64.indexOf(s[i + 3]!) : 0;
    const v = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    out[o++] = v >> 16;
    if (i + 2 < s.length) out[o++] = (v >> 8) & 255;
    if (i + 3 < s.length) out[o++] = v & 255;
  }
  return bytesToB64url(out) === s ? out : null;
}

// ---------------------------------------------------------------------------------------------
// Identity: secret = 16 random bytes (sent as base64url), pidh = first 16 hex digits of SHA-256 over
// the 16 raw bytes. SHA-256 is implemented here (synchronous, bit-exact with crypto.subtle — see
// tests/net/names.test.ts) so the id is available immediately and also where crypto.subtle is absent
// (insecure http origins, some file:// contexts).

export const SECRET_BYTES = 16;

/** A new secret: 16 random bytes as unpadded base64url (22 chars). */
export function newSecret(): string {
  return bytesToB64url(randomBytes(SECRET_BYTES));
}

/** True when `s` is base64url of exactly 16 bytes. */
export function isValidSecret(s: unknown): s is string {
  return typeof s === 'string' && s.length === 22 && b64urlToBytes(s)?.length === SECRET_BYTES;
}

/** pidh = hex(SHA-256(secret bytes)).slice(0, 16); null for a malformed secret. */
export function pidhFromSecret(secret: string): string | null {
  const b = isValidSecret(secret) ? b64urlToBytes(secret) : null;
  if (!b) return null;
  let hex = '';
  for (const x of sha256(b).subarray(0, 8)) hex += x.toString(16).padStart(2, '0');
  return hex;
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-256 (FIPS 180-4) of `msg`. */
export function sha256(msg: Uint8Array): Uint8Array {
  const len = msg.length;
  const buf = new Uint8Array(((len + 9 + 63) >> 6) << 6);
  buf.set(msg);
  buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(buf.length - 8, Math.floor(len / 0x20000000));
  dv.setUint32(buf.length - 4, (len << 3) >>> 0);

  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < buf.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + 4 * i);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!, b = w[i - 2]!;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[i] = w[i - 16]! + s0 + w[i - 7]! + s1;
    }
    let a = h[0]!, b = h[1]!, c = h[2]!, d = h[3]!, e = h[4]!, f = h[5]!, g = h[6]!, hh = h[7]!;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i]! + w[i]!) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] = h[0]! + a; h[1] = h[1]! + b; h[2] = h[2]! + c; h[3] = h[3]! + d;
    h[4] = h[4]! + e; h[5] = h[5]! + f; h[6] = h[6]! + g; h[7] = h[7]! + hh;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(4 * i, h[i]!);
  return out;
}
