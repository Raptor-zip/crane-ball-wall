// levelHash agreement between Python and TS (GAME_DESIGN.md §6.1, §8.2 ghosts_summary.json, §10.7). Owner: O2.
//
// ghosts_summary.json carries hash = levelHash(physics) computed by tools/common.py; the Worker and the
// client compute the same value in TS (ranking keys, stale-ghost detection). They must agree for every level.
import { describe, expect, it } from 'vitest';
import { canonicalJson, levelHash, type LevelPhysics, type LevelsFile } from '../../src/sim/level';
import { LEVEL_IDS, hasData, readData, readFixture, type GhostFile, type SummaryFile } from './helpers';

interface HashVector { id: string; physics: LevelPhysics; canonical: string; hash: string }
const vectors = readFixture<{ format: number; vectors: HashVector[] }>('levelhash_vectors.json').vectors;
const levels = readData<LevelsFile>('levels.json').levels;
const summary = readData<SummaryFile>('ghosts_summary.json');

describe('levelhash_vectors.json (Python canonical_json / fnv1a32)', () => {
  it('has vectors', () => {
    expect(vectors.length).toBeGreaterThan(0);
  });
  for (const v of vectors) {
    it(`${v.id}: canonicalJson and levelHash match Python`, () => {
      expect(canonicalJson(v.physics)).toBe(v.canonical);
      expect(levelHash(v.physics)).toBe(v.hash);
      expect(levelHash(v.physics)).toMatch(/^[0-9a-f]{8}$/);
    });
  }
});

describe('ghosts_summary.json hash == levelHash(levels.json physics)', () => {
  it('covers exactly the 18 campaign levels', () => {
    expect(levels.map((l) => l.id)).toEqual([...LEVEL_IDS]);
    expect(Object.keys(summary.levels).sort()).toEqual([...LEVEL_IDS].sort());
  });

  for (const lv of levels) {
    it(`${lv.id}`, () => {
      const s = summary.levels[lv.id];
      expect(s, `summary entry ${lv.id} missing`).toBeDefined();
      expect(s!.hash, `${lv.id}: summary hash is stale (physics changed after the ghosts were made?)`).toBe(levelHash(lv.physics));
    });
  }

  it('every ghost file physics copy hashes to the same value', () => {
    for (const lv of levels) {
      if (!hasData(`ghosts/${lv.id}.json`)) continue; // ghosts_valid.test.ts reports missing files
      const g = readData<GhostFile>(`ghosts/${lv.id}.json`);
      expect(levelHash(g.physics), lv.id).toBe(levelHash(lv.physics));
    }
  });

  it('the 18 levels have 18 distinct hashes (distinct ranking boards)', () => {
    expect(new Set(levels.map((l) => levelHash(l.physics))).size).toBe(levels.length);
  });
});
