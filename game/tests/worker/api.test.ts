// src/shared/api.ts helpers shared by the client and the Worker. Owner: O9.
import { describe, expect, it } from 'vitest';
import { HIST_BINS, dailyBoardKey, histBin, levelBoardKey, parseBoardKey, pctFromHist } from '../../src/shared/api';
import { isValidSecret, pidhFromSecret } from '../../src/shared/names';
import { b64urlEncode } from '../../src/sim/b64';

const hex = (b: ArrayBuffer): string => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

describe('identity (src/shared/names.ts, as used by the Worker)', () => {
  it('pidh = first 16 hex digits of SHA-256 over the 16 raw secret bytes (checked against crypto.subtle in workerd)', async () => {
    for (let s = 0; s < 40; s++) {
      const bytes = new Uint8Array(16).map((_, i) => (i * 97 + s * 13 + (s >> 2)) & 255);
      const secret = b64urlEncode(bytes);
      expect(isValidSecret(secret)).toBe(true);
      expect(pidhFromSecret(secret)).toBe(hex(await crypto.subtle.digest('SHA-256', bytes)).slice(0, 16));
    }
    expect(isValidSecret('too-short')).toBe(false);
    expect(isValidSecret('AAAAAAAAAAAAAAAAAAAAAB')).toBe(false);   // non-zero padding bits: not canonical
  });
});

describe('ranking keys', () => {
  it('builds and parses level and daily keys', () => {
    expect(levelBoardKey('2-2', '9f3a12bc')).toBe('L:2-2:9f3a12bc:s1');
    expect(dailyBoardKey(23, '1c0e77aa')).toBe('D:00023:1c0e77aa:s1');
    expect(parseBoardKey('L:2-2:9f3a12bc:s1')).toEqual({ kind: 'L', levelId: '2-2', levelHash: '9f3a12bc', sim: 1 });
    expect(parseBoardKey('D:00023:1c0e77aa:s1')).toEqual({ kind: 'D', dayIndex: 23, levelHash: '1c0e77aa', sim: 1 });
    for (const bad of ['', 'L:2-2:9f3a12bc', 'L:2-2:9F3A12BC:s1', 'L:22:9f3a12bc:s1', 'D:23:1c0e77aa:s1', 'L:2-2:9f3a12bc:s0', 'X:2-2:9f3a12bc:s1', 'L:2-2:9f3a12bc:s1:x']) {
      expect(parseBoardKey(bad)).toBeNull();
    }
  });
});

describe('daily histogram', () => {
  it('bins 0.2 s and clamps to the last bin', () => {
    expect([histBin(0), histBin(23), histBin(24), histBin(3575), histBin(3576), histBin(99999)]).toEqual([0, 0, 1, 148, 149, 149]);
  });

  it('pct = 100 (faster + own bin / 2) / cleared', () => {
    const h = new Array<number>(HIST_BINS).fill(0);
    h[10] = 30; h[20] = 40; h[30] = 30;
    expect(pctFromHist(h, 20 * 24, 100)).toBe(50);
    expect(pctFromHist(h, 10 * 24, 100)).toBe(15);
    expect(pctFromHist(h, 30 * 24 + 5, 100)).toBe(85);
    expect(pctFromHist(h, 30 * 24 + 5, 0)).toBeNull();
  });
});
