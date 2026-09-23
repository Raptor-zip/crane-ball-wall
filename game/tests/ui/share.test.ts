// Share texts (§7.13): exact strings for the level and the daily share, URL fallbacks. Owner: O7.
import { describe, expect, it } from 'vitest';
import type { LevelDef } from '../../src/sim/level';
import type { DailyView, ResultsData } from '../../src/ui/ui';
import levelsFile from '../../src/data/levels.json';
import { dailyShareText, fmtPct, levelShareText, rackSquares, splitUrl, xIntentUrl, SHARE_MAX_CHARS } from '../../src/ui/share';
import { setLang } from '../../src/ui/i18n/format';

const LEVELS = (levelsFile as unknown as { levels: LevelDef[] }).levels;
const lv = (id: string): LevelDef => LEVELS.find((l) => l.id === id)!;

function results(over: Partial<ResultsData> = {}): ResultsData {
  return {
    level: lv('2-2'), ok: true, score: 314, parSub: 324, pbSub: 330, wrSub: null, medal: 3, crown: true, nextMedalSub: null,
    gapMm: 6.2, aiGapMm: 19.8, peakF: 38, aiPeakF: 40, badges: [], failReason: null, rank: null, aiBeaten: null,
    replay: 'WVABAQabc', strobe: new Float32Array(), ...over,
  };
}

function daily(over: Partial<DailyView> = {}): DailyView {
  return {
    dayIndex: 22, n: 23, level: lv('2-2'), balls: ['fail', 'gold', 'crown', 'ok', 'fail'], bestSub: 464, parSub: 354,
    top: null, rank: 480, pct: 8, streak: 5, shareText: '', ...over,
  };
}

describe('level share text', () => {
  it('matches the §7.13 Japanese format with a challenge link', () => {
    setLang('ja');
    expect(levelShareText(results(), 324, 'https://yurapita.example', 'ja')).toBe(
      'ゆらしてピタッ 2-2『原典：いれる』2.617秒 AI比 −0.083秒 最小すき間 6mm（AIは20mm）#ゆらピタ https://yurapita.example/#c=2-2.WVABAQabc',
    );
  });

  it('has an English version', () => {
    expect(levelShareText(results(), 324, 'https://yurapita.example', 'en')).toBe(
      'Swing & Stick 2-2 “The Original: Enter” 2.617 s (vs AI −0.083 s) · closest gap 6 mm (AI 20 mm) #ゆらピタ https://yurapita.example/#c=2-2.WVABAQabc',
    );
  });

  it('falls back to #l= without a replay or above 1,500 characters', () => {
    expect(levelShareText(results({ replay: null }), 324, 'https://o.example', 'ja')).toMatch(/#ゆらピタ https:\/\/o\.example\/#l=2-2$/);
    const long = 'A'.repeat(SHARE_MAX_CHARS);
    const text = levelShareText(results({ replay: long }), 324, 'https://o.example', 'ja');
    expect(text.endsWith('https://o.example/#l=2-2')).toBe(true);
    expect(text.length).toBeLessThanOrEqual(SHARE_MAX_CHARS);
  });

  it('omits the URL without an origin (file:// or embedded single HTML)', () => {
    expect(levelShareText(results(), 324, null, 'ja')).toBe('ゆらしてピタッ 2-2『原典：いれる』2.617秒 AI比 −0.083秒 最小すき間 6mm（AIは20mm）#ゆらピタ');
  });

  it('shows a plus sign when slower than the AI and no gap on a wall-less level', () => {
    expect(levelShareText(results({ level: lv('1-1'), score: 770 }), 180, null, 'ja')).toBe('ゆらしてピタッ 1-1『おつかい』6.417秒 AI比 +4.917秒 #ゆらピタ');
  });

  it('keeps your gap but leaves out the AI bracket when the AI value is unknown', () => {
    expect(levelShareText(results({ aiGapMm: NaN }), 324, null, 'ja')).toBe('ゆらしてピタッ 2-2『原典：いれる』2.617秒 AI比 −0.083秒 最小すき間 6mm #ゆらピタ');
    expect(levelShareText(results({ aiGapMm: NaN }), 324, null, 'en')).toBe('Swing & Stick 2-2 “The Original: Enter” 2.617 s (vs AI −0.083 s) · closest gap 6 mm #ゆらピタ');
  });

  it('resolves placeholders in level names', () => {
    const odd = { ...lv('1-2'), name: { ja: '{h0}mの塀', en: 'The {h0} m fence' } };
    expect(levelShareText(results({ level: odd }), 324, null, 'ja')).toContain('1-2『0.30mの塀』');
  });
});

describe('daily share text', () => {
  it('matches the §7.13 four-line format', () => {
    expect(dailyShareText(daily(), 'https://yurapita.example', 'ja', { gapMm: 6.3 })).toBe(
      'ゆらしてピタッ 今日の5球 #23 3.867秒\n'
      + '\u{1F7E5}\u{1F7E9}\u{1F451}\u{1F7E8}\u{1F7E5}\n'
      + 'AI差 +0.92秒｜ギリ 6mm｜上位 8%｜連続 5日\n'
      + '#ゆらピタ https://yurapita.example/#d',
    );
  });

  it('English', () => {
    expect(dailyShareText(daily({ pct: 9.64 }), null, 'en', { gapMm: 6.3 })).toBe(
      'Swing & Stick Daily 5 #23 3.867 s\n'
      + '\u{1F7E5}\u{1F7E9}\u{1F451}\u{1F7E8}\u{1F7E5}\n'
      + 'vs AI +0.92 s | closest 6 mm | top 9.6% | 5-day streak\n'
      + '#ゆらピタ',
    );
  });

  it('leaves out what is unknown (no clear, offline pct, unused balls)', () => {
    expect(dailyShareText(daily({ bestSub: null, pct: null, balls: ['fail', 'fail', null, null, null], streak: 1 }), 'https://o.example', 'ja')).toBe(
      'ゆらしてピタッ 今日の5球 #23 記録なし\n'
      + '\u{1F7E5}\u{1F7E5}⬜⬜⬜\n'
      + '連続 1日\n'
      + '#ゆらピタ https://o.example/#d',
    );
  });

  it('top n %: one decimal, trailing .0 dropped, "1" below 1 %', () => {
    expect([8, 9.64, 0.3, 12.05, 100].map(fmtPct)).toEqual(['8', '9.6', '1', '12.1', '100']);
  });

  it('rack squares', () => {
    expect(rackSquares(['crown', 'gold', 'ok', 'fail', null])).toBe('\u{1F451}\u{1F7E9}\u{1F7E8}\u{1F7E5}⬜');
    expect(rackSquares([])).toBe('⬜'.repeat(5));
  });
});

describe('share helpers', () => {
  it('splits the trailing URL for navigator.share and builds the X intent', () => {
    expect(splitUrl('abc #ゆらピタ https://o.example/#d')).toEqual({ text: 'abc #ゆらピタ', url: 'https://o.example/#d' });
    expect(splitUrl('abc #ゆらピタ')).toEqual({ text: 'abc #ゆらピタ', url: null });
    expect(xIntentUrl('a b#')).toBe('https://x.com/intent/post?text=a%20b%23');
  });
});
