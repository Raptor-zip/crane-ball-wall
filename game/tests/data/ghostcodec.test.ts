// Ghost channel codec vs the Python fixtures (GAME_DESIGN.md §8.2 "チャンネルの符号化", §10.7). Owner: O2.
//
// tests/fixtures/ghostcodec_vectors.json (written by tools/export_fixtures.py from tools/ghostcodec.py) is
// checked against two decoders:
//   - the local reference codec in ./helpers (independent BigInt implementation, used by the ghost gate),
//   - the REAL game codec src/core/ghostcodec.ts (owner O3), which the client uses to decode ghosts.
// Both must also decode every shipped ghost file identically.
import { describe, expect, it } from 'vitest';
import * as real from '../../src/core/ghostcodec';
import {
  LEVEL_IDS, hasData, readData, readFixture, refDecodeChannel, refDecodeInts, refEncodeInts, refQuantize,
  type Channel, type DailyGhostsFile, type GhostFile, type GhostJson,
} from './helpers';

interface Vector { channel: Channel; note: string; values: number[]; ints: number[]; encoded: string }
const fixture = readFixture<{ format: number; scale: Record<Channel, number>; vectors: Vector[] }>('ghostcodec_vectors.json');

/** Every shipped AI ghost: campaign files, plus daily_ghosts.json once it exists. */
function shippedGhosts(): [string, GhostJson][] {
  const out: [string, GhostJson][] = [];
  for (const id of LEVEL_IDS) {
    if (!hasData(`ghosts/${id}.json`)) continue;
    for (const g of readData<GhostFile>(`ghosts/${id}.json`).ghosts) out.push([`${id} ${g.kind}`, g]);
  }
  if (hasData('daily_ghosts.json')) {
    for (const [id, gs] of Object.entries(readData<DailyGhostsFile>('daily_ghosts.json').ghosts)) {
      for (const g of gs) out.push([`${id} ${g.kind}`, g]);
    }
  }
  return out;
}

describe('ghostcodec_vectors.json', () => {
  it('has format 1, the §8.2 scales and 10 vectors covering all channels', () => {
    expect(fixture.format).toBe(1);
    expect(fixture.scale).toEqual({ x: 1e4, th: 1e4, f: 10 });
    expect(fixture.vectors).toHaveLength(10);
    expect(new Set(fixture.vectors.map((v) => v.channel))).toEqual(new Set(['x', 'th', 'f']));
  });
});

describe('local reference codec (tests/data/helpers.ts)', () => {
  for (const v of fixture.vectors) {
    it(`${v.channel}: ${v.note}`, () => {
      expect(refQuantize(v.values, v.channel)).toEqual(v.ints);
      expect(refEncodeInts(v.ints)).toBe(v.encoded);
      expect(refDecodeInts(v.encoded)).toEqual(v.ints);
      const k = fixture.scale[v.channel];
      expect(Array.from(refDecodeChannel(v.encoded, v.channel))).toEqual(v.ints.map((n) => n / k));
    });
  }

  it('rejects malformed text', () => {
    expect(() => refDecodeInts('ab*d')).toThrow();
    expect(() => refDecodeInts('gA')).toThrow(); // 0x80: a varint that never ends
    expect(() => refDecodeInts('A')).toThrow(); // impossible base64url length
    expect(refDecodeInts('')).toEqual([]);
  });
});

describe('REAL decoder: src/core/ghostcodec.ts (O3)', () => {
  for (const v of fixture.vectors) {
    it(`${v.channel}: ${v.note}`, () => {
      expect(real.quantize(v.values, v.channel)).toEqual(v.ints);
      expect(real.encodeChannel(v.ints)).toBe(v.encoded);
      expect(real.encodeChannelValues(v.values, v.channel)).toBe(v.encoded);
      expect(Array.from(real.decodeChannel(v.encoded))).toEqual(v.ints);
      const k = fixture.scale[v.channel];
      expect(Array.from(real.decodeChannelValues(v.encoded, v.channel))).toEqual(v.ints.map((n) => n / k));
    });
  }

  it('interoperates with the reference codec on random sequences (both directions)', () => {
    let seed = 20261001;
    const rnd = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    for (let t = 0; t < 400; t++) {
      const n = Math.floor(rnd() * 80);
      const span = 2 ** Math.floor(rnd() * 28);
      const ints = Array.from({ length: n }, () => Math.round((rnd() - 0.5) * span) + 0); // + 0: no -0
      expect(Array.from(real.decodeChannel(refEncodeInts(ints)))).toEqual(ints);
      expect(refDecodeInts(real.encodeChannel(ints))).toEqual(ints);
    }
  });

  it('decodes every shipped ghost exactly like the reference decoder', () => {
    const ghosts = shippedGhosts();
    expect(ghosts.length).toBeGreaterThanOrEqual(36); // 18 levels x (ai + calm) at least
    for (const [name, g] of ghosts) {
      for (const ch of ['x', 'th', 'f'] as const) {
        const want = refDecodeChannel(g[ch], ch);
        expect(want.length, `${name} ${ch}: length vs n`).toBe(g.n);
        expect(Array.from(real.decodeChannelValues(g[ch], ch)), `${name} ${ch}`).toEqual(Array.from(want));
      }
    }
  });
});
