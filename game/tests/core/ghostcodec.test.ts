// Ghost channel codec must match tools/ghostcodec.py bit for bit (GAME_DESIGN.md §8.2). Owner: O3.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  decodeChannel, decodeChannelValues, encodeChannel, encodeChannelValues, quantize, type GhostChannel,
} from '../../src/core/ghostcodec';

interface Vector { channel: GhostChannel; note: string; values: number[]; ints: number[]; encoded: string }
const fixture = JSON.parse(readFileSync(new URL('../fixtures/ghostcodec_vectors.json', import.meta.url), 'utf8')) as {
  vectors: Vector[];
};

describe('ghostcodec vs tools/ghostcodec.py', () => {
  it('has the 10 fixture vectors', () => {
    expect(fixture.vectors.length).toBe(10);
  });

  for (const v of fixture.vectors) {
    it(`${v.channel}: ${v.note}`, () => {
      expect(quantize(v.values, v.channel)).toEqual(v.ints);
      expect(encodeChannel(v.ints)).toBe(v.encoded);
      expect(encodeChannelValues(v.values, v.channel)).toBe(v.encoded);
      expect(Array.from(decodeChannel(v.encoded))).toEqual(v.ints);
      const back = decodeChannelValues(v.encoded, v.channel);
      back.forEach((x, i) => expect(Math.abs(x - v.values[i]!)).toBeLessThanOrEqual(0.5 / (v.channel === 'f' ? 10 : 1e4) + 1e-12));
    });
  }

  it('round-trips random integer sequences', () => {
    let seed = 12345;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let k = 0; k < 300; k++) {
      const n = Math.floor(rnd() * 60);
      const ints = Array.from({ length: n }, () => Math.round((rnd() - 0.5) * 2 ** 28));
      expect(Array.from(decodeChannel(encodeChannel(ints)))).toEqual(ints);
    }
  });

  it('rejects malformed text', () => {
    expect(() => decodeChannel('ab*d')).toThrow();
    expect(() => decodeChannel('gA')).toThrow(); // 0x80: a varint that never ends
    expect(() => decodeChannel('A')).toThrow(); // impossible base64 length
    expect(Array.from(decodeChannel(''))).toEqual([]);
  });
});
