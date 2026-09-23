// The UI against the real physics core (O1): fmtLevelText with the real levelFacts, and share texts / cards built
// from a run the real simulator produced (tests/fixtures/bot_1-1_success.json). No mocks. Owner: O7.
import { describe, expect, it } from 'vitest';
import type { LevelDef } from '../../src/sim/level';
import type { ResultsData } from '../../src/ui/ui';
import levelsFile from '../../src/data/levels.json';
import bot from '../fixtures/bot_1-1_success.json';
import { levelFacts, ballClearanceM } from '../../src/sim/display';
import { decodeReplay, simulateReplay } from '../../src/sim/replay';
import { b64urlDecode } from '../../src/sim/b64';
import { Status } from '../../src/sim/run';
import { fmtLevelText, fmtTime, levelHint, levelName, setLang } from '../../src/ui/i18n/format';
import { levelShareText } from '../../src/ui/share';
import { drawShareCard } from '../../src/ui/sharecard';
import { medalThresholds } from '../../src/ui/screens/briefing';

const LEVELS = (levelsFile as unknown as { levels: LevelDef[] }).levels;
const byId = (id: string): LevelDef => LEVELS.find((l) => l.id === id)!;

describe('fmtLevelText with the real levelFacts (§5.3)', () => {
  it('matches the §5.3 examples', () => {
    setLang('ja');
    expect(fmtLevelText(byId('2-2').concept.ja, byId('2-2'))).toBe('0.75mの壁を越えて42cmのすき間でピタッ');
    expect(fmtLevelText('{req0}°', byId('2-1'))).toBe('64°');
    expect(fmtLevelText('{req0}° {beam}°', byId('5-3'))).toBe('73° 89°');
    expect(fmtLevelText('{Fmax}N {period}秒', byId('3-1'))).toBe('6N 2.01秒');
    expect(fmtLevelText('{period}', byId('3-3'))).toBe('1.55');
    // Tmax is tuning data (§5.3 wrote 16 N; R10 raised it): the level's own value as an integer.
    expect(fmtLevelText('{Tmax}', byId('4-3'))).toBe(String(Math.round(byId('4-3').physics.egg!.Tmax)));
    expect(fmtLevelText('{h2}', byId('5-2'))).toBe('0.90');
    expect(fmtLevelText('{req0}/{req1}/{req2}', byId('4-1'))).toBe('38/50/38');
    expect(fmtLevelText('{gap}', byId('2-4'))).toBe(String(Math.round(levelFacts(byId('2-4').physics).gapCm!)));
  });

  it('resolves every placeholder of all 18 levels (names, concepts, three hints) in both languages', () => {
    expect(LEVELS).toHaveLength(18);
    for (const lv of LEVELS) {
      for (const lang of ['ja', 'en'] as const) {
        const texts = [levelName(lv, lang), fmtLevelText(lv.concept[lang] || lv.concept.ja, lv), levelHint(lv, 0, lang), levelHint(lv, 1, lang), levelHint(lv, 2, lang)];
        for (const s of texts) {
          expect(s, `${lv.id} ${lang}`).toBeTruthy();
          expect(s!, `${lv.id} ${lang}: ${s}`).not.toMatch(/\{\w+\}|–|NaN|undefined/);
        }
      }
    }
  });
});

describe('share text and card from a real simulated run', () => {
  const lv = byId('1-1');
  const { qs } = decodeReplay(b64urlDecode(bot.replay));
  const res = simulateReplay(lv.physics, qs);

  it('the bot run succeeds and its time and challenge link go into the §7.13 text', () => {
    expect(res.status).toBe(Status.Success);
    const data: ResultsData = {
      level: lv, ok: true, score: res.score, parSub: 180, pbSub: null, wrSub: null, medal: 1, crown: false, nextMedalSub: 179,
      // 1-1 has no walls: the clearance is +Infinity and the gap part is left out (never "Infinity" / "NaN").
      gapMm: ballClearanceM(res.minD2) * 1000, aiGapMm: NaN, peakF: res.peakF, aiPeakF: NaN,
      badges: [], failReason: null, rank: null, aiBeaten: null, replay: bot.replay, strobe: new Float32Array(0),
    };
    const text = levelShareText(data, 180, 'https://yurapita.example', 'ja');
    expect(text.startsWith(`ゆらしてピタッ 1-1『おつかい』${fmtTime(res.score!)}秒 AI比 `)).toBe(true);
    expect(text).toContain(`#ゆらピタ https://yurapita.example/#c=1-1.${bot.replay}`);
    expect(text).not.toMatch(/NaN|Infinity|すき間/);
    const cv = drawShareCard(data, null);
    expect([cv.width, cv.height]).toEqual([1200, 630]);
  });

  it('medal thresholds shown on the strategy card are the §7.2 integers', () => {
    expect(medalThresholds(324)).toEqual({ bronze: 648, silver: 486, gold: 388, crown: 324 });
    expect(medalThresholds(181)).toEqual({ bronze: 362, silver: 271, gold: 217, crown: 181 });
  });
});
