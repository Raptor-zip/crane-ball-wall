// Ghost validity gate (GAME_DESIGN.md §8.3). Owner: O2.
//
// For every ai / calm / research_* ghost of src/data/ghosts/<id>.json: the physics copy is the current one,
// and the decoded samples, linearly interpolated to 120 Hz with v and w from central differences, pass the
// game's own rules (src/sim: collide, detmath, rules, dynamics): ball-wall clearance >= 15 mm, no string /
// wall contact, no beam, trolley on the rail, the success rule holds with parSub / splitSub within ±3
// substeps, the hold fits in the appended second, peakF <= Fmax and (egg) the EOM tension stays below Tmax.
// All 18 levels must have `ai` and `calm` (the mechanical proof that every level is solvable), and
// ghosts_summary.json must agree with the ghosts and have no `<4%` headroom. Daily ghosts: daily_pool.test.ts.
import { describe, expect, it } from 'vitest';
import type { LevelDef, LevelPhysics, LevelsFile } from '../../src/sim/level';
import {
  LEVEL_IDS, analyseGhost, describeGhost, ghostErrors, hasData, readData, refDecodeChannel, refEncodeInts, refQuantize,
  researchKindsOf, type Channel, type GhostCheck, type GhostFile, type GhostJson, type SummaryFile,
} from './helpers';

const levels = readData<LevelsFile>('levels.json').levels;
const summary = readData<SummaryFile>('ghosts_summary.json');
const byId = new Map<string, LevelDef>(levels.map((l) => [l.id, l]));
const files = new Map<string, GhostFile | null>(
  LEVEL_IDS.map((id) => [id, hasData(`ghosts/${id}.json`) ? readData<GhostFile>(`ghosts/${id}.json`) : null]),
);

describe('every campaign level has its ghost file with ai and calm', () => {
  for (const id of LEVEL_IDS) {
    it(`${id}: ghost file, level id, physics copy, kinds`, () => {
      const lv = byId.get(id);
      expect(lv, `level ${id} missing from levels.json`).toBeDefined();
      const file = files.get(id);
      expect(file, `src/data/ghosts/${id}.json missing`).toBeTruthy();
      expect(file!.format).toBe(1);
      expect(file!.levelId).toBe(id);
      // stale-ghost detection: the copy must deep-equal the current physics
      expect(file!.physics, `${id}: ghost physics copy differs from levels.json (stale ghosts)`).toEqual(lv!.physics);
      const kinds = file!.ghosts.map((g) => g.kind);
      expect(new Set(kinds).size, `${id}: duplicate ghost kinds ${kinds.join(',')}`).toBe(kinds.length);
      expect(kinds, `${id}: needs an ai ghost`).toContain('ai');
      expect(kinds, `${id}: needs a calm ghost`).toContain('calm');
      const research = kinds.filter((k) => k.startsWith('research_')).sort();
      expect(research, `${id}: research ghosts vs ai.extras ${JSON.stringify(lv!.ai.extras ?? [])}`).toEqual(researchKindsOf(lv!.ai.extras));
    });
  }
});

describe('§8.3 ghost checks on 120 Hz samples with the game rules', () => {
  for (const id of LEVEL_IDS) {
    const lv = byId.get(id);
    const file = files.get(id);
    if (!lv || !file) continue; // reported above
    for (const g of file.ghosts) {
      it(`${id} ${g.kind}`, () => {
        const c = analyseGhost(lv.physics, lv.splits, g);
        const errors = ghostErrors(lv.physics, lv.splits, g, c);
        expect(errors, `${id} ${describeGhost(g, c)}`).toEqual([]);
      });
    }
  }
});

describe('the ai ghost is the fastest AI ghost of its level', () => {
  for (const id of LEVEL_IDS) {
    const file = files.get(id);
    const ai = file?.ghosts.find((g) => g.kind === 'ai');
    if (!file || !ai) continue;
    it(`${id}: ai parSub ${ai.parSub} <= every other ghost`, () => {
      for (const g of file.ghosts) {
        expect(ai.parSub, `${id}: ${g.kind} (parSub ${g.parSub}) finishes before ai (parSub ${ai.parSub})`).toBeLessThanOrEqual(g.parSub);
      }
    });
  }
});

describe('gate self-test: broken copies of real ghosts are rejected', () => {
  type Mut = { x?: (v: number, k: number) => number; th?: (v: number, k: number) => number; f?: (v: number, k: number) => number; keep?: number };
  /** Re-encodes a ghost with modified channels (reference codec), optionally keeping only the first `keep` samples. */
  function mutate(g: GhostJson, m: Mut): GhostJson {
    const ch = (c: Channel, fn?: (v: number, k: number) => number): string => {
      let vals = Array.from(refDecodeChannel(g[c], c));
      if (m.keep !== undefined) vals = vals.slice(0, m.keep);
      return refEncodeInts(refQuantize(fn ? vals.map(fn) : vals, c));
    };
    return { ...g, n: m.keep ?? g.n, x: ch('x', m.x), th: ch('th', m.th), f: ch('f', m.f) };
  }
  const ghostOf = (id: string, kind = 'ai'): { lv: LevelDef; g: GhostJson } | null => {
    const lv = byId.get(id);
    const g = files.get(id)?.ghosts.find((x) => x.kind === kind);
    return lv && g ? { lv, g } : null;
  };
  const errorsOf = (phys: LevelPhysics, lv: LevelDef, g: GhostJson): string[] => ghostErrors(phys, lv.splits, g, analyseGhost(phys, lv.splits, g));
  // Mutation sizes come from each ghost's own metrics, so the self-test survives the pipeline rewriting the data.
  type Case = [string, string, (lv: LevelDef, g: GhostJson, c: GhostCheck) => string[], RegExp];
  const cases: Case[] = [
    ['walls raised to leave ~5 mm', '2-2', (lv, g, c) => {
      const up = (c.gapMm! - 5) / 1000;
      return errorsOf({ ...lv.physics, walls: lv.physics.walls.map((w) => ({ ...w, h: w.h + up })) }, lv, g);
    }, /clearance/],
    ['wall A 30 cm taller', '2-2', (lv, g) => errorsOf({ ...lv.physics, walls: lv.physics.walls.map((w, i) => ({ ...w, h: i === 0 ? w.h + 0.3 : w.h })) }, lv, g), /string meets wall 0/],
    ['swing scaled to 95 deg', '2-2', (lv, g, c) => errorsOf(lv.physics, lv, mutate(g, { th: (v) => (v * 95) / c.maxThetaDeg })), /beam/],
    ['rail end 5 cm short', '2-2', (lv, g, c) => errorsOf({ ...lv.physics, rail: [lv.physics.rail[0], c.xMax - 0.05] }, lv, g), /leaves the rail/],
    ['zone moved away', '2-2', (lv, g) => errorsOf({ ...lv.physics, phases: [{ kind: 'pocket', xa: 1.42, xb: 1.5 }] }, lv, g), /never holds/],
    ['parSub off by 10', '2-2', (lv, g) => errorsOf(lv.physics, lv, { ...g, parSub: g.parSub + 10 }), /^parSub/],
    ['splitSub off by 10', '4-1', (lv, g) => errorsOf(lv.physics, lv, { ...g, splitSub: g.splitSub.map((s, i) => (i === 1 && s !== null ? s + 10 : s)) }), /splitSub\[1\]/],
    ['appended rest cut short', '2-2', (lv, g) => errorsOf(lv.physics, lv, mutate(g, { keep: g.n - 40 })), /last 1\.0 s/],
    ['force peak 10 % over Fmax', '2-2', (lv, g, c) => errorsOf(lv.physics, lv, mutate(g, { f: (v) => (v * 1.1 * lv.physics.Fmax) / c.peakFDecoded })), /> Fmax/],
    ['egg Tmax below the peak tension', '4-3', (lv, g, c) => errorsOf({ ...lv.physics, egg: { Tmax: c.maxT - 0.3, Jmax: 0.3 } }, lv, g), /egg Tmax/],
    ['starts 5 cm off', '2-2', (lv, g) => errorsOf({ ...lv.physics, startX: lv.physics.startX + 0.05 }, lv, g), /starts at/],
    ['wrong label', '2-2', (lv, g) => errorsOf(lv.physics, lv, { ...g, label: g.label + '?' }), /label/],
  ];

  it('an unmodified re-encoded ghost passes', () => {
    const r = ghostOf('2-2');
    expect(r).not.toBeNull();
    expect(errorsOf(r!.lv.physics, r!.lv, mutate(r!.g, {}))).toEqual([]);
  });
  for (const [why, id, run, want] of cases) {
    it(`${why} (${id})`, () => {
      const r = ghostOf(id);
      expect(r, `${id} ai ghost`).not.toBeNull();
      const errs = run(r!.lv, r!.g, analyseGhost(r!.lv.physics, r!.lv.splits, r!.g));
      expect(errs.some((e) => want.test(e)), `expected ${want} in ${JSON.stringify(errs)}`).toBe(true);
    });
  }
});

describe('ghosts_summary.json', () => {
  it('has format 1 and exactly the 18 campaign levels', () => {
    expect(summary.format).toBe(1);
    expect(Object.keys(summary.levels).sort()).toEqual([...LEVEL_IDS].sort());
  });

  for (const id of LEVEL_IDS) {
    it(`${id}: headroom, gaps and agreement with the ghost file`, () => {
      const s = summary.levels[id];
      const lv = byId.get(id);
      expect(s, `summary entry ${id} missing`).toBeDefined();
      expect(lv).toBeDefined();
      // headroom: null is accepted (quick mode, §11 M2a); '<4%' blocks M2 (§7.2, §8.2 3b)
      expect([null, '>=8%', '4-8%'], `${id}: headroom ${JSON.stringify(s!.headroom)}`).toContain(s!.headroom);
      // minGapMm may be null only for a level without walls
      if (lv!.physics.walls.length > 0) {
        expect(typeof s!.minGapMm, `${id}: summary minGapMm is null on a level with walls`).toBe('number');
        expect(s!.minGapMm!).toBeGreaterThanOrEqual(15);
      } else {
        expect(s!.minGapMm).toBeNull();
      }
      // the margin the level's AI kept: ai.marginMm (D8, the §12.1 fix) or the default 20 mm
      expect(s!.aiMarginMm, `${id}: summary aiMarginMm vs levels.json ai.marginMm`).toBe(lv!.ai.marginMm ?? 20);
      expect(s!.aiTensionMinN).toBeGreaterThan(0);
      expect(Array.isArray(s!.fallbackApplied)).toBe(true);
      // the Worker takes the par from the summary, the client from the ghost: they must be the same run
      const ghosts = files.get(id)?.ghosts ?? [];
      const ai = ghosts.find((g) => g.kind === 'ai');
      const calm = ghosts.find((g) => g.kind === 'calm');
      expect(ai, `${id}: no ai ghost`).toBeDefined();
      expect({ parSub: s!.parSub, planT: s!.planT, peakF: s!.peakF, minGapMm: s!.minGapMm, pumps: s!.pumps }, `${id}: summary vs ai ghost`)
        .toEqual({ parSub: ai!.parSub, planT: ai!.planT, peakF: ai!.peakF, minGapMm: ai!.minGapMm, pumps: ai!.pumps });
      if (calm) expect(s!.calmT, `${id}: summary calmT vs calm ghost planT`).toBe(calm.planT);
      expect(s!.tMin).toBeGreaterThan(0);
    });
  }
});
