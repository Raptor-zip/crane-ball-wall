// Replay codec, base64url and re-simulation (GAME_DESIGN.md §10.4, §10.7). Owner: O1.
import { describe, expect, it } from 'vitest';
import { b64urlDecode, b64urlEncode } from '../../src/sim/b64';
import { MAX_SUB, RANKED_MAX_TICKS, REPLAY_MAX_BYTES, SIM_VERSION } from '../../src/sim/constants';
import { levelHash } from '../../src/sim/level';
import {
  decodeReplay, DeviceTag, encodeReplay, REPLAY_MAX_TICKS, ReplayFlag, simulateReplay, type ReplayHeader,
} from '../../src/sim/replay';
import { SimEvents } from '../../src/sim/events';
import { createRun, Status, stepTick } from '../../src/sim/run';
import { fixedLevel } from './levels_fixed';
import { bangBang, runBot } from './bots';

function header(n: number, over: Partial<ReplayHeader> = {}): ReplayHeader {
  return { fmt: 1, sim: SIM_VERSION, levelHash: '85c33183', device: DeviceTag.Touch, flags: 0, nTicks: n, ...over };
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe('base64url', () => {
  it('round-trips every length 0..300 and matches the standard alphabet', () => {
    const r = rng(1);
    for (let n = 0; n < 300; n++) {
      const b = Uint8Array.from({ length: n }, () => Math.floor(r() * 256));
      const s = b64urlEncode(b);
      expect(s).toMatch(/^[A-Za-z0-9_-]*$/);
      expect(s.length).toBe(Math.ceil((n * 4) / 3));
      expect(b64urlDecode(s)).toEqual(b);
      // same text as standard base64 with - _ and without padding
      const std = Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      expect(s).toBe(std);
    }
  });

  it('rejects bad input', () => {
    expect(() => b64urlDecode('abc=')).toThrow();
    expect(() => b64urlDecode('ab+c')).toThrow();
    expect(() => b64urlDecode('abcde')).toThrow(); // length % 4 == 1
    expect(() => b64urlDecode('ab')).toThrow(); // non-zero tail bits ('b' = 27 -> low bits set)
    expect(() => b64urlDecode('あいう')).toThrow();
    expect(b64urlDecode('')).toEqual(new Uint8Array(0));
  });
});

describe('replay codec', () => {
  it('round-trips headers and q sequences (runs, deltas, extremes)', () => {
    const r = rng(7);
    const seqs: number[][] = [
      [],
      [5],
      [127, -127, 127, -127, 0, 0, 0, 1],
      Array.from({ length: 2700 }, () => 0),
      Array.from({ length: 1000 }, (_v, i) => (i < 500 ? 40 : -3)),
      Array.from({ length: 2700 }, () => Math.floor(r() * 255) - 127),
      Array.from({ length: 3600 }, (_v, i) => Math.round(100 * Math.sin(i / 20))),
    ];
    for (const seq of seqs) {
      const qs = Int8Array.from(seq);
      for (const [device, flags] of [[DeviceTag.Unknown, 0], [DeviceTag.Mixed, ReplayFlag.Assisted | ReplayFlag.Practice | ReplayFlag.DirectForce]] as const) {
        const h = header(qs.length, { device, flags, levelHash: levelHash(fixedLevel('4-2')) });
        const bytes = encodeReplay(h, qs);
        expect(bytes.length).toBeLessThanOrEqual(REPLAY_MAX_BYTES);
        const back = decodeReplay(bytes);
        expect(back.h).toEqual(h);
        expect(back.qs).toEqual(qs);
        // through base64url too
        expect(decodeReplay(b64urlDecode(b64urlEncode(bytes))).qs).toEqual(qs);
      }
    }
  });

  it('writes the documented byte layout', () => {
    const bytes = encodeReplay(header(5, { levelHash: '0a0b0c0d', device: DeviceTag.Keyboard, flags: ReplayFlag.DirectForce }), Int8Array.from([3, 3, 3, -1, -1]));
    expect(Array.from(bytes)).toEqual([
      0x59, 0x50, 1, SIM_VERSION, 0x0d, 0x0c, 0x0b, 0x0a, 3, 4,
      5, // nTicks
      12, // +3: zigzag 6 -> hd 12
      1, // the current q twice more: repeat token (2-2)*2+1
      14, // -4: zigzag 7 -> hd 14
      0, // -1 once more (delta 0)
    ]);
  });

  it('fits the worst 2700-tick input into 6 KB and a keyboard-like run into a few dozen bytes', () => {
    // worst case: every tick a maximal jump (2-byte varint each)
    const worst = Int8Array.from({ length: RANKED_MAX_TICKS }, (_v, i) => (i % 2 === 0 ? 127 : -127));
    const bytes = encodeReplay(header(worst.length), worst);
    expect(bytes.length).toBeLessThanOrEqual(REPLAY_MAX_BYTES);
    expect(bytes.length).toBe(10 + 2 + 2 * RANKED_MAX_TICKS);
    // touch-like: q changes every tick by a few units
    const r = rng(3);
    let q = 0;
    const touch = Int8Array.from({ length: RANKED_MAX_TICKS }, () => (q = Math.max(-127, Math.min(127, q + Math.floor(r() * 21) - 10))));
    expect(encodeReplay(header(touch.length), touch).length).toBeLessThanOrEqual(REPLAY_MAX_BYTES);
    // keyboard-like: long constant stretches
    const kb = Int8Array.from({ length: 600 }, (_v, i) => (i < 40 ? 127 : i < 60 ? -127 : i < 300 ? 0 : 20));
    expect(encodeReplay(header(kb.length), kb).length).toBeLessThan(40);
  });

  it('throws when the encoding would exceed 6 KB', () => {
    const big = Int8Array.from({ length: REPLAY_MAX_TICKS }, (_v, i) => (i % 2 === 0 ? 127 : -127));
    expect(() => encodeReplay(header(big.length), big)).toThrow(/6144|larger/);
  });

  it('rejects malformed replays', () => {
    const good = encodeReplay(header(4), Int8Array.from([1, 2, 3, 4]));
    const mut = (f: (b: number[]) => void): Uint8Array => {
      const b = Array.from(good);
      f(b);
      return Uint8Array.from(b);
    };
    expect(() => decodeReplay(new Uint8Array(0))).toThrow();
    expect(() => decodeReplay(good.subarray(0, 9))).toThrow();
    expect(() => decodeReplay(mut((b) => (b[0] = 0x58)))).toThrow(/magic/);
    expect(() => decodeReplay(mut((b) => (b[2] = 2)))).toThrow(/fmt/);
    expect(() => decodeReplay(mut((b) => (b[8] = 6)))).toThrow(/device/);
    expect(() => decodeReplay(mut((b) => (b[9] = 8)))).toThrow(/flags/);
    expect(() => decodeReplay(mut((b) => b.push(0)))).toThrow(/trailing/);
    expect(() => decodeReplay(mut((b) => b.pop()))).toThrow();
    expect(() => decodeReplay(mut((b) => (b[10] = 3)))).toThrow(); // fewer ticks than data
    expect(() => decodeReplay(mut((b) => (b[10] = 9)))).toThrow(); // more ticks than data
    // q out of range: +127 then +2
    expect(() => decodeReplay(encodeReplayRaw([508, 8]))).toThrow(/range/);
    // repeat running past nTicks
    expect(() => decodeReplay(encodeReplayRaw([2, 2 * 5 + 1], 3))).toThrow(/repeat/);
    // absurd tick counts
    expect(() => decodeReplay(encodeReplayRaw([], MAX_SUB))).toThrow(/longer/);
    // encodeReplay validates its header
    expect(() => encodeReplay(header(2), Int8Array.from([1]))).toThrow();
    expect(() => encodeReplay(header(1, { levelHash: 'XYZ' }), Int8Array.from([1]))).toThrow();
    expect(() => encodeReplay(header(1), Int8Array.from([-128]))).toThrow();
  });
});

/** A replay with a hand-made q stream (hd values as single-byte varints), for the negative tests. */
function encodeReplayRaw(hds: number[], nTicks?: number): Uint8Array {
  const out = [0x59, 0x50, 1, SIM_VERSION, 0, 0, 0, 0, 0, 0];
  let n = nTicks ?? hds.length;
  while (n >= 128) {
    out.push((n % 128) | 128);
    n = Math.floor(n / 128);
  }
  out.push(n);
  for (const hd of hds) {
    let v = hd;
    while (v >= 128) {
      out.push((v % 128) | 128);
      v = Math.floor(v / 128);
    }
    out.push(v);
  }
  return Uint8Array.from(out);
}

describe('simulateReplay', () => {
  it('matches stepping by hand, stops at the end of the run and hashes deterministically', () => {
    const p = fixedLevel('1-1');
    const qs = runBot(p, bangBang(17, 11)(p), 900);
    const res = simulateReplay(p, qs);
    expect(res.status).toBe(Status.Success);
    expect(res.ticks).toBe(qs.length);
    // a successful run ends on tick ceil((score + 59) / 2)  (§4.6)
    expect(res.ticks).toBe(Math.ceil((res.score! + 59) / 2));
    // extra ticks after the end are ignored
    const longer = Int8Array.from([...qs, 5, 5, 5]);
    const res2 = simulateReplay(p, longer);
    expect(res2).toEqual(res);
    // by hand
    const run = createRun(p);
    const ev = new SimEvents();
    let st: Status = Status.Ready;
    for (const q of qs) st = stepTick(run, q, ev);
    expect(st).toBe(Status.Success);
    expect(run.s.score).toBe(res.score);
    // the recorder sees every tick once, in order
    const seen: number[] = [];
    simulateReplay(p, qs, { onTick: (t) => seen.push(t) });
    expect(seen).toEqual(Array.from({ length: qs.length }, (_v, i) => i));
    // a one-q difference changes the hash
    const flipped = Int8Array.from(qs);
    flipped[10] = flipped[10]! - 1;
    expect(simulateReplay(p, flipped).stateHash).not.toBe(res.stateHash);
  });

  it('reports Running for a sequence that ends before the run and Ready for an empty one', () => {
    const p = fixedLevel('2-2');
    const r1 = simulateReplay(p, Int8Array.from([10, 10, 10]));
    expect(r1.status).toBe(Status.Running);
    expect(r1.ticks).toBe(3);
    expect(r1.score).toBeNull();
    const r0 = simulateReplay(p, new Int8Array(0));
    expect(r0.status).toBe(Status.Ready);
    expect(r0.ticks).toBe(0);
  });
});
