// fmtLevelText (§5.3 placeholders) and the number formats used across the UI. Owner: O7.
// levelFacts (O1) is replaced by a small fake with the §5.3 definitions so this test does not depend on sim progress.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { LevelDef, LevelPhysics } from '../../src/sim/level';
import levelsFile from '../../src/data/levels.json';

vi.mock('../../src/sim/display', () => ({
  ballClearanceM: (d2: number) => Math.sqrt(d2) - 0.06,
  levelFacts: (p: LevelPhysics) => {
    const deg = (c: number) => (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
    const pocket = p.phases.find((z) => z.kind === 'pocket');
    return {
      wallH: p.walls.map((w) => w.h),
      reqDeg: p.walls.map((w) => deg((1.25 - w.h - 0.06) / p.L)),
      beamDeg: deg(0.01 / p.L),
      gapCm: pocket ? (pocket.xb - pocket.xa) * 100 : null,
      periodS: 2 * Math.PI * Math.sqrt(p.L / 9.81),
    };
  },
}));

const { fmtLevelText, fmtTime, fmtDelta, fmtGap, fmtMm, failReasonText, nearTier, levelName, levelHint, setLang, t } = await import('../../src/ui/i18n/format');

const LEVELS = (levelsFile as unknown as { levels: LevelDef[] }).levels;
const byId = (id: string): LevelDef => LEVELS.find((l) => l.id === id)!;

describe('fmtLevelText', () => {
  beforeAll(() => setLang('ja'));

  it('fills wall heights, required angles, gap, beam, Fmax, Tmax and period (§5.3 examples)', () => {
    expect(fmtLevelText(byId('2-2').concept.ja, byId('2-2'))).toBe('0.75mの壁を越えて42cmのすき間でピタッ');
    expect(fmtLevelText(byId('2-2').concept.en, byId('2-2'))).toBe('Over a 0.75 m wall, stop dead in a 42 cm gap');
    expect(fmtLevelText('{req0}°必要。角度の弧が緑になるまで溜める', byId('2-1'))).toBe('64°必要。角度の弧が緑になるまで溜める');
    expect(fmtLevelText('{req0}°必要で、{beam}°でレールに激突', byId('5-3'))).toBe('73°必要で、89°でレールに激突');
    expect(fmtLevelText('{Fmax}Nでは一気に振り上げられない。リズムは約{period}秒', byId('3-1'))).toBe('6Nでは一気に振り上げられない。リズムは約2.01秒');
    expect(fmtLevelText('紐が短いとリズムが速い（約{period}秒）', byId('3-3'))).toBe('紐が短いとリズムが速い（約1.55秒）');
    // Tmax is tuning data (§5.3 wrote 16 N; R10 raised it): an integer from the level itself.
    expect(fmtLevelText('張力{Tmax}Nで割れる', byId('4-3'))).toBe(`張力${Math.round(byId('4-3').physics.egg!.Tmax)}Nで割れる`);
    expect(Number.isInteger(Number(fmtLevelText('{Tmax}', byId('4-3'))))).toBe(true);
    expect(fmtLevelText('奥の壁は{h2}m', byId('5-2'))).toBe('奥の壁は0.90m');
    expect(fmtLevelText('{req0}/{req1}/{req2}', byId('4-1'))).toBe('38/50/38');
  });

  it('leaves text without placeholders untouched and unknown names as they are', () => {
    expect(fmtLevelText('いれて、止めて、だして、止める', byId('5-4'))).toBe('いれて、止めて、だして、止める');
    expect(fmtLevelText('{foo} {h0}', byId('1-2'))).toBe('{foo} 0.30');
  });

  it('shows a dash for a placeholder the level cannot fill', () => {
    expect(fmtLevelText('{gap}cm {Tmax}N {h3}', byId('1-2'))).toBe('–cm –N –');
  });

  it('resolves every name, concept and hint of the 18 levels in both languages', () => {
    expect(LEVELS).toHaveLength(18);
    for (const lv of LEVELS) {
      const texts = [lv.name.ja, lv.name.en, lv.concept.ja, lv.concept.en, ...(lv.hints?.ja ?? []), ...(lv.hints?.en ?? [])];
      for (const s of texts) {
        const out = fmtLevelText(s, lv);
        expect(out, `${lv.id}: ${s}`).not.toMatch(/\{\w+\}/);
        expect(out, `${lv.id}: ${s}`).not.toContain('–');
      }
    }
  });

  it('levelName / levelHint pick the language and fall back to Japanese', () => {
    const lv = byId('2-2');
    expect(levelName(lv, 'ja')).toBe('原典：いれる');
    expect(levelName(lv, 'en')).toBe('The Original: Enter');
    const noEn = { ...lv, name: { ja: '原典：いれる', en: '' }, hints: { ja: lv.hints!.ja, en: ['', '', ''] as [string, string, string] } };
    expect(levelName(noEn, 'en')).toBe('原典：いれる');
    expect(levelHint(noEn, 0, 'en')).toBe(lv.hints!.ja[0]);
  });
});

describe('number formats', () => {
  it('clock: 2 decimals floor while running, 3 decimals when final', () => {
    expect(fmtTime(0)).toBe('0.000');
    expect(fmtTime(314)).toBe('2.617');
    expect(fmtTime(314, 2)).toBe('2.61');
    expect(fmtTime(119, 2)).toBe('0.99');
    expect(fmtTime(120, 2)).toBe('1.00');
  });

  it('deltas use a real minus sign', () => {
    expect(fmtDelta(-10)).toBe('−0.083');
    expect(fmtDelta(49)).toBe('+0.408');
    expect(fmtDelta(0)).toBe('±0.000');
    expect(fmtDelta(-28, 2)).toBe('−0.23');
  });

  it('gap gauge switches from cm to mm under 1 cm', () => {
    setLang('ja');
    expect(fmtGap(34)).toBe('3.4cm');
    expect(fmtGap(7.4)).toBe('7mm');
    setLang('en');
    expect(fmtGap(34)).toBe('3.4 cm');
    expect(fmtMm(-3)).toBe('0');
    setLang('ja');
  });

  it('failure causes (§9.4 examples)', () => {
    expect(failReasonText('swing', 5.2, 3, 'ja')).toBe('揺れ 5.2° → 3°未満で成功');
    expect(failReasonText('speed', 0.12, 3, 'ja')).toBe('台車の速さ 0.12 m/s → 0.05 未満');
    expect(failReasonText('zone', 0, 3, 'ja')).toBe('ボールがゾーンの外');
    expect(failReasonText('swing', 3.1, 2.5, 'en')).toBe('Swing 3.1° → under 2.5° to stick');
  });

  it('never prints NaN / Infinity for unknown values', () => {
    expect([fmtTime(NaN), fmtTime(Infinity, 2), fmtDelta(NaN), fmtMm(NaN), fmtMm(Infinity), fmtGap(NaN)]).toEqual(['–', '–', '–', '–', '–', '–']);
    expect(failReasonText('swing', NaN, 3, 'ja')).toBe('揺れ –° → 3°未満で成功');
    expect(failReasonText('speed', -0.12, 3, 'ja')).toBe('台車の速さ 0.12 m/s → 0.05 未満');
  });

  it('near-miss tiers (§9.5)', () => {
    expect([45, 39, 19, 9, 4, 1].map(nearTier)).toEqual([null, 'near', 'close', 'razor', 'paper', 'god']);
  });

  it('t() fills slots and leaves unknown ones', () => {
    expect(t('select.nextRank', { n: 2 }, 'ja')).toBe('次の称号まで 王冠あと2個');
    expect(t('results.rank', {}, 'en')).toBe('World #{n}');
  });
});
