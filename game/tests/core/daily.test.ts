// Daily selection (GAME_DESIGN.md §7.5): JST dayIndex, weekday tier, perm12, xmur3 / mulberry32. Owner: O3.
// Expected values come from an independent Python port (bit arithmetic on unsigned ints) and Python's datetime.
import { describe, expect, it } from 'vitest';
import type { DailyDef } from '../../src/sim/level';
import {
  DAILY_EPOCH, DAILY_GRACE_MS, DAY_MS, dailyDayOpen, dayIndexAt, dayStartMs, jstDateString, jstDayNumber, jstDayStartMs,
  jstTimeOfDay, jstWeekday, mulberry32, perm12, pickDaily, xmur3,
} from '../../src/shared/daily';

/** 84 fake entries whose tiers are interleaved (tier = i % 7 + 1), to check "file order inside a tier". */
function fakePool(): DailyDef[] {
  return Array.from({ length: 84 }, (_, i) => ({ id: `d:${i}`, world: 0, tier: ((i % 7) + 1) as DailyDef['tier'] }) as DailyDef);
}

describe('xmur3 / mulberry32 (public definitions)', () => {
  it('xmur3 fixed outputs', () => {
    const g = xmur3('abc');
    expect([g(), g(), g()]).toEqual([1792905582, 3065002282, 2336214789]);
    expect(xmur3('yurapita-daily-v1')()).toBe(248249658);
  });

  it('mulberry32 fixed outputs', () => {
    const r0 = mulberry32(0);
    expect([r0(), r0(), r0()]).toEqual([0.26642920868471265, 0.0003297457005828619, 0.2232720274478197]);
    const r = mulberry32(248249658);
    expect([r(), r(), r(), r(), r()]).toEqual([
      0.1317854847293347, 0.798216993920505, 0.21539807925000787, 0.42352242465130985, 0.9344207304529846,
    ]);
  });

  it('perm12 is the fixed permutation', () => {
    expect(perm12()).toEqual([4, 5, 6, 9, 0, 10, 11, 7, 3, 2, 8, 1]);
    expect([...perm12()].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const p = perm12();
    p[0] = 99; // callers get a copy
    expect(perm12()[0]).toBe(4);
  });
});

describe('JST day arithmetic', () => {
  it('DAILY_EPOCH is 2026-09-23 00:00 JST (the launch day)', () => {
    expect(new Date(DAILY_EPOCH).toISOString()).toBe('2026-09-22T15:00:00.000Z');
    expect(dayStartMs(0)).toBe(DAILY_EPOCH);
    expect(dayStartMs(100)).toBe(Date.parse('2027-01-01T00:00:00+09:00'));
  });

  // [instant, dayIndex, weekday (Mon = 0), JST date]
  const vectors: [string, number, number, string][] = [
    ['2025-01-01T00:00:00+09:00', 0, 2, '2025-01-01'], // long before the epoch -> #1
    ['2026-09-22T12:00:00+09:00', 0, 1, '2026-09-22'], // before the epoch (development)
    ['2026-09-22T23:59:59+09:00', 0, 1, '2026-09-22'], // last second before the epoch
    ['2026-09-23T00:00:00+09:00', 0, 2, '2026-09-23'], // the epoch (Wednesday)
    ['2026-09-23T14:59:59Z', 0, 2, '2026-09-23'], // 23:59:59 JST
    ['2026-09-23T15:00:00Z', 1, 3, '2026-09-24'], // 00:00 JST next day
    ['2026-09-30T00:00:00+09:00', 7, 2, '2026-09-30'], // second week
    ['2026-12-31T23:59:59+09:00', 99, 3, '2026-12-31'], // year boundary, before
    ['2026-12-31T15:00:00Z', 100, 4, '2027-01-01'], // year boundary: UTC still 2026, JST already 2027
    ['2027-03-15T09:30:00+09:00', 173, 0, '2027-03-15'], // Monday
    ['2028-02-29T12:00:00+09:00', 524, 1, '2028-02-29'], // leap day
  ];
  for (const [iso, day, wd, date] of vectors) {
    it(`${iso} -> day ${day}, weekday ${wd}`, () => {
      const t = Date.parse(iso);
      expect(dayIndexAt(t)).toBe(day);
      expect(jstWeekday(t)).toBe(wd);
      expect(jstDateString(t)).toBe(date);
    });
  }

  it('JST calendar days: start, time of day, and the 02:00 grace of yesterday\'s board (§7.8 step 2)', () => {
    const t = Date.parse('2026-10-05T01:30:00+09:00');
    const day = jstDayNumber(t);
    expect(jstDayStartMs(day)).toBe(Date.parse('2026-10-05T00:00:00+09:00'));
    expect(jstDayNumber(jstDayStartMs(day))).toBe(day);
    expect(jstTimeOfDay(t)).toBe(90 * 60_000);
    expect(jstTimeOfDay(Date.parse('2026-10-04T23:59:59+09:00'))).toBe(DAY_MS - 1000);
    expect(DAILY_GRACE_MS).toBe(2 * 3600 * 1000);
    expect(dailyDayOpen(day, t)).toBe(true);                        // today
    expect(dailyDayOpen(day - 1, t)).toBe(true);                    // yesterday, 01:30
    expect(dailyDayOpen(day - 1, jstDayStartMs(day) + DAILY_GRACE_MS - 1)).toBe(true);
    expect(dailyDayOpen(day - 1, jstDayStartMs(day) + DAILY_GRACE_MS)).toBe(false); // 02:00: the Worker says badBoard
    expect(dailyDayOpen(day - 2, t)).toBe(false);
    expect(dailyDayOpen(day + 1, t)).toBe(false);
    // the days before the epoch share dayIndex 0 but not their calendar day
    const pre = Date.parse('2026-09-20T12:00:00+09:00');
    expect(dayIndexAt(pre)).toBe(dayIndexAt(pre + DAY_MS));
    expect(jstDayNumber(pre + DAY_MS)).toBe(jstDayNumber(pre) + 1);
  });

  it('changes exactly at 00:00 JST', () => {
    const t = Date.parse('2026-10-05T00:00:00+09:00');
    expect(dayIndexAt(t - 1)).toBe(11);
    expect(dayIndexAt(t)).toBe(12);
    expect(dayIndexAt(t + DAY_MS - 1)).toBe(12);
  });
});

describe('pickDaily', () => {
  const pool = fakePool();
  // [instant, dayIndex, weekday, perm slot]; slot = perm12[floor(day / 7) mod 12], pool index = weekday + 7 * slot.
  const vectors: [string, number, number, number][] = [
    ['2026-09-22T12:00:00+09:00', 0, 1, 4],
    ['2026-09-23T00:00:00+09:00', 0, 2, 4],
    ['2026-09-24T00:00:00+09:00', 1, 3, 4],
    ['2026-09-29T23:59:59+09:00', 6, 1, 4],
    ['2026-09-30T00:00:00+09:00', 7, 2, 5],
    ['2026-12-31T23:59:59+09:00', 99, 3, 6],
    ['2027-01-01T00:00:00+09:00', 100, 4, 6],
    ['2027-03-15T09:30:00+09:00', 173, 0, 4],
    ['2028-02-29T12:00:00+09:00', 524, 1, 6],
    ['2025-01-01T00:00:00+09:00', 0, 2, 4],
  ];
  for (const [iso, day, wd, slot] of vectors) {
    it(`${iso} -> tier ${wd + 1}, slot ${slot}`, () => {
      const pick = pickDaily(pool, Date.parse(iso));
      expect(pick.dayIndex).toBe(day);
      expect(pick.n).toBe(day + 1);
      expect(pick.poolIndex).toBe(wd + 7 * slot);
      expect(pick.level.id).toBe(`d:${wd + 7 * slot}`);
      expect(pick.level.tier).toBe(wd + 1);
    });
  }

  it('cycles through all 12 entries of a tier in 84 days, then repeats', () => {
    const seen = new Set<number>();
    const thursday = Date.parse('2026-10-01T12:00:00+09:00');
    for (let week = 0; week < 12; week++) seen.add(pickDaily(pool, thursday + week * 7 * DAY_MS).poolIndex);
    expect(seen.size).toBe(12);
    expect(pickDaily(pool, thursday + 84 * DAY_MS).poolIndex).toBe(pickDaily(pool, thursday).poolIndex);
  });

  it('survives a short pool and rejects an empty one', () => {
    const short = pool.slice(0, 10); // tiers 1..7 with 1-2 entries each
    const pick = pickDaily(short, Date.parse('2027-03-15T09:30:00+09:00'));
    expect(pick.level.tier).toBe(1);
    expect(() => pickDaily([], Date.now())).toThrow();
  });
});
