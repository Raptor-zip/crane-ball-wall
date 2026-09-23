// Daily pool gate (GAME_DESIGN.md §6.1 DailyPoolFile, §6.2, §8.2 daily_pool.py, §8.3, §10.7). Owner: O2.
//
// Skipped while src/data/daily_pool.json does not exist yet (tools/daily_pool.py writes it). When present:
// 84 entries, 12 per tier, every entry passes validateLevel, has the §6.2 name (with the lead's D9 hurdles
// modifiers), concept and splits, has an `ai` ghost in daily_ghosts.json whose parSub equals the pool's
// parSub (the Worker reads the pool, the client the ghost), and that ghost passes the same §8.3 checks as
// the campaign ghosts. YP_DAILY_DIR=<dir> runs this gate on another directory.
import { describe, expect, it } from 'vitest';
import { levelHash, validateLevel, type DailyDef, type DailyPoolFile } from '../../src/sim/level';
import {
  analyseGhost, describeGhost, ghostErrors, hasDaily, placeholderNames, readDaily, resolvePlaceholder,
  type DailyGhostsFile,
} from './helpers';

const POOL_SIZE = 84;
const TIERS = 7;
const PER_TIER = POOL_SIZE / TIERS; // 12
const TEMPLATE_NAMES: Record<DailyDef['template'], [string, string]> = {
  hop: ['ひとっとび', 'Hop'], hurdles: ['ハードル', 'Hurdles'], enter: ['いれる', 'Enter'], escape: ['だす', 'Escape'], weak: ['非力', 'Weak'],
};

const CONCEPTS: Record<DailyDef['template'], [string, string]> = {
  hop: ['{h0}mの壁をひとっとび、パッドでピタッ', 'Hop the {h0} m wall, stop dead on the pad'],
  hurdles: ['塀を1つの振りでつないで、パッドでピタッ', 'Link the fences in one swing, stop dead on the pad'],
  enter: ['{h0}mの壁を越えて{gap}cmのすき間でピタッ', 'Over a {h0} m wall, stop dead in a {gap} cm gap'],
  escape: ['すき間から{h0}mの壁を越えて、パッドでピタッ', 'Out of the gap over the {h0} m wall, stop dead on the pad'],
  weak: ['{Fmax}Nでは足りない。こいで{h0}mの壁を越える', '{Fmax} N is not enough. Pump over the {h0} m wall'],
};

/**
 * §6.2 daily name, written independently of tools/daily_pool.py: "<template> × <modifier>[ × <modifier>]",
 * modifiers in this order, at most two: (D9, hurdles only) ダブル / Double for 2 fences, トリプル / Triple for
 * 3; 短い紐 / Short string (L < 0.9); 重い荷 / Heavy (m > 1); 非力 / Weak (Fmax <= 15, not for the weak template);
 * 高い壁 / Tall wall (tallest wall >= 0.70); せまい口 / Narrow (pocket mouth < 0.40, enter / escape);
 * (D9, hurdles only) 低い塀 / Low (every fence < 0.45). None: ふつう / Plain.
 */
function dailyName(d: DailyDef): { ja: string; en: string } {
  const p = d.physics;
  const mods: [string, string][] = [];
  const eps = 1e-9;
  if (d.template === 'hurdles') mods.push(p.walls.length === 2 ? ['ダブル', 'Double'] : ['トリプル', 'Triple']);
  if (p.L < 0.9) mods.push(['短い紐', 'Short string']);
  if (p.m > 1) mods.push(['重い荷', 'Heavy']);
  if (p.Fmax <= 15 && d.template !== 'weak') mods.push(['非力', 'Weak']);
  if (p.walls.length > 0 && Math.max(...p.walls.map((w) => w.h)) >= 0.7 - eps) mods.push(['高い壁', 'Tall wall']);
  if ((d.template === 'enter' || d.template === 'escape') && p.walls[1]!.x0 - p.walls[0]!.x1 < 0.4 - eps) mods.push(['せまい口', 'Narrow']);
  if (d.template === 'hurdles' && p.walls.every((w) => w.h < 0.45 - eps)) mods.push(['低い塀', 'Low']);
  const used = mods.length > 0 ? mods.slice(0, 2) : [['ふつう', 'Plain'] as [string, string]];
  const [ja, en] = TEMPLATE_NAMES[d.template];
  return { ja: [ja, ...used.map((m) => m[0])].join(' × '), en: [en, ...used.map((m) => m[1])].join(' × ') };
}

const present = hasDaily('daily_pool.json');

describe.skipIf(!present)('daily_pool.json', () => {
  const file = present ? readDaily<DailyPoolFile>('daily_pool.json') : { format: 1 as const, pool: [] };
  const pool = file.pool ?? [];
  const ghosts = present && hasDaily('daily_ghosts.json') ? readDaily<DailyGhostsFile>('daily_ghosts.json') : null;

  it('has format 1 and 84 entries, 12 per tier', () => {
    expect(file.format).toBe(1);
    expect(pool).toHaveLength(POOL_SIZE);
    const perTier = new Map<number, number>();
    for (const d of pool) perTier.set(d.tier, (perTier.get(d.tier) ?? 0) + 1);
    expect([...perTier.entries()].sort((a, b) => a[0] - b[0])).toEqual(
      Array.from({ length: TIERS }, (_, i) => [i + 1, PER_TIER]),
    );
  });

  it('is sorted by tier (d sorted, 12 per tier), with ids d:<index>, world 0, order = index', () => {
    pool.forEach((d, i) => {
      expect({ id: d.id, world: d.world, order: d.order }, `pool[${i}]`).toEqual({ id: `d:${i}`, world: 0, order: i });
      if (i > 0) expect(d.tier, `pool[${i}] tier`).toBeGreaterThanOrEqual(pool[i - 1]!.tier);
    });
  });

  it('has distinct physics (distinct daily boards)', () => {
    expect(new Set(pool.map((d) => levelHash(d.physics))).size).toBe(pool.length);
  });

  it('names vary (D9): every hurdles course is named by its fence count', () => {
    const hurdles = pool.filter((d) => d.template === 'hurdles');
    expect(hurdles.length).toBeGreaterThan(0);
    for (const d of hurdles) expect(d.name.en, d.id).toMatch(/^Hurdles × (Double|Triple)( × Low)?$/);
  });

  it('daily_ghosts.json exists, has format 1 and no ghosts for unknown ids', () => {
    expect(ghosts, 'daily_ghosts.json is missing').not.toBeNull();
    expect(ghosts!.format).toBe(1);
    const ids = new Set(pool.map((d) => d.id));
    expect(Object.keys(ghosts!.ghosts).filter((k) => !ids.has(k))).toEqual([]);
  });

  for (const d of pool) {
    describe(d.id, () => {
      it('passes validateLevel and the §6.2 daily rules', () => {
        expect(() => validateLevel(d)).not.toThrow();
        expect(Object.keys(TEMPLATE_NAMES)).toContain(d.template);
        expect([1, 2, 3, 4, 5, 6, 7]).toContain(d.tier);
        expect(Number.isInteger(d.parSub) && d.parSub > 0, `parSub ${d.parSub}`).toBe(true);
        expect(d.cargo).toBe('ball');
        expect(d.hints, 'daily levels have no hints').toBeUndefined();
        // splits: hop / weak / enter [{wall:0,dir:1}], hurdles every wall dir 1, escape [{wall:0,dir:-1}]
        const want = d.template === 'hurdles' ? d.physics.walls.map((_, i) => ({ wall: i, dir: 1 }))
          : d.template === 'escape' ? [{ wall: 0, dir: -1 }] : [{ wall: 0, dir: 1 }];
        expect(d.splits).toEqual(want);
        // name: "<template> × <modifier>[ × <modifier>]" (§6.2 + D9), concept: the template's fixed text
        const [ja, en] = TEMPLATE_NAMES[d.template];
        expect(d.name.ja.startsWith(`${ja} × `), `name.ja ${d.name.ja}`).toBe(true);
        expect(d.name.en.startsWith(`${en} × `), `name.en ${d.name.en}`).toBe(true);
        expect(d.name).toEqual(dailyName(d));
        expect([d.concept.ja, d.concept.en]).toEqual(CONCEPTS[d.template]);
        // concept placeholders resolve, same set in ja and en
        expect(placeholderNames(d.concept.en)).toEqual(placeholderNames(d.concept.ja));
        for (const name of placeholderNames(d.concept.ja)) {
          expect(resolvePlaceholder(name, d), `{${name}} in ${d.concept.ja}`).not.toBeNull();
        }
      });

      it('has an ai ghost with the pool parSub that passes the §8.3 checks', () => {
        const list = ghosts?.ghosts[d.id] ?? [];
        const ai = list.find((g) => g.kind === 'ai');
        expect(ai, `${d.id}: no ai ghost in daily_ghosts.json`).toBeDefined();
        expect(ai!.parSub, `${d.id}: pool parSub vs ghost parSub`).toBe(d.parSub);
        for (const g of list) {
          const c = analyseGhost(d.physics, d.splits, g);
          expect(ghostErrors(d.physics, d.splits, g, c), `${d.id} ${describeGhost(g, c)}`).toEqual([]);
        }
      });
    });
  }
});

// Only registered while the pool is missing, so a generated pool leaves nothing skipped.
if (!present) {
  describe('daily_pool.json (not generated yet)', () => {
    it.skip('daily gate skipped: src/data/daily_pool.json does not exist yet (tools/daily_pool.py)', () => {});
  });
}
