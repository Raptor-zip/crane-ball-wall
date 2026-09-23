// Share card size (§7.13, §10.7): always 1200x630. Pixel output is checked in tests/e2e/ui-screens.spec.ts. Owner: O7.
import { describe, expect, it } from 'vitest';
import type { LevelDef } from '../../src/sim/level';
import levelsFile from '../../src/data/levels.json';
import { SHARE_CARD_H, SHARE_CARD_W, drawShareCard } from '../../src/ui/sharecard';

const lv = (levelsFile as unknown as { levels: LevelDef[] }).levels.find((l) => l.id === '2-2')!;

describe('drawShareCard', () => {
  it('returns a 1200x630 canvas', () => {
    const strobe = new Float32Array([0, 0.25, 0.5, 0.3, 1.2, 0.9, 1.63, 0.25]);
    const cv = drawShareCard({
      level: lv, ok: true, score: 314, parSub: 324, pbSub: null, wrSub: null, medal: 3, crown: true, nextMedalSub: null,
      gapMm: 6, aiGapMm: 20, peakF: 38, aiPeakF: 40, badges: [], failReason: null, rank: null, aiBeaten: null, replay: null, strobe,
    }, new Float32Array([0, 0.25, 1.63, 0.25]));
    expect(SHARE_CARD_W).toBe(1200);
    expect(SHARE_CARD_H).toBe(630);
    expect(cv.width).toBe(1200);
    expect(cv.height).toBe(630);
  });
});
