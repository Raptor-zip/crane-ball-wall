// Generated names and identity (GAME_DESIGN.md §7.7 "識別" / "表示名"). Owner: O8.
import { createHash, webcrypto } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  NAME_WORDS, b64urlToBytes, bytesToB64url, displayName, isValidSecret, nameParts, nameTag, newSecret,
  pidhFromSecret, randomNameSeed, sha256,
} from '../../src/shared/names';

// The published order. Changing src/shared/names.ts must fail this test: every player would be renamed.
const PINNED = {
  ja: {
    adj: 'しずかな ゆかいな まじめな はやい ねばりづよい やさしい かしこい げんきな おだやかな ほがらかな だいたんな ていねいな すばやい かろやかな たのもしい ひたむきな きままな ふしぎな すなおな りりしい あかるい ゆうかんな こまめな さわやかな にこやかな おおらかな めざとい ちいさな まぶしい のんびりした ぶれない きちょうめんな',
    noun: 'クレーン 振り子 レンガ 台車 ボール フック 滑車 レール 歯車 ばね おもり 糸巻き ワイヤー ブランコ 天びん 定規 コンパス ノギス スパナ ボルト メトロノーム ジャイロ ジャッキ レバー 磁石 モーター ガントリー ビー玉 砂時計 ルーペ ペンチ ハンマー',
  },
  en: {
    adj: 'Quiet Jolly Earnest Swift Tenacious Gentle Clever Lively Calm Cheerful Bold Careful Nimble Graceful Reliable Devoted Carefree Wondrous Honest Gallant Bright Brave Diligent Breezy Smiling Easygoing Keen Little Dazzling Mellow Steady Precise',
    noun: 'Crane Pendulum Brick Trolley Ball Hook Pulley Rail Gear Spring Bob Spool Wire Swing Balance Ruler Compass Caliper Spanner Bolt Metronome Gyro Jack Lever Magnet Motor Gantry Marble Hourglass Loupe Pliers Hammer',
  },
};

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

describe('name words', () => {
  it('are exactly the pinned 32 + 32 words per language, in the published order', () => {
    for (const lang of ['ja', 'en'] as const) {
      expect(NAME_WORDS[lang].adj.join(' ')).toBe(PINNED[lang].adj);
      expect(NAME_WORDS[lang].noun.join(' ')).toBe(PINNED[lang].noun);
    }
  });

  it('has 32 distinct, non-empty, trimmed words in every list', () => {
    for (const list of [NAME_WORDS.ja.adj, NAME_WORDS.ja.noun, NAME_WORDS.en.adj, NAME_WORDS.en.noun]) {
      expect(list).toHaveLength(32);
      expect(new Set(list).size).toBe(32);
      for (const w of list) {
        expect(w.length).toBeGreaterThan(0);
        expect(w.trim()).toBe(w);
        expect(w).not.toMatch(/[#\s]/);
      }
    }
  });

  it('starts with the words the spec lists (§7.7)', () => {
    expect(NAME_WORDS.ja.adj.slice(0, 5)).toEqual(['しずかな', 'ゆかいな', 'まじめな', 'はやい', 'ねばりづよい']);
    expect(NAME_WORDS.ja.noun.slice(0, 6)).toEqual(['クレーン', '振り子', 'レンガ', '台車', 'ボール', 'フック']);
    expect(NAME_WORDS.en.adj.slice(0, 2)).toEqual(['Quiet', 'Jolly']);
    expect(NAME_WORDS.en.noun.slice(0, 2)).toEqual(['Crane', 'Pendulum']);
  });

  it('contains no offensive words (English list screened against a deny list)', () => {
    const deny = /^(ass|damn|hell|sex|nut|screw|dick|cock|balls|slut|kill|die|dead|hate|stupid|dumb|ugly|fat|gay|drug|gun|rope|hang|suicide|nazi|bitch|crap|shit|fuck|hot|naughty|loose|nuts|screws|balls)$/i;
    for (const w of [...NAME_WORDS.en.adj, ...NAME_WORDS.en.noun]) expect(w).not.toMatch(deny);
    const denyJa = /(死|殺|バカ|ばか|アホ|あほ|ブス|クズ|きもい|キモい|うざい|ころす|しね)/;
    for (const w of [...NAME_WORDS.ja.adj, ...NAME_WORDS.ja.noun]) expect(w).not.toMatch(denyJa);
  });
});

describe('displayName', () => {
  it('is ADJ[seed % 32] + NOUN[floor(seed / 32) % 32] + "#" + 4 digits of the pidh', () => {
    // parseInt('12d5', 16) = 4821
    expect(displayName(0, '12d5aaaaaaaaaaaa', 'ja')).toBe('しずかなクレーン#4821');
    expect(displayName(0, '12d5aaaaaaaaaaaa', 'en')).toBe('Quiet Crane#4821');
    expect(displayName(1 + 32 * 2, '0000ffffffffffff', 'ja')).toBe('ゆかいなレンガ#0000');
    expect(displayName(31 + 32 * 31, 'ffff000000000000', 'en')).toBe('Precise Hammer#5535');
    // uint16: 1024 names repeat with period 1024.
    expect(displayName(1024 + 5, 'abcd000000000000', 'ja')).toBe(displayName(5, 'abcd000000000000', 'ja'));
    expect(displayName(65535, '0001000000000000', 'en')).toBe('Precise Hammer#0001');
  });

  it('uses the same index for both languages', () => {
    for (let seed = 0; seed < 65536; seed += 997) {
      const ja = nameParts(seed, '0000', 'ja');
      const en = nameParts(seed, '0000', 'en');
      expect(NAME_WORDS.ja.adj.indexOf(ja.adj)).toBe(NAME_WORDS.en.adj.indexOf(en.adj));
      expect(NAME_WORDS.ja.noun.indexOf(ja.noun)).toBe(NAME_WORDS.en.noun.indexOf(en.noun));
    }
  });

  it('tolerates garbage from the wire', () => {
    expect(nameTag('zzzz')).toBe('0000');
    expect(nameTag('')).toBe('0000');
    expect(displayName(Number.NaN, 'zz', 'ja')).toBe('しずかなクレーン#0000');
    expect(displayName(-1, '270f', 'en')).toBe('Precise Hammer#9999'); // -1 wraps to 65535
    expect(displayName(33.7, '0010', 'en')).toBe('Jolly Pendulum#0016');
  });

  it('randomNameSeed gives a uint16 and a different name when rerolling', () => {
    for (let i = 0; i < 200; i++) {
      const a = randomNameSeed();
      expect(Number.isInteger(a) && a >= 0 && a <= 65535).toBe(true);
      const b = randomNameSeed(a);
      expect(displayName(b, '0000', 'ja')).not.toBe(displayName(a, '0000', 'ja'));
    }
  });
});

describe('randomNameSeed with a broken random source', () => {
  it('still terminates and still gives a different name when crypto returns zeros', () => {
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(((a: ArrayBufferView) => a) as Crypto['getRandomValues']);
    try {
      expect(randomNameSeed()).toBe(0);
      for (const avoid of [0, 5, 1023, 65535]) {
        const b = randomNameSeed(avoid);
        expect(Number.isInteger(b) && b >= 0 && b <= 65535).toBe(true);
        expect(displayName(b, '0000', 'en')).not.toBe(displayName(avoid, '0000', 'en'));
      }
    } finally {
      spy.mockRestore();
    }
  });
});

describe('identity', () => {
  it('sha256 matches node:crypto on many lengths (incl. multi-block and the padding edges)', () => {
    for (const n of [0, 1, 3, 16, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000]) {
      const b = new Uint8Array(n);
      for (let i = 0; i < n; i++) b[i] = (i * 73 + n * 31) & 255;
      expect(hex(sha256(b))).toBe(createHash('sha256').update(b).digest('hex'));
    }
    expect(hex(sha256(new TextEncoder().encode('abc')))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('pidh = first 16 hex of SHA-256 over the 16 secret bytes, bit-exact with crypto.subtle', async () => {
    for (let i = 0; i < 50; i++) {
      const secret = newSecret();
      const bytes = b64urlToBytes(secret)!;
      expect(bytes).toHaveLength(16);
      const digest = new Uint8Array(await webcrypto.subtle.digest('SHA-256', bytes));
      expect(pidhFromSecret(secret)).toBe(hex(digest).slice(0, 16));
    }
  });

  it('a fixed vector (for the Worker owner to cross-check)', () => {
    const secret = bytesToB64url(Uint8Array.from({ length: 16 }, (_, i) => i));
    expect(secret).toBe('AAECAwQFBgcICQoLDA0ODw');
    expect(pidhFromSecret(secret)).toBe(createHash('sha256').update(Uint8Array.from({ length: 16 }, (_, i) => i)).digest('hex').slice(0, 16));
    expect(pidhFromSecret(secret)).toBe('be45cb2605bf36be');
  });

  it('secrets are 22-char base64url of 16 random bytes; malformed ones are refused', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const s = newSecret();
      expect(s).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(isValidSecret(s)).toBe(true);
      seen.add(s);
    }
    expect(seen.size).toBe(100);
    for (const bad of ['', 'abc', 'AAECAwQFBgcICQoLDA0ODw==', 'AAECAwQFBgcICQoLDA0OD', 'AAECAwQFBgcICQoLDA0OD+', 'AAECAwQFBgcICQoLDA0ODx', 42, null]) {
      expect(isValidSecret(bad)).toBe(false);
    }
    expect(pidhFromSecret('nope')).toBeNull();
  });

  it('base64url round-trips every length and rejects non-canonical input', () => {
    for (let n = 0; n < 40; n++) {
      const b = Uint8Array.from({ length: n }, (_, i) => (i * 151 + 7) & 255);
      const s = bytesToB64url(b);
      expect(s).toBe(Buffer.from(b).toString('base64url'));
      expect(Array.from(b64urlToBytes(s)!)).toEqual(Array.from(b));
    }
    expect(b64urlToBytes('A')).toBeNull();
    expect(b64urlToBytes('AB')).toBeNull(); // non-zero padding bits
    expect(b64urlToBytes('a+b/')).toBeNull();
  });
});
