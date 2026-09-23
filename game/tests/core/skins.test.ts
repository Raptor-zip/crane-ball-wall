// Skins catalog and unlock rules (skins spec §2, §4, §5.7, §5.9-3). Owner: O3.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LevelDef, LevelsFile } from '../../src/sim/level';
import type { SaveV1 } from '../../src/store/save';
import { BADGE_IDS, defaultLevelProgress, defaultSave, reconcileLevelHashes } from '../../src/store/save';
import { TRICK_IDS } from '../../src/core/badges';
import { markPlayed } from '../../src/core/dailyMode';
import { noteUnlocked } from '../../src/ui/screens/select';
import {
  DEFAULT_SKIN_IDS, SKINS, SKIN_PARTS, eligibleSkins, newlyUnlocked, resolveSelection, ruleProgress, skinDef, skinFacts, skinLook,
} from '../../src/core/skins';
import type { SkinFacts, SkinPart, UnlockRule } from '../../src/core/skins';
import { DEFAULT_LOOK, LOOKS, partLook } from '../../src/render/skinLooks';

const levels = (JSON.parse(readFileSync(new URL('../../src/data/levels.json', import.meta.url), 'utf8')) as LevelsFile).levels;
const campaign = levels.filter((l) => l.world >= 1);
const worldIds = [...new Set(campaign.map((l) => l.world))].sort((a, b) => a - b);

type Edit = Partial<Pick<SaveV1['levels'][string], 'cleared' | 'skipped' | 'attempts' | 'fails' | 'medal' | 'crown' | 'badges'>>;
function saveWith(levelsEdit: Record<string, Edit> = {}, more?: (s: SaveV1) => void): SaveV1 {
  const s = defaultSave('ja');
  for (const [id, e] of Object.entries(levelsEdit)) s.levels[id] = { ...defaultLevelProgress('h'), ...e };
  more?.(s);
  return s;
}
const facts = (s: SaveV1, bestStreak?: number): SkinFacts => skinFacts(s, levels, bestStreak === undefined ? undefined : { bestStreak });
const met = (rule: UnlockRule, s: SaveV1, bestStreak?: number): boolean => ruleProgress(rule, facts(s, bestStreak)).met;
const clearedAll = (ids: readonly string[], e: Edit = {}): Record<string, Edit> => Object.fromEntries(ids.map((id) => [id, { cleared: true, attempts: 1, ...e }]));

describe('catalog integrity (§2.1)', () => {
  it('has 22 unique ids whose looks exist with the same ids', () => {
    const ids = SKINS.map((s) => s.id);
    expect(ids).toHaveLength(22);
    expect(new Set(ids).size).toBe(ids.length);
    const lookIds = SKIN_PARTS.flatMap((p) => Object.keys(LOOKS[p]));
    expect([...lookIds].sort()).toEqual([...ids].sort());
    for (const s of SKINS) {
      expect(s.id.startsWith(`${s.part}.`), s.id).toBe(true);
      expect(LOOKS[s.part][s.id]?.id, s.id).toBe(s.id);
      expect(skinDef(s.id)).toBe(s);
    }
  });

  it('has exactly one always-rule per part, equal to the defaults and to DEFAULT_LOOK', () => {
    for (const p of SKIN_PARTS) {
      const always = SKINS.filter((s) => s.part === p && s.rule.k === 'always');
      expect(always.map((s) => s.id)).toEqual([DEFAULT_SKIN_IDS[p]]);
      expect(DEFAULT_LOOK[p].id).toBe(DEFAULT_SKIN_IDS[p]);
      expect(SKINS.find((s) => s.part === p)!.id, 'the default leads its part').toBe(DEFAULT_SKIN_IDS[p]);
    }
  });

  it('rule targets exist (levels, worlds, badges) and thresholds are positive', () => {
    for (const s of SKINS) {
      const r = s.rule;
      if (r.k === 'level') expect(campaign.some((l) => l.id === r.id), s.id).toBe(true);
      if (r.k === 'world') expect(worldIds, s.id).toContain(r.w);
      if (r.k === 'badge') expect(BADGE_IDS, s.id).toContain(r.id);
      if ('n' in r && typeof r.n === 'number') expect(r.n, s.id).toBeGreaterThan(0);
      if (r.k === 'notes') expect(r.n).toBeLessThanOrEqual(worldIds.length);
      if (r.k === 'tricks' && typeof r.n === 'number') expect(r.n).toBeLessThanOrEqual(TRICK_IDS.length);
    }
  });

  it('groups sets as designed: one item per part in every themed set, two balls in bonus', () => {
    const bySet = new Map<string, SkinPart[]>();
    for (const s of SKINS) bySet.set(s.set, [...(bySet.get(s.set) ?? []), s.part]);
    for (const set of ['original', 'lab', 'site', 'textbook', 'tancho']) expect([...bySet.get(set)!].sort(), set).toEqual(['ball', 'crane', 'stage', 'trail']);
    expect(bySet.get('bonus')).toEqual(['ball', 'ball']);
    // Screen order: parts are contiguous.
    const parts = SKINS.map((s) => s.part);
    expect(parts).toEqual([...parts].sort((a, b) => SKIN_PARTS.indexOf(a) - SKIN_PARTS.indexOf(b)));
  });
});

describe('rules at their boundaries (§4)', () => {
  it('fails 49 vs 50, attempts 299 vs 300', () => {
    const r1: UnlockRule = { k: 'fails', n: 50 };
    expect(met(r1, saveWith({ '1-1': { fails: 30 }, '1-2': { fails: 19 } }))).toBe(false);
    expect(met(r1, saveWith({ '1-1': { fails: 30 }, '1-2': { fails: 20 } }))).toBe(true);
    const r2: UnlockRule = { k: 'attempts', n: 300 };
    expect(met(r2, saveWith({ '2-1': { attempts: 299 } }))).toBe(false);
    expect(met(r2, saveWith({ '2-1': { attempts: 299 }, '5-4': { attempts: 1 } }))).toBe(true);
  });

  it('crowns 17 vs 18 with all', () => {
    const r: UnlockRule = { k: 'crowns', n: 'all' };
    const ids = campaign.map((l) => l.id);
    expect(ids).toHaveLength(18);
    expect(met(r, saveWith(clearedAll(ids.slice(0, 17), { crown: true, medal: 3 })))).toBe(false);
    expect(met(r, saveWith(clearedAll(ids, { crown: true, medal: 3 })))).toBe(true);
    expect(ruleProgress(r, facts(saveWith(clearedAll(ids.slice(0, 17), { crown: true })))).need).toBe(18);
  });

  it('a skipped level counts for none of clears, world, level or notes', () => {
    const w1 = campaign.filter((l) => l.world === 1).map((l) => l.id);
    const edits = clearedAll(w1);
    edits[w1[3]!] = { skipped: true, cleared: false, attempts: 12 };
    edits['2-2'] = { skipped: true, cleared: false, attempts: 10 };
    const s = saveWith(edits);
    const f = facts(s);
    expect(f.clears).toBe(3);
    expect(ruleProgress({ k: 'world', w: 1 }, f)).toEqual({ have: 3, need: 4, met: false });
    expect(ruleProgress({ k: 'level', id: '2-2' }, f).met).toBe(false);
    expect(ruleProgress({ k: 'notes', n: 1 }, f).met).toBe(false);
    expect(ruleProgress({ k: 'clears', n: 'all' }, f)).toEqual({ have: 3, need: 18, met: false });
  });

  it('golds: 5 levels with medal 3 or a crown (a crown implies gold)', () => {
    const r: UnlockRule = { k: 'golds', n: 5 };
    const four = { '1-1': { medal: 3 as const }, '1-2': { medal: 3 as const }, '1-3': { medal: 3 as const }, '1-4': { medal: 2 as const, crown: true } };
    expect(met(r, saveWith(four))).toBe(false);
    expect(met(r, saveWith({ ...four, '2-1': { medal: 2 as const } }))).toBe(false);
    expect(met(r, saveWith({ ...four, '2-1': { medal: 3 as const } }))).toBe(true);
  });

  it('tricks: only TRICK_IDS count, 3 and all', () => {
    const s = (tricks: string[]): SaveV1 => saveWith({}, (d) => { d.seen.tricks = tricks; });
    expect(met({ k: 'tricks', n: 3 }, s(['brakeFling', 'snap', 'bogus', 'nope']))).toBe(false);
    expect(met({ k: 'tricks', n: 3 }, s(['brakeFling', 'snap', 'windUp']))).toBe(true);
    expect(met({ k: 'tricks', n: 'all' }, s([...TRICK_IDS.slice(0, 5), 'x']))).toBe(false);
    expect(met({ k: 'tricks', n: 'all' }, s([...TRICK_IDS]))).toBe(true);
    expect(ruleProgress({ k: 'tricks', n: 'all' }, facts(s(['snap']))).need).toBe(6);
  });

  it('badges only from campaign levels (a daily key never counts)', () => {
    const r: UnlockRule = { k: 'badge', id: 'hashidon' };
    expect(met(r, saveWith({ 'd:16': { badges: ['hashidon'] } }))).toBe(false);
    expect(met(r, saveWith({ 'zz-9': { badges: ['hashidon'], cleared: true, fails: 99 } }))).toBe(false);
    expect(met(r, saveWith({ '4-2': { badges: ['hashidon'] } }))).toBe(true);
    // Save keys that are not campaign levels add nothing anywhere.
    const f = facts(saveWith({ 'd:16': { cleared: true, attempts: 400, fails: 400, medal: 3, crown: true } }));
    expect([f.clears, f.attempts, f.fails, f.golds, f.crowns]).toEqual([0, 0, 0, 0, 0]);
  });

  it('streak: max(daily.streak, bestStreak)', () => {
    const s = saveWith({}, (d) => { d.daily.streak = 2; });
    expect(met({ k: 'streak', n: 3 }, s)).toBe(false);
    expect(met({ k: 'streak', n: 3 }, s, 3)).toBe(true);
    const s7 = saveWith({}, (d) => { d.daily.streak = 7; });
    expect(met({ k: 'streak', n: 7 }, s7)).toBe(true);
  });

  it('world equals the select screen noteUnlocked over randomised saves', () => {
    let seed = 12345;
    const rnd = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let trial = 0; trial < 300; trial++) {
      const edits: Record<string, Edit> = {};
      const p = rnd();
      for (const l of campaign) {
        const x = rnd();
        if (x < p) edits[l.id] = { cleared: true };
        else if (x < p + 0.1) edits[l.id] = { skipped: true };
      }
      const s = saveWith(edits);
      const f = facts(s);
      for (const w of worldIds) {
        expect(ruleProgress({ k: 'world', w }, f).met, `trial ${trial} world ${w}`).toBe(noteUnlocked(levels, s, w));
      }
      expect(f.worldsDone.size).toBe(worldIds.filter((w) => noteUnlocked(levels, s, w)).length);
    }
  });
});

describe('what players unlock (§2.4, §4)', () => {
  it('existing-player fixture: W1-W3 cleared, 2 crowns, 4 tricks, 60 fails', () => {
    const ids = campaign.filter((l) => l.world <= 3).map((l) => l.id);
    const edits = clearedAll(ids, { medal: 2, attempts: 4, fails: 0 });
    edits['1-1'] = { ...edits['1-1'], crown: true, medal: 3 };
    edits['2-2'] = { ...edits['2-2'], crown: true, medal: 3 };
    edits['3-1'] = { ...edits['3-1'], fails: 60, attempts: 70 };
    const s = saveWith(edits, (d) => { d.seen.tricks = ['brakeFling', 'snap', 'windUp', 'chaseDamp']; d.daily.streak = 1; });
    expect(eligibleSkins(facts(s))).toEqual([
      'ball.red', 'ball.steel', 'ball.wrecker', 'ball.point', 'crane.yellow', 'crane.wood',
      'trail.ink', 'trail.pencil', 'trail.kumihimo', 'stage.note', 'stage.diazo',
    ]);
  });

  it('a fresh save has only the defaults; a finished campaign has everything but the streak items', () => {
    expect(eligibleSkins(facts(defaultSave('ja')))).toEqual(Object.values(DEFAULT_SKIN_IDS));
    const all = clearedAll(campaign.map((l) => l.id), { crown: true, medal: 3, fails: 20, attempts: 20, badges: [...BADGE_IDS] });
    const s = saveWith(all, (d) => { d.seen.tricks = [...TRICK_IDS]; });
    const got = eligibleSkins(facts(s));
    expect(SKINS.filter((x) => !got.includes(x.id)).map((x) => x.id)).toEqual(['ball.moss', 'crane.primer']);
    expect(eligibleSkins(facts(s, 7))).toHaveLength(22);
  });

  it('streak: 7 then a missed day resets to 1; moss stays only with the stored bestStreak (PART B)', () => {
    const s = saveWith({}, (d) => {
      for (let day = 100; day < 107; day++) markPlayed(d.daily, day - 100, day);
    });
    expect(s.daily.streak).toBe(7);
    expect(eligibleSkins(facts(s))).toContain('ball.moss');
    markPlayed(s.daily, 9, 109); // a gap of one day
    expect(s.daily.streak).toBe(1);
    expect(eligibleSkins(facts(s))).not.toContain('ball.moss');
    expect(eligibleSkins(facts(s, 7))).toContain('ball.moss');
    expect(eligibleSkins(facts(s, 7))).toContain('crane.primer');
  });

  it('reconcileLevelHashes with changed hashes re-locks nothing', () => {
    const all = clearedAll(campaign.map((l) => l.id), { crown: true, medal: 3, fails: 30, attempts: 40, badges: ['hashidon', 'yasashisa'] });
    const s = saveWith(all, (d) => { d.seen.tricks = [...TRICK_IDS]; d.daily.streak = 7; });
    const before = eligibleSkins(facts(s));
    const hashes = Object.fromEntries(campaign.map((l) => [l.id, 'ffffffff']));
    expect(reconcileLevelHashes(s, hashes)).toBe(true);
    expect(eligibleSkins(facts(s))).toEqual(before);
    expect(before).toHaveLength(22);
  });

  it('newlyUnlocked is idempotent, skips defaults and owned ids, and keeps catalog order', () => {
    const s = saveWith({ ...clearedAll(['1-1', '1-2', '1-3', '1-4', '2-1', '2-2']), '2-3': { fails: 55 } });
    const f = facts(s);
    const first = newlyUnlocked(f, []);
    expect(first).toEqual(['ball.steel', 'ball.wrecker', 'trail.pencil', 'stage.diazo']);
    expect(newlyUnlocked(f, first)).toEqual([]);
    expect(newlyUnlocked(f, first)).toEqual([]);
    expect(newlyUnlocked(f, ['trail.pencil', 'crane.tancho'])).toEqual(['ball.steel', 'ball.wrecker', 'stage.diazo']);
  });
});

describe('selection and looks (§5.7)', () => {
  const owned = new Set(['ball.steel', 'crane.wood', 'stage.castle']);
  it('falls back to the default per part for garbage, unknown, wrong-part and locked ids', () => {
    expect(resolveSelection(undefined, owned)).toEqual(DEFAULT_SKIN_IDS);
    for (const junk of [null, 7, 'ball.steel', [], ['ball.steel'], true] as unknown[]) {
      expect(resolveSelection(junk as never, owned)).toEqual(DEFAULT_SKIN_IDS);
    }
    expect(resolveSelection({ ball: 'ball.steel', crane: 'crane.wood', trail: 'trail.ink', stage: 'stage.castle' }, owned))
      .toEqual({ ball: 'ball.steel', crane: 'crane.wood', trail: 'trail.ink', stage: 'stage.castle' });
    expect(resolveSelection({ ball: 'crane.wood', crane: 'ball.steel' }, owned)).toEqual(DEFAULT_SKIN_IDS); // wrong part
    expect(resolveSelection({ ball: 'ball.lapis', trail: 'trail.proof' }, owned)).toEqual(DEFAULT_SKIN_IDS); // locked
    expect(resolveSelection({ ball: 'ball.nope', stage: 42 as never, crane: '' }, owned)).toEqual(DEFAULT_SKIN_IDS);
    expect(resolveSelection({ ball: 'ball.red' }, new Set())).toEqual(DEFAULT_SKIN_IDS);
    expect(resolveSelection({ ball: '__proto__', crane: 'constructor' }, owned)).toEqual(DEFAULT_SKIN_IDS);
  });

  it('skinLook maps ids to looks, unknown ids to the defaults', () => {
    expect(skinLook({ ...DEFAULT_SKIN_IDS })).toEqual(DEFAULT_LOOK);
    const l = skinLook({ ball: 'ball.lapis', crane: 'crane.tancho', trail: 'trail.kumihimo', stage: 'stage.castle' });
    expect([l.ball.id, l.crane.id, l.trail.id, l.stage.id]).toEqual(['ball.lapis', 'crane.tancho', 'trail.kumihimo', 'stage.castle']);
    expect(skinLook({ ball: 'nope', crane: 'ball.red', trail: 'toString', stage: 'stage.site' }).stage.id).toBe('stage.site');
    expect(partLook('ball', 'crane.wood')).toBe(DEFAULT_LOOK.ball);
    expect(partLook('crane', 'hasOwnProperty')).toBe(DEFAULT_LOOK.crane);
  });

  it('ruleProgress feeds the {have}/{need} texts', () => {
    const edits = clearedAll(['1-1', '1-3'], { attempts: 20, fails: 7 });
    edits['2-2'] = { crown: true, cleared: true, medal: 3, attempts: 3 };
    const s = saveWith(edits, (d) => { d.seen.tricks = ['snap', 'windUp']; d.daily.streak = 2; });
    const f = facts(s);
    const prog = (id: string): [number, number, boolean] => {
      const p = ruleProgress(skinDef(id)!.rule, f);
      return [p.have, p.need, p.met];
    };
    expect(prog('ball.steel')).toEqual([2, 4, false]);     // ワールド1を全面クリア（2/4面）
    expect(prog('ball.wrecker')).toEqual([14, 50, false]); // しくじり 50回（14/50）
    expect(prog('ball.point')).toEqual([0, 3, false]);
    expect(prog('ball.moss')).toEqual([2, 7, false]);      // いま2日
    expect(prog('ball.kinobi')).toEqual([1, 5, false]);
    expect(prog('ball.lapis')).toEqual([1, 18, false]);
    expect(prog('crane.wood')).toEqual([2, 3, false]);
    expect(prog('crane.lineart')).toEqual([0, 1, false]);
    expect(prog('trail.pencil')).toEqual([3, 1, true]);
    expect(prog('trail.kumihimo')).toEqual([1, 1, true]);
    expect(prog('stage.diazo')).toEqual([1, 1, true]);
    expect(prog('stage.site')).toEqual([43, 300, false]);
    expect(prog('stage.textbook')).toEqual([3, 18, false]);
    expect(prog('ball.red')).toEqual([1, 1, true]);
  });
});
