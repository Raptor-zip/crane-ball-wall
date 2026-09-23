// Medal thresholds, titles, unlock rules, hint timing, crash streak / auto demo (GAME_DESIGN.md §7.2, §7.4, §5.1). Owner: O3.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LevelDef, LevelsFile } from '../../src/sim/level';
import type { LevelProgress } from '../../src/store/save';
import {
  applyOutcome, applySuccess, crownCount, dailyUnlocked, emptyProgress, hintsOpen, levelUnlocked, medalFor,
  medalThresholds, nextLevel, progressHash, reconcileHash, skipAvailable, titleIndex, titleName, TITLES, worldUnlocked,
} from '../../src/core/progress';
import { t } from '../../src/ui/i18n/format';

const levels = (JSON.parse(readFileSync(new URL('../../src/data/levels.json', import.meta.url), 'utf8')) as LevelsFile).levels;
const byId = (id: string): LevelDef => levels.find((l) => l.id === id)!;

function progWith(done: Record<string, 'c' | 's'>): Record<string, LevelProgress> {
  const out: Record<string, LevelProgress> = {};
  for (const [id, k] of Object.entries(done)) {
    const p = emptyProgress('00000000');
    if (k === 'c') p.cleared = true;
    else p.skipped = true;
    out[id] = p;
  }
  return out;
}

describe('medals (§7.2)', () => {
  it('uses floor(2.0P), floor(1.5P), floor(1.2P) and crown < P', () => {
    expect(medalThresholds(180)).toEqual({ bronze: 360, silver: 270, gold: 216, crown: 179 });
    expect(medalThresholds(337)).toEqual({ bronze: 674, silver: 505, gold: 404, crown: 336 });
    const P = 337;
    expect(medalFor(675, P)).toEqual({ medal: 0, crown: false, nextMedalSub: 674 });
    expect(medalFor(674, P)).toEqual({ medal: 1, crown: false, nextMedalSub: 505 });
    expect(medalFor(506, P)).toEqual({ medal: 1, crown: false, nextMedalSub: 505 });
    expect(medalFor(505, P)).toEqual({ medal: 2, crown: false, nextMedalSub: 404 });
    expect(medalFor(405, P)).toEqual({ medal: 2, crown: false, nextMedalSub: 404 });
    expect(medalFor(404, P)).toEqual({ medal: 3, crown: false, nextMedalSub: 336 });
    expect(medalFor(337, P)).toEqual({ medal: 3, crown: false, nextMedalSub: 336 }); // equal to par is not a crown
    expect(medalFor(336, P)).toEqual({ medal: 3, crown: true, nextMedalSub: null });
    expect(medalFor(1, P)).toEqual({ medal: 3, crown: true, nextMedalSub: null });
  });

  it('floor(1.2P) is exact where 1.2 * P would round up or down', () => {
    for (let P = 1; P < 5000; P++) {
      const t = medalThresholds(P);
      expect(t.gold).toBe(Math.floor((12 * P) / 10));
      expect(t.silver).toBe(Math.floor((15 * P) / 10));
      expect(5 * t.gold).toBeLessThanOrEqual(6 * P);
      expect(5 * (t.gold + 1)).toBeGreaterThan(6 * P);
    }
  });

  it('titles by crowns: 0 / 3 / 8 / 13 / 18', () => {
    expect([0, 2, 3, 7, 8, 12, 13, 17, 18].map(titleIndex)).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4]);
  });

  it('title words come from the UI i18n (one source of truth, the level select shows the same words)', () => {
    expect(TITLES.ja).toEqual(['見習い', '玉掛け', '熟練オペレーター', '最適制御ハンター', '人類代表']);
    for (const lang of ['ja', 'en'] as const) {
      for (let i = 0; i < 5; i++) {
        expect(titleName(i, lang)).toBe(t(`select.rank.${i}` as 'select.rank.0', undefined, lang));
      }
    }
    expect(titleName(titleIndex(18), 'en')).toBe(TITLES.en[4]);
    expect(titleName(99, 'ja')).toBe('人類代表');
  });
});

describe('hints (§5.3, §7.4)', () => {
  it('open at 3, 6 and 10 failures', () => {
    expect([0, 2, 3, 5, 6, 9, 10, 99].map(hintsOpen)).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
  });

  it('a retry under 1 s after tick 0 is neither an attempt nor a failure', () => {
    const p = emptyProgress('h');
    for (let i = 0; i < 5; i++) expect(applyOutcome(p, 'retry', 59, true).counted).toBe(false);
    expect(p.attempts).toBe(0);
    expect(p.fails).toBe(0);
    const fx = applyOutcome(p, 'retry', 60, true);
    expect(fx).toMatchObject({ counted: true, failed: true });
    expect([p.attempts, p.fails]).toEqual([1, 1]);
  });

  it('reports the hint level exactly when it opens', () => {
    const p = emptyProgress('h');
    const opened: number[] = [];
    const kinds = ['crash', 'timeout', 'retry', 'retry', 'crash', 'crash', 'crash', 'crash', 'retry', 'crash', 'crash'] as const;
    for (const k of kinds) opened.push(applyOutcome(p, k, 120, false).hintOpened);
    expect(opened).toEqual([0, 0, 1, 0, 0, 2, 0, 0, 0, 3, 0]);
    // false starts never advance the hint clock
    const q = emptyProgress('h');
    applyOutcome(q, 'crash', 100, false);
    applyOutcome(q, 'crash', 100, false);
    for (let i = 0; i < 10; i++) applyOutcome(q, 'retry', 10, false);
    expect(hintsOpen(q.fails)).toBe(0);
    expect(applyOutcome(q, 'timeout', 7200, false).hintOpened).toBe(1);
  });

  it('success counts as an attempt but not a failure', () => {
    const p = emptyProgress('h');
    expect(applyOutcome(p, 'success', 300, true)).toMatchObject({ counted: true, failed: false });
    expect([p.attempts, p.fails]).toEqual([1, 0]);
  });
});

describe('auto demo (§7.4): 3 consecutive crashes, uncleared campaign level, once per level', () => {
  it('is due on the third crash in a row, and only once', () => {
    const p = emptyProgress('h');
    expect(applyOutcome(p, 'crash', 100, true).demoDue).toBe(false);
    expect(applyOutcome(p, 'retry', 10, true).demoDue).toBe(false); // false start: streak untouched
    expect(applyOutcome(p, 'crash', 100, true).demoDue).toBe(false);
    expect(applyOutcome(p, 'crash', 100, true).demoDue).toBe(true);
    p.demoShown = true; // the app sets this when it plays the demo
    expect(applyOutcome(p, 'crash', 100, true).demoDue).toBe(false);
    expect(applyOutcome(p, 'crash', 100, true).demoDue).toBe(false);
  });

  it('a success or a time-up breaks the streak', () => {
    const p = emptyProgress('h');
    applyOutcome(p, 'crash', 100, true);
    applyOutcome(p, 'crash', 100, true);
    applyOutcome(p, 'timeout', 7200, true);
    expect(p.consecutiveCrashes).toBe(0);
    expect(applyOutcome(p, 'crash', 100, true).demoDue).toBe(false);
  });

  it('never after the level is cleared, and never outside the campaign', () => {
    const p = emptyProgress('h');
    p.cleared = true;
    for (let i = 0; i < 5; i++) expect(applyOutcome(p, 'crash', 100, true).demoDue).toBe(false);
    const q = emptyProgress('h');
    for (let i = 0; i < 5; i++) expect(applyOutcome(q, 'crash', 100, false).demoDue).toBe(false);
  });
});

describe('success bookkeeping', () => {
  it('PB, medal, first crown, badges', () => {
    const p = emptyProgress('h');
    let r = applySuccess(p, 440, 300, 'r1', ['ippatsu'], true);
    expect(r).toMatchObject({ pb: false, firstClear: true, firstCrown: false, medalUp: true, newBadges: ['ippatsu'] });
    expect([p.bestSub, p.bestReplay, p.medal]).toEqual([440, 'r1', 2]);
    r = applySuccess(p, 520, 300, 'r2', ['ippatsu'], true);
    expect(r).toMatchObject({ pb: false, firstClear: false, medalUp: false, newBadges: [] });
    expect(p.bestSub).toBe(440);
    r = applySuccess(p, 299, 300, null, ['kamihitoe'], true);
    expect(r).toMatchObject({ pb: true, firstCrown: true, medalUp: true, newBadges: ['kamihitoe'] });
    expect([p.bestSub, p.bestReplay, p.crown, p.medal]).toEqual([299, null, true, 3]);
    r = applySuccess(p, 250, 300, 'r4', [], true);
    expect(r.firstCrown).toBe(false);
  });

  it('assisted / practice runs clear the level but earn no medal and no PB', () => {
    const p = emptyProgress('h');
    const r = applySuccess(p, 100, 300, 'r', [], false);
    expect(r.firstClear).toBe(true);
    expect([p.cleared, p.medal, p.crown, p.bestSub]).toEqual([true, 0, false, null]);
  });

  it('a changed levelHash drops the PB but keeps the medals', () => {
    const p = emptyProgress('aaaa0000');
    applySuccess(p, 200, 300, 'r', [], true);
    expect(reconcileHash(p, 'aaaa0000')).toBe(false);
    expect(reconcileHash(p, 'bbbb1111')).toBe(true);
    expect([p.hash, p.bestSub, p.bestReplay, p.medal, p.crown, p.cleared]).toEqual(['bbbb1111', null, null, 3, true, true]);
  });

  it('a SIM_VERSION bump retires the PB like a physics change; sim 1 keeps the bare hash of existing saves', () => {
    expect(progressHash('aaaa0000', 1)).toBe('aaaa0000');
    expect(progressHash('aaaa0000', 2)).toBe('aaaa0000:s2');
    const p = emptyProgress(progressHash('aaaa0000', 1));
    applySuccess(p, 200, 300, 'r', [], true);
    expect(reconcileHash(p, progressHash('aaaa0000', 1))).toBe(false);
    expect(reconcileHash(p, progressHash('aaaa0000', 2))).toBe(true);
    expect([p.hash, p.bestSub, p.bestReplay, p.medal, p.crown]).toEqual(['aaaa0000:s2', null, null, 3, true]);
  });
});

describe('unlocks (§5.1)', () => {
  it('has 18 campaign levels in 5 worlds of 4/4/3/3/4', () => {
    expect(levels.length).toBe(18);
    expect([1, 2, 3, 4, 5].map((w) => levels.filter((l) => l.world === w).length)).toEqual([4, 4, 3, 3, 4]);
  });

  it('W1 is open, levels open in order', () => {
    const prog = progWith({});
    expect(levelUnlocked(byId('1-1'), levels, prog)).toBe(true);
    expect(levelUnlocked(byId('1-2'), levels, prog)).toBe(false);
    expect(levelUnlocked(byId('1-2'), levels, progWith({ '1-1': 'c' }))).toBe(true);
    expect(levelUnlocked(byId('1-3'), levels, progWith({ '1-1': 'c' }))).toBe(false);
    expect(levelUnlocked(byId('1-3'), levels, progWith({ '1-1': 'c', '1-2': 's' }))).toBe(true); // skip counts
  });

  it('W1->W2 needs 3/4, W3->W4 needs 2/3', () => {
    expect(worldUnlocked(2, levels, progWith({ '1-1': 'c', '1-2': 'c' }))).toBe(false);
    expect(worldUnlocked(2, levels, progWith({ '1-1': 'c', '1-2': 'c', '1-3': 's' }))).toBe(true);
    expect(worldUnlocked(2, levels, progWith({ '1-1': 'c', '1-2': 'c', '1-4': 'c' }))).toBe(true); // any 3 of 4
    const w123 = progWith({ '1-1': 'c', '1-2': 'c', '1-3': 'c', '2-1': 'c', '2-2': 'c', '2-3': 'c', '3-1': 'c' });
    expect(worldUnlocked(3, levels, w123)).toBe(true);
    expect(worldUnlocked(4, levels, w123)).toBe(false);
    expect(worldUnlocked(4, levels, { ...w123, ...progWith({ '3-2': 's' }) })).toBe(true);
    expect(levelUnlocked(byId('2-1'), levels, progWith({ '1-1': 'c', '1-2': 'c', '1-3': 'c' }))).toBe(true);
  });

  it('is chained: clears in a later world (via challenge links) do not open worlds past a locked one', () => {
    const prog = progWith({ '3-1': 'c', '3-2': 'c', '3-3': 'c' });
    expect(worldUnlocked(4, levels, prog)).toBe(false);
  });

  it('skip after 10 attempts on an uncleared level', () => {
    const p = emptyProgress('h');
    p.attempts = 9;
    expect(skipAvailable(p)).toBe(false);
    p.attempts = 10;
    expect(skipAvailable(p)).toBe(true);
    p.cleared = true;
    expect(skipAvailable(p)).toBe(false);
    expect(skipAvailable(undefined)).toBe(false);
  });

  it('daily opens with 1-2; crowns and the next level', () => {
    expect(dailyUnlocked(progWith({ '1-1': 'c' }))).toBe(false);
    expect(dailyUnlocked(progWith({ '1-2': 'c' }))).toBe(true);
    const prog = progWith({ '1-1': 'c', '2-2': 'c' });
    prog['1-1']!.crown = true;
    prog['2-2']!.crown = true;
    expect(crownCount(levels, prog)).toBe(2);
    expect(nextLevel(byId('1-4'), levels)?.id).toBe('2-1');
    expect(nextLevel(byId('5-4'), levels)).toBeNull();
  });
});
