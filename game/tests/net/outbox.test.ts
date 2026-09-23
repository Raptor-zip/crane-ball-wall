// Outbox aggregation and batching (GAME_DESIGN.md §7.9). Owner: O8.
import { describe, expect, it } from 'vitest';
import {
  BATCH_MAX_BYTES, OUTBOX_MAX, REPLAY_MAX_CHARS, ballsString, ballsUsed, boardDay, dailyPendingRun, dailySendDue, enqueueRun,
  isSendable, levelPendingRun, nTicksForScore, takeBatch, toSubmitRun, type DailySendState, type PendingRun,
} from '../../src/net/outbox';

const L = (id: string, h = '9f3a12bc'): string => `L:${id}:${h}:s1`;
const D = (day: number, h = '1c0e77aa'): string => `D:${String(day).padStart(5, '0')}:${h}:s1`;

function lv(id: string, t120: number, over: Partial<PendingRun> = {}): PendingRun {
  return { board: L(id), level: id, replay: `R${id}-${t120}`, t120, device: 1, nTicks: nTicksForScore(t120), queuedAt: 0, ...over };
}
function dly(day: number, t120: number | null, over: Partial<PendingRun> = {}): PendingRun {
  return {
    board: D(day), level: 'd:17', replay: t120 === null ? null : `D${t120}`, t120, device: 1,
    tries: 5, balls: 'XOOCX', nTicks: t120 === null ? 0 : nTicksForScore(t120), queuedAt: 0, ...over,
  };
}
const replayOf = (bytes: number): string => 'A'.repeat(bytes);
/** The i-th valid level id (1-1 .. 5-9). */
const lid = (i: number): string => `${1 + Math.floor(i / 9)}-${1 + (i % 9)}`;

describe('enqueueRun: best run per board, 20 boards max', () => {
  it('keeps one entry per board and replaces it only with a strictly faster run', () => {
    let o: PendingRun[] = [];
    o = enqueueRun(o, lv('2-2', 400, { queuedAt: 1 }));
    o = enqueueRun(o, lv('2-2', 350, { queuedAt: 2 }));
    o = enqueueRun(o, lv('2-2', 380, { queuedAt: 3 }));
    o = enqueueRun(o, lv('2-2', 350, { queuedAt: 4, replay: 'other' }));   // a tie keeps the earlier run
    o = enqueueRun(o, lv('1-1', 200, { queuedAt: 5 }));
    expect(o).toHaveLength(2);
    expect(o.find((r) => r.level === '2-2')).toMatchObject({ t120: 350, queuedAt: 2, replay: 'R2-2-350' });
  });

  it('does not mutate its input', () => {
    const a: PendingRun[] = [lv('2-2', 400)];
    const snapshot = JSON.stringify(a);
    enqueueRun(a, lv('2-2', 300));
    enqueueRun(a, lv('1-1', 300));
    expect(JSON.stringify(a)).toBe(snapshot);
  });

  it('caps the outbox at 20 boards, evicting the oldest queued entry', () => {
    let o: PendingRun[] = [];
    for (let i = 0; i < 25; i++) o = enqueueRun(o, lv(lid(i), 300, { board: L(lid(i)), queuedAt: 100 + i }));
    expect(o).toHaveLength(OUTBOX_MAX);
    expect(o.map((r) => r.level)).toEqual(Array.from({ length: 20 }, (_, i) => lid(i + 5)));
  });

  it('daily: best time wins, the most advanced rack wins, prev comes from the newest entry', () => {
    let o: PendingRun[] = [];
    o = enqueueRun(o, dly(23, 455, { tries: 2, balls: 'XO---', queuedAt: 10 }));
    o = enqueueRun(o, dly(23, 500, { tries: 5, balls: 'XOXOX', prev: 455, queuedAt: 20 }));
    expect(o).toHaveLength(1);
    expect(o[0]).toMatchObject({ t120: 455, replay: 'D455', tries: 5, balls: 'XOXOX', prev: 455, queuedAt: 10 });
    o = enqueueRun(o, dly(23, 420, { tries: 3, balls: 'XOC--', queuedAt: 30 }));
    expect(o[0]).toMatchObject({ t120: 420, replay: 'D420', tries: 5, balls: 'XOXOX' });
    // A participation without success never replaces a success.
    o = enqueueRun(o, dly(23, null, { tries: 5, balls: 'XXXXX' }));
    expect(o[0]).toMatchObject({ t120: 420, replay: 'D420' });
  });

  it('refuses runs the server could never rank', () => {
    expect(enqueueRun([], lv('2-2', 300, { replay: null }))).toEqual([]);                  // level run without replay
    expect(enqueueRun([], lv('2-2', 300, { nTicks: 2701 }))).toEqual([]);                 // tooLong
    expect(enqueueRun([], dly(23, 455, { replay: null }))).toEqual([]);                   // replay/t120 must both be null
    expect(enqueueRun([], dly(23, null))).toHaveLength(1);                                // daily participation is fine
    expect(isSendable(lv('2-2', 5341))).toBe(true);                                       // 44.5 s: nTicks 2700
    expect(isSendable(lv('2-2', 5342))).toBe(false);                                      // nTicks 2701
  });
});

describe('isSendable mirrors the Worker request check (one bad run would make the whole request a 400)', () => {
  it.each([
    ['device 6', lv('2-2', 300, { device: 6 as never })],
    ['device 2.5', lv('2-2', 300, { device: 2.5 as never })],
    ['an unparsable board key', lv('2-2', 300, { board: 'L:2-2:XYZ:s1' })],
    ['a level id the Worker does not know the shape of', lv('x1', 300)],
    ['an empty level', lv('2-2', 300, { level: '' })],
    ['a level longer than 16 characters', lv('2-2', 300, { level: 'l'.repeat(17) })],
    ['a replay that is not base64url', lv('2-2', 300, { replay: 'a+b/' })],
    ['a replay above 6 KB', lv('2-2', 300, { replay: 'A'.repeat(REPLAY_MAX_CHARS + 1) })],
    ['a fractional time', lv('2-2', 300, { t120: 300.5 })],
    ['a daily with 6 tries', dly(23, 455, { tries: 6 })],
    ['a daily with a 6-ball rack', dly(23, 455, { balls: 'XOXOXO' })],
    ['a daily with a negative prev', dly(23, 455, { prev: -1 })],
  ])('refuses %s', (_, r) => {
    expect(isSendable(r)).toBe(false);
    expect(enqueueRun([], r)).toEqual([]);
  });

  it('accepts the limits themselves', () => {
    expect(isSendable(lv('2-2', 300, { replay: 'A'.repeat(REPLAY_MAX_CHARS) }))).toBe(true);
    expect(isSendable(lv('5-9', 300, { device: 5 as never }))).toBe(true);
    expect(isSendable(dly(23, 455, { prev: null, tries: 5, balls: 'XOGC-' }))).toBe(true);
    expect(isSendable(lv('2-2', 300, { tries: 99 as never }))).toBe(true);   // not sent on level boards
  });
});

describe('takeBatch: 4 runs, 16 KB, sum(nTicks*2) <= 5400 with the first run exempt', () => {
  it('stops at 4 runs', () => {
    let o: PendingRun[] = [];
    for (let i = 0; i < 7; i++) o = enqueueRun(o, lv(`1-${i + 1}`, 100, { board: L(`1-${i + 1}`), queuedAt: i, nTicks: 10 }));
    const b = takeBatch(o);
    expect(b).toHaveLength(4);
    expect(b.map((r) => r.level)).toEqual(['1-1', '1-2', '1-3', '1-4']);
  });

  it('keeps the substep sum within 5400, but always takes the first run however long', () => {
    const o = [
      lv('3-1', 100, { board: L('3-1'), queuedAt: 1, nTicks: 2700 }),   // 5400 substeps alone: allowed as the first run
      lv('3-2', 100, { board: L('3-2'), queuedAt: 2, nTicks: 1 }),
    ];
    expect(takeBatch(o).map((r) => r.level)).toEqual(['3-1']);
    const o2 = [
      lv('3-1', 100, { board: L('3-1'), queuedAt: 1, nTicks: 1500 }),   // 3000
      lv('3-2', 100, { board: L('3-2'), queuedAt: 2, nTicks: 1300 }),   // 2600 -> 5600 > 5400: skipped
      lv('3-3', 100, { board: L('3-3'), queuedAt: 3, nTicks: 1200 }),   // 2400 -> 5400: fits
      lv('3-4', 100, { board: L('3-4'), queuedAt: 4, nTicks: 1 }),      // 2 -> 5402: skipped
    ];
    expect(takeBatch(o2).map((r) => r.level)).toEqual(['3-1', '3-3']);
    // A daily participation costs no re-simulation.
    const o3 = [lv('3-1', 100, { board: L('3-1'), queuedAt: 1, nTicks: 2700 }), dly(23, null, { queuedAt: 2 })];
    expect(takeBatch(o3).map((r) => r.board)).toEqual([D(23), L('3-1')]);
  });

  it('keeps the whole request body within 16 KB', () => {
    // Worst-case touch replays: ~5.4 KB binary -> ~7.2 KB base64url each.
    const o = [0, 1, 2, 3].map((i) => lv(`2-${i + 1}`, 100, { board: L(`2-${i + 1}`), queuedAt: i, nTicks: 300, replay: replayOf(7200) }));
    const b = takeBatch(o);
    expect(b).toHaveLength(2);
    const body = JSON.stringify({ v: 1, secret: 'x'.repeat(22), nameSeed: 65535, runs: b });
    expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(BATCH_MAX_BYTES);
    // Small runs behind a big one still get packed.
    const o2 = [...o, lv('4-9', 100, { board: L('4-9'), queuedAt: 9, nTicks: 20, replay: replayOf(40) })];
    expect(takeBatch(o2).map((r) => r.level)).toEqual(['2-1', '2-2', '4-9']);
  });

  it('sends daily boards first, then oldest first', () => {
    const o = [lv('2-2', 300, { queuedAt: 5 }), lv('1-1', 300, { board: L('1-1'), queuedAt: 1 }), dly(23, 455, { queuedAt: 9 })];
    expect(takeBatch(o).map((r) => r.board)).toEqual([D(23), L('1-1'), L('2-2')]);
  });

  it('lite: levels stay queued, dailies still go; in-flight boards are excluded', () => {
    const o = [lv('2-2', 300), dly(23, 455)];
    expect(takeBatch(o, { skipLevels: true }).map((r) => r.board)).toEqual([D(23)]);
    expect(takeBatch(o, { exclude: new Set([D(23)]) }).map((r) => r.board)).toEqual([L('2-2')]);
    expect(takeBatch([])).toEqual([]);
  });

  it('produces the wire form of §7.7 (no nTicks / queuedAt; prev omitted before the first send)', () => {
    expect(toSubmitRun(lv('2-2', 301))).toEqual({ board: L('2-2'), level: '2-2', replay: 'R2-2-301', t120: 301, device: 1 });
    expect(toSubmitRun(lv('2-2', 301, { prev: 5, tries: 3 }))).toEqual({ board: L('2-2'), level: '2-2', replay: 'R2-2-301', t120: 301, device: 1 });
    expect(toSubmitRun(dly(23, 455, { prev: null }))).toEqual({ board: D(23), level: 'd:17', replay: 'D455', t120: 455, device: 1, tries: 5, balls: 'XOOCX', prev: null });
    const first = toSubmitRun(dly(23, null, { balls: 'XXXXX' }));
    expect(first).toEqual({ board: D(23), level: 'd:17', replay: null, t120: null, device: 1, tries: 5, balls: 'XXXXX' });
    expect('prev' in first).toBe(false);
  });
});

describe('daily send rules', () => {
  const st = (over: Partial<DailySendState> = {}): DailySendState => ({
    dayIndex: 23, balls: ['fail', 'ok', null, null, null], bestSub: 455, bestReplay: 'D455', submitted: 'none', lastSentT120: null, ...over,
  });
  const ctx = { board: D(23), level: 'd:17', device: 1 as const, now: 1234 };

  it('ballsString / ballsUsed', () => {
    expect(ballsString(['fail', 'ok', 'gold', 'crown', null])).toBe('XOGC-');
    expect(ballsString([])).toBe('-----');
    expect(ballsUsed(['fail', null, 'ok', null, null])).toBe(2);
    expect(boardDay(D(23))).toBe(23);
    expect(boardDay(L('2-2'))).toBeNull();
  });

  it('is due once a ball is used and nothing was sent yet', () => {
    expect(dailySendDue(st({ balls: [null, null, null, null, null] }))).toBe(false);
    expect(dailySendDue(st())).toBe(true);
    const r = dailyPendingRun(st(), ctx)!;
    expect(r).toEqual({ board: D(23), level: 'd:17', replay: 'D455', t120: 455, device: 1, tries: 2, balls: 'XO---', nTicks: nTicksForScore(455), queuedAt: 1234 });
    expect('prev' in r).toBe(false);   // first send of the day: prev omitted
  });

  it('after a partial send only an improved record is sent again, with prev = the last accepted time', () => {
    expect(dailySendDue(st({ submitted: 'partial', lastSentT120: 455 }))).toBe(false);
    expect(dailySendDue(st({ submitted: 'partial', lastSentT120: 455, bestSub: 455 }))).toBe(false);
    expect(dailySendDue(st({ submitted: 'partial', lastSentT120: 500 }))).toBe(true);
    expect(dailyPendingRun(st({ submitted: 'partial', lastSentT120: 500 }), ctx)!.prev).toBe(500);
    // A partial participation without success is improved by any success; prev is then null.
    const r = dailyPendingRun(st({ submitted: 'partial', lastSentT120: null }), ctx)!;
    expect(r.prev).toBeNull();
    expect(r.t120).toBe(455);
  });

  it('never after the final send; never for another day', () => {
    expect(dailySendDue(st({ submitted: 'final', lastSentT120: 900, bestSub: 100 }))).toBe(false);
    expect(dailyPendingRun(st(), { ...ctx, board: D(22) })).toBeNull();
  });

  it('a day without success is reported as participation (replay and time null)', () => {
    const r = dailyPendingRun(st({ balls: ['fail', 'fail', 'fail', 'fail', 'fail'], bestSub: null, bestReplay: null }), ctx)!;
    expect(r).toMatchObject({ replay: null, t120: null, nTicks: 0, tries: 5, balls: 'XXXXX' });
    // A best run that cannot be ranked (> 44.5 s, or no replay because it exceeded 6 KB) still counts the player.
    expect(dailyPendingRun(st({ bestSub: 6000 }), ctx)).toMatchObject({ replay: null, t120: null });
    expect(dailyPendingRun(st({ bestReplay: null }), ctx)).toMatchObject({ replay: null, t120: null });
  });

  it('levelPendingRun derives nTicks from the score (§4.6)', () => {
    expect(nTicksForScore(301)).toBe(180);
    expect(nTicksForScore(5341)).toBe(2700);
    expect(levelPendingRun(L('2-2'), '2-2', 'RR', 301, 2, 99)).toEqual({ board: L('2-2'), level: '2-2', replay: 'RR', t120: 301, device: 2, nTicks: 180, queuedAt: 99 });
  });
});
