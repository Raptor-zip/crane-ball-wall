// 今日の5球 (GAME_DESIGN.md §7.5, §7.13): ball consumption, outcomes, rollover, streak, share line. Owner: O3.
import { describe, expect, it } from 'vitest';
import {
  ballOutcome, ballsEmoji, ballsString, ballsUsed, consumeBall, currentStreak, dailyShareText, emptyRack, histBin,
  jstDayOfIndex, markPlayed, rackDay, rackFull, rackIsOn, recordDailyBest, rolloverDaily, settleBall, topPercent, type DailySave,
} from '../../src/core/dailyMode';
import { DAILY_EPOCH, DAY_MS, dayIndexAt, jstDayNumber } from '../../src/shared/daily';

function freshDaily(): DailySave {
  return { dayIndex: -1, balls: [], bestSub: null, bestReplay: null, submitted: 'none', lastSentT120: null, streak: 0, lastPlayedDay: -10 };
}

describe('ball consumption', () => {
  it('fills slots left to right and stops at five', () => {
    let r = emptyRack();
    expect(r).toEqual([null, null, null, null, null]);
    r = consumeBall(r, 'fail');
    r = consumeBall(r, 'ok');
    expect(r).toEqual(['fail', 'ok', null, null, null]);
    for (let i = 0; i < 5; i++) r = consumeBall(r, 'crown');
    expect(r).toEqual(['fail', 'ok', 'crown', 'crown', 'crown']);
    expect(rackFull(r)).toBe(true);
    expect(ballsUsed(r)).toBe(5);
  });

  it('is consumed at tick 0 as a fail and upgraded on success', () => {
    let r = consumeBall(emptyRack(), 'fail');
    expect(ballsUsed(r)).toBe(1);
    r = settleBall(r, 0, 'gold');
    expect(r[0]).toBe('gold');
    r = settleBall(r, 9, 'gold'); // out of range: unchanged
    expect(ballsUsed(r)).toBe(1);
  });

  it('colours: crown < P, green <= floor(1.2P), yellow otherwise, red for failures', () => {
    expect(ballOutcome(null, 400)).toBe('fail');
    expect(ballOutcome(399, 400)).toBe('crown');
    expect(ballOutcome(400, 400)).toBe('gold');
    expect(ballOutcome(480, 400)).toBe('gold');
    expect(ballOutcome(481, 400)).toBe('ok');
  });

  it('serialises for submit and share', () => {
    const r = ['fail', 'fail', 'ok', 'crown', null] as const;
    expect(ballsString(r)).toBe('XXOC-');
    expect(ballsString(['gold'])).toBe('G----');
    expect(ballsEmoji(r)).toBe('\u{1F7E5}\u{1F7E5}\u{1F7E8}\u{1F451}⬜');
    expect(ballsEmoji(['gold'])).toBe('\u{1F7E9}⬜⬜⬜⬜');
  });
});

describe('daily record, rollover and streak', () => {
  it('resets the rack and the record on a new day', () => {
    const d = freshDaily();
    expect(rolloverDaily(d, 10)).toBe(true);
    d.balls = consumeBall(d.balls, 'ok');
    recordDailyBest(d, 500, 'r1');
    d.submitted = 'partial';
    d.lastSentT120 = 500;
    expect(rolloverDaily(d, 10)).toBe(false);
    expect(d.bestSub).toBe(500);
    expect(rolloverDaily(d, 11)).toBe(true);
    expect(d).toMatchObject({ dayIndex: 11, balls: emptyRack(), bestSub: null, bestReplay: null, submitted: 'none', lastSentT120: null });
  });

  it('days before DAILY_EPOCH (all dayIndex 0) are told apart by their JST calendar day', () => {
    const t1 = DAILY_EPOCH - 5 * DAY_MS + 3600_000;
    const t2 = t1 + DAY_MS;
    const [j1, j2] = [jstDayNumber(t1), jstDayNumber(t2)];
    expect([dayIndexAt(t1), dayIndexAt(t2)]).toEqual([0, 0]);
    const d = freshDaily();
    expect(rolloverDaily(d, 0, j1)).toBe(true);
    for (let i = 0; i < 5; i++) d.balls = consumeBall(d.balls, 'fail');
    recordDailyBest(d, 500, 'r1');
    d.submitted = 'final';
    expect(rolloverDaily(d, 0, j1)).toBe(false);
    expect(rackIsOn(d, 0, j2)).toBe(false);
    expect(rolloverDaily(d, 0, j2)).toBe(true);
    expect(d).toMatchObject({ dayIndex: 0, jstDay: j2, balls: emptyRack(), bestSub: null, bestReplay: null, submitted: 'none' });
    // streak on calendar days too
    markPlayed(d, 0, j1);
    markPlayed(d, 0, j2);
    expect(d.streak).toBe(2);
    expect(currentStreak(d, 0, j2 + 1)).toBe(2);
    expect(currentStreak(d, 0, j2 + 2)).toBe(0);
  });

  it('a save without jstDay / lastPlayedJst (older build) reads them from its day indices', () => {
    const d: DailySave = { ...freshDaily(), dayIndex: 10, balls: ['ok', null, null, null, null], bestSub: 700, streak: 3, lastPlayedDay: 10 };
    expect(rackDay(d)).toBe(jstDayOfIndex(10));
    expect(rackIsOn(d, 10)).toBe(true);
    expect(rolloverDaily(d, 10, jstDayOfIndex(10))).toBe(true);   // only records the calendar day
    expect(d).toMatchObject({ jstDay: jstDayOfIndex(10), balls: ['ok', null, null, null, null], bestSub: 700 });
    markPlayed(d, 11);
    expect([d.streak, d.lastPlayedDay, d.lastPlayedJst]).toEqual([4, 11, jstDayOfIndex(11)]);
    expect(rackDay(freshDaily())).toBe(-1);
  });

  it('keeps the best successful ball', () => {
    const d = freshDaily();
    expect(recordDailyBest(d, 600, 'a')).toBe(true);
    expect(recordDailyBest(d, 650, 'b')).toBe(false);
    expect(recordDailyBest(d, 600, 'c')).toBe(false);
    expect(recordDailyBest(d, 590, 'd')).toBe(true);
    expect([d.bestSub, d.bestReplay]).toEqual([590, 'd']);
  });

  it('counts consecutive days', () => {
    const d = freshDaily();
    markPlayed(d, 5);
    expect(d.streak).toBe(1);
    markPlayed(d, 5);
    expect(d.streak).toBe(1);
    markPlayed(d, 6);
    markPlayed(d, 7);
    expect(d.streak).toBe(3);
    expect(currentStreak(d, 7)).toBe(3);
    expect(currentStreak(d, 8)).toBe(3); // today not played yet: still alive
    expect(currentStreak(d, 9)).toBe(0); // a day was missed
    markPlayed(d, 9);
    expect(d.streak).toBe(1);
  });
});

describe('histogram and top %', () => {
  it('bins of 0.2 s, last bin open-ended', () => {
    expect(histBin(0)).toBe(0);
    expect(histBin(23)).toBe(0);
    expect(histBin(24)).toBe(1);
    expect(histBin(3576)).toBe(149);
    expect(histBin(99999)).toBe(149);
  });

  it('top % = (faster + mine / 2) / cleared, at least 1', () => {
    const hist = new Array<number>(150).fill(0);
    hist[10] = 20;
    hist[12] = 40;
    hist[20] = 40;
    expect(topPercent(hist, 100, 12 * 24 + 5)).toBe(40); // (20 + 40/2) / 100
    expect(topPercent(hist, 100, 5)).toBe(1); // nobody faster -> "上位 1%"
    expect(topPercent(hist, 0, 300)).toBeNull();
    expect(topPercent([], 10, 300)).toBeNull();
  });
});

describe('share text (§7.13)', () => {
  it('matches the spec layout in Japanese', () => {
    const text = dailyShareText({
      lang: 'ja', n: 23, balls: ['fail', 'fail', 'ok', 'gold', 'crown'], bestSub: 464, parSub: 354, gapMm: 6.4, pct: 8, streak: 5,
      origin: 'https://yurapita.example',
    });
    expect(text).toBe(
      'ゆらしてピタッ 今日の5球 #23 3.867秒\n'
      + '\u{1F7E5}\u{1F7E5}\u{1F7E8}\u{1F7E9}\u{1F451}\n'
      + 'AI差 +0.92秒｜ギリ 6mm｜上位 8%｜連続 5日\n'
      + '#ゆらピタ https://yurapita.example/#d',
    );
  });

  it('drops the URL without an origin and the rank offline; negative diff uses U+2212', () => {
    const text = dailyShareText({
      lang: 'ja', n: 1, balls: ['crown'], bestSub: 300, parSub: 354, gapMm: null, pct: null, streak: 1, origin: null,
    });
    expect(text.split('\n')).toEqual(['ゆらしてピタッ 今日の5球 #1 2.500秒', '\u{1F451}⬜⬜⬜⬜', 'AI差 −0.45秒｜連続 1日', '#ゆらピタ']);
  });

  it('English, and a day without a clear', () => {
    const text = dailyShareText({
      lang: 'en', n: 3, balls: ['fail', 'fail', 'fail', 'fail', 'fail'], bestSub: null, parSub: 354, gapMm: null, pct: null, streak: 2,
      origin: 'https://y.example',
    });
    expect(text.split('\n')).toEqual([
      'Swing & Stick Daily 5 #3 no clear', '\u{1F7E5}'.repeat(5), 'Streak 2 days', '#ゆらピタ https://y.example/#d',
    ]);
  });
});
