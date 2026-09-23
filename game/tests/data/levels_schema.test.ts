// levels.json schema gate (GAME_DESIGN.md §5.1, §5.3, §6.1, §6.2, §10.7). Owner: O2.
//
// validateLevel on all 18 levels, unique ids, split references, and the §5.3 placeholders: every one
// resolves for its level (via O7's fmtLevelText, cross-checked with a local resolver over O1's levelFacts in
// the §5.3 formats), and ja / en use the same placeholders in every text.
import { describe, expect, it } from 'vitest';
import { validateLevel, type LevelDef, type LevelsFile, type SplitDef } from '../../src/sim/level';
import { fmtLevelText } from '../../src/ui/i18n/format';
import { LEVEL_IDS, placeholderNames, readData, resolvePlaceholder } from './helpers';

const file = readData<LevelsFile>('levels.json');
const levels = file.levels;
const byId = new Map<string, LevelDef>(levels.map((l) => [l.id, l]));

/** Every localised text of a level: [field, ja, en]. */
function textPairs(lv: LevelDef): [string, string, string][] {
  const out: [string, string, string][] = [
    ['name', lv.name.ja, lv.name.en],
    ['concept', lv.concept.ja, lv.concept.en],
  ];
  for (let i = 0; i < 3; i++) out.push([`hints[${i}]`, lv.hints?.ja[i] ?? '', lv.hints?.en[i] ?? '']);
  return out;
}

/** §5.1 split table. */
const SPLITS: Record<string, SplitDef[]> = {
  '1-1': [],
  '2-3': [{ wall: 0, dir: -1 }],
  '4-1': [{ wall: 0, dir: 1 }, { wall: 1, dir: 1 }, { wall: 2, dir: 1 }],
  '5-2': [{ wall: 0, dir: 1 }, { wall: 1, dir: 1 }],
  '5-4': [{ wall: 0, dir: 1 }, { phase: 0 }, { wall: 0, dir: -1 }],
};

describe('levels.json', () => {
  it('has format 1 and the 18 campaign levels of §5.1 in campaign order', () => {
    expect(file.format).toBe(1);
    expect(levels.map((l) => l.id)).toEqual([...LEVEL_IDS]);
  });

  it('has unique ids', () => {
    const ids = levels.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('validateLevel is a real check (rejects broken copies of 2-2)', () => {
    const base = byId.get('2-2')!;
    const broken: [string, (l: LevelDef) => void][] = [
      ['start inside the zone', (l) => { l.physics.startX = 1.63; }],
      ['split to a missing wall', (l) => { l.splits = [{ wall: 5, dir: 1 }]; }],
      ['xGoal outside the zone', (l) => { l.ai.xGoal = [2.5]; }],
      ['wall too tall', (l) => { l.physics.walls[0]!.h = 1.0; }],
      ['no hints on a campaign level', (l) => { delete l.hints; }],
    ];
    for (const [why, mutate] of broken) {
      const copy = structuredClone(base);
      mutate(copy);
      expect(() => validateLevel(copy), why).toThrow();
    }
  });

  for (const lv of levels) {
    describe(lv.id, () => {
      it('passes validateLevel', () => {
        expect(() => validateLevel(lv)).not.toThrow();
      });

      it('world / order match the id', () => {
        const [w, o] = lv.id.split('-').map(Number);
        expect([lv.world, lv.order]).toEqual([w, o]);
      });

      it('splits point at existing walls / phases and follow the §5.1 table', () => {
        const p = lv.physics;
        for (const sp of lv.splits) {
          if ('wall' in sp) {
            expect(sp.wall, JSON.stringify(sp)).toBeLessThan(p.walls.length);
            expect([1, -1]).toContain(sp.dir);
          } else {
            expect(sp.phase, JSON.stringify(sp)).toBeLessThan(p.phases.length);
          }
        }
        expect(lv.splits).toEqual(SPLITS[lv.id] ?? [{ wall: 0, dir: 1 }]);
      });

      it('has ja and en names, concepts and 3 hints', () => {
        for (const [field, ja, en] of textPairs(lv)) {
          expect(ja.trim().length, `${field}.ja`).toBeGreaterThan(0);
          expect(en.trim().length, `${field}.en`).toBeGreaterThan(0);
        }
        expect(lv.hints!.ja).toHaveLength(3);
        expect(lv.hints!.en).toHaveLength(3);
      });

      it('§5.3 placeholders resolve and ja / en use the same ones', () => {
        for (const [field, ja, en] of textPairs(lv)) {
          expect(placeholderNames(en), `${lv.id} ${field}: ja ${JSON.stringify(ja)} vs en ${JSON.stringify(en)}`).toEqual(placeholderNames(ja));
          for (const text of [ja, en]) {
            for (const name of placeholderNames(text)) {
              const want = resolvePlaceholder(name, lv);
              expect(want, `${lv.id} ${field}: {${name}} cannot be resolved for this level`).not.toBeNull();
              expect(fmtLevelText(`{${name}}`, lv), `${lv.id} ${field}: fmtLevelText({${name}})`).toBe(want);
            }
            const shown = fmtLevelText(text, lv);
            expect(shown, `${lv.id} ${field}: unresolved placeholder in ${JSON.stringify(shown)}`).not.toMatch(/\{\w+\}/);
          }
        }
      });

      it('ai block is consistent (seeds, extras, compose, egg)', () => {
        const SEEDS = ['enter_fast', 'enter_pump', 'escape_fast', 'escape_pump'];
        for (const s of [...(lv.ai.seeds ?? []), ...(lv.ai.extras ?? [])]) expect(SEEDS).toContain(s);
        expect(Array.isArray(lv.ai.fallback)).toBe(true);
        // D8: an optional AI wall margin (the §12.1 headroom fix sets 30); the §8.3 gate needs >= 15 mm
        if (lv.ai.marginMm !== undefined) {
          expect(Number.isInteger(lv.ai.marginMm), `${lv.id} ai.marginMm ${lv.ai.marginMm}`).toBe(true);
          expect(lv.ai.marginMm).toBeGreaterThanOrEqual(20);
          expect(lv.ai.marginMm).toBeLessThanOrEqual(50);
        }
        if (lv.ai.compose) {
          const [a, rest, b] = lv.ai.compose;
          const la = byId.get(a);
          const lb = byId.get(b);
          expect(la, `compose part ${a}`).toBeDefined();
          expect(lb, `compose part ${b}`).toBeDefined();
          expect(rest).toBeGreaterThan(0);
          // the composed ghost only makes sense if both parts ran on this level's plant and walls
          for (const part of [la!, lb!]) {
            const { M, m, L, Fmax, walls } = part.physics;
            expect({ M, m, L, Fmax, walls }, `${lv.id} vs ${part.id}`).toEqual({
              M: lv.physics.M, m: lv.physics.m, L: lv.physics.L, Fmax: lv.physics.Fmax, walls: lv.physics.walls,
            });
          }
          expect(la!.physics.startX).toBe(lv.physics.startX);
          expect([la!.physics.phases[0], lb!.physics.phases[0]]).toEqual(lv.physics.phases);
          expect(lb!.physics.startX, `${b} starts where ${a} ends`).toBe(la!.ai.xGoal[0]);
          expect(lv.ai.xGoal).toEqual([la!.ai.xGoal[0], lb!.ai.xGoal[0]]);
        }
        if (lv.cargo === 'egg') {
          expect(lv.physics.egg).toBeDefined();
          if (lv.ai.tensionMax !== undefined) expect(lv.ai.tensionMax).toBeLessThan(lv.physics.egg!.Tmax);
        } else {
          expect(lv.physics.egg).toBeUndefined();
        }
      });
    });
  }

  it('view overrides of §5.1 (4-1 portrait window 3.0 m, 4-2 wide x range [-0.9, 3.3])', () => {
    for (const lv of levels) {
      if (lv.id === '4-1') expect(lv.view).toEqual({ portraitWindow: 3.0 });
      else if (lv.id === '4-2') expect(lv.view).toEqual({ wideX: [-0.9, 3.3] });
      else expect(lv.view, lv.id).toBeUndefined();
    }
  });

  it('5-4 composes 2-2 + 0.5 s + 2-3 and only 4-3 is an egg level', () => {
    expect(byId.get('5-4')!.ai.compose).toEqual(['2-2', 0.5, '2-3']);
    expect(levels.filter((l) => l.cargo === 'egg').map((l) => l.id)).toEqual(['4-3']);
  });
});
