// Splits (GAME_DESIGN.md §7.6, §5.1 split table). Owner: O3.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LevelDef, LevelsFile } from '../../src/sim/level';
import { comparisonGhost, createSplitTracker, splitDelta } from '../../src/core/splits';

const levels = (JSON.parse(readFileSync(new URL('../../src/data/levels.json', import.meta.url), 'utf8')) as LevelsFile).levels;
const byId = (id: string): LevelDef => levels.find((l) => l.id === id)!;

describe('split tracker', () => {
  it('1-1 has no splits', () => {
    const s = createSplitTracker(byId('1-1'));
    expect(s.onWallCross(0, 1, 100)).toBe(-1);
    expect(s.times()).toEqual([]);
  });

  it('2-2: first forward crossing of wall A only', () => {
    const s = createSplitTracker(byId('2-2'));
    expect(s.onWallCross(1, 1, 200)).toBe(-1); // wall B does not count
    expect(s.onWallCross(0, -1, 210)).toBe(-1); // backwards does not count
    expect(s.onWallCross(0, 1, 231)).toBe(0);
    expect(s.onWallCross(0, 1, 300)).toBe(-1); // only the first time
    expect(s.times()).toEqual([231]);
  });

  it('2-3: backwards over wall A', () => {
    const s = createSplitTracker(byId('2-3'));
    expect(s.onWallCross(0, 1, 50)).toBe(-1);
    expect(s.onWallCross(0, -1, 195)).toBe(0);
  });

  it('4-1: three hurdles in order', () => {
    const s = createSplitTracker(byId('4-1'));
    expect(s.onWallCross(1, 1, 90)).toBe(-1); // cannot skip ahead
    expect(s.onWallCross(0, 1, 100)).toBe(0);
    expect(s.onWallCross(1, 1, 200)).toBe(1);
    expect(s.onWallCross(2, 1, 300)).toBe(2);
    expect(s.times()).toEqual([100, 200, 300]);
  });

  it('truncate (practice rewind) forgets later splits; they are reached again in order', () => {
    const s = createSplitTracker(byId('4-1'));
    s.onWallCross(0, 1, 100);
    s.onWallCross(1, 1, 200);
    s.onWallCross(2, 1, 300);
    s.truncate(250);
    expect(s.times()).toEqual([100, 200, NaN]);
    expect(s.onWallCross(1, 1, 260)).toBe(-1); // already reached before the rewind point
    expect(s.onWallCross(2, 1, 320)).toBe(2);
    s.truncate(50);
    expect(s.times()).toEqual([NaN, NaN, NaN]);
    expect(s.onWallCross(0, 1, 90)).toBe(0);
    s.truncate(90); // a split exactly at the rewind point stays
    expect(s.times()[0]).toBe(90);
  });

  it('5-4: wall A forward, phase 0 (holdStart), wall A backwards - in order', () => {
    const s = createSplitTracker(byId('5-4'));
    expect(s.onWallCross(0, 1, 231)).toBe(0);
    expect(s.onWallCross(0, -1, 250)).toBe(-1); // swung back out before the checkpoint: not the third split
    expect(s.onWallCross(0, 1, 280)).toBe(-1);
    expect(s.onPhaseDone(0, 336)).toBe(1);
    expect(s.onWallCross(0, -1, 591)).toBe(2);
    expect(s.times()).toEqual([231, 336, 591]);
    s.reset();
    expect(s.times().every(Number.isNaN)).toBe(true);
    expect(s.onPhaseDone(0, 10)).toBe(-1);
  });

  it('unreached splits are NaN', () => {
    const s = createSplitTracker(byId('5-2'));
    s.onWallCross(0, 1, 120);
    const t = s.times();
    expect(t[0]).toBe(120);
    expect(Number.isNaN(t[1])).toBe(true);
  });
});

describe('comparison ghost (§7.6)', () => {
  it('is the first non-AI ghost of the set, else the AI', () => {
    expect(comparisonGhost([{ kind: 'ai' }, { kind: 'pb' }])?.kind).toBe('pb');
    expect(comparisonGhost([{ kind: 'ai' }, { kind: 'wr' }, { kind: 'challenge' }])?.kind).toBe('wr');
    expect(comparisonGhost([{ kind: 'ai' }])?.kind).toBe('ai');
    expect(comparisonGhost([{ kind: 'reverse_hint' }])).toBeNull();
    expect(comparisonGhost([])).toBeNull();
  });

  it('delta is player minus ghost; none when the ghost never reached the split', () => {
    expect(splitDelta(200, [231], 0)).toBe(-31);
    expect(splitDelta(280, [231], 0)).toBe(49);
    expect(splitDelta(280, [NaN], 0)).toBeNull();
    expect(splitDelta(280, [], 0)).toBeNull();
  });
});
