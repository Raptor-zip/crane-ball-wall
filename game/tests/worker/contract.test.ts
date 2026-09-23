// The client's wire form (src/net/outbox.ts, O8) against the Worker: what the outbox sends must be accepted.
// Uses O8's pure functions only (no fetch), so a contract drift between src/net and worker/ fails here. Owner: O9.
import { beforeEach, describe, expect, it } from 'vitest';
import { dailyPendingRun, levelPendingRun, nTicksForScore, takeBatch, type PendingRun } from '../../src/net/outbox';
import type { SubmitRequest, SubmitResponse } from '../../src/shared/api';
import { DeviceTag } from '../../src/sim/replay';
import {
  NOW, dailyAt, fakeDailyPool, level, levelKey, pidhOf, request, resetAll, runRow, secretOf, submit, successBot,
  wallBots, type BotRun,
} from './helpers';

const POOL = fakeDailyPool(3000);

beforeEach(async () => {
  await resetAll({ pool: POOL });
});

describe('client outbox -> /api/submit', () => {
  it('a batch built by takeBatch (level PBs + today\'s daily) is accepted run by run', async () => {
    const d = dailyAt(POOL, NOW);
    const b11: BotRun = successBot(level('1-1').physics, { moveS: 4.5 });
    const [wall] = wallBots(1) as [{ levelId: string; bot: BotRun }];
    const bd: BotRun = successBot(d.phys, { moveS: 6 });
    // The client derives nTicks from the score; the Worker insists the replay ends on the success tick.
    expect(nTicksForScore(b11.t120)).toBe(b11.nTicks);
    expect(nTicksForScore(wall.bot.t120)).toBe(wall.bot.nTicks);

    const outbox: PendingRun[] = [
      levelPendingRun(levelKey('1-1'), '1-1', b11.replay, b11.t120, DeviceTag.Mouse, NOW - 3000),
      levelPendingRun(levelKey(wall.levelId), wall.levelId, wall.bot.replay, wall.bot.t120, DeviceTag.Keyboard, NOW - 2000),
    ];
    const daily = dailyPendingRun(
      { dayIndex: d.dayIndex, balls: ['fail', 'ok', 'gold', null, null], bestSub: bd.t120, bestReplay: bd.replay, submitted: 'none', lastSentT120: null },
      { board: d.key, level: d.levelId, device: DeviceTag.Touch, now: NOW - 1000 },
    );
    expect(daily).not.toBeNull();
    outbox.push(daily!);
    const runs = takeBatch(outbox);
    expect(runs).toHaveLength(3);
    const body: SubmitRequest = { v: 1, secret: secretOf(7), nameSeed: 4321, runs };
    const res = await submit(body);
    expect(res.status).toBe(200);
    const j = (await res.json()) as SubmitResponse;
    expect(j.results.map((r) => [r.board, r.status])).toEqual(runs.map((r) => [r.board, 'accepted']));
    const dr = (await runRow(d.key, pidhOf(7)))!;
    expect([dr.t120, dr.tries, dr.balls]).toEqual([bd.t120, 3, 'XOG--']);

    // The day's second send carries prev = the accepted t120; a participation without success after it is notBetter.
    const again = dailyPendingRun(
      { dayIndex: d.dayIndex, balls: ['fail', 'ok', 'gold', 'fail', 'fail'], bestSub: null, bestReplay: null, submitted: 'partial', lastSentT120: bd.t120 },
      { board: d.key, level: d.levelId, device: DeviceTag.Touch, now: NOW },
    );
    // (bestSub null is not better than the last send, so §7.9 does not send it; force the wire form to check the Worker.)
    expect(again).toBeNull();
    const forced = takeBatch([{ board: d.key, level: d.levelId, replay: null, t120: null, device: DeviceTag.Touch, tries: 5, balls: 'XOGXX', prev: bd.t120, nTicks: 0, queuedAt: NOW }]);
    const r2 = (await (await submit(request(7, forced, 4321))).json()) as SubmitResponse;
    expect(r2.results[0]).toMatchObject({ status: 'notBetter', rank: 1 });
    expect((await runRow(d.key, pidhOf(7)))!.balls).toBe('XOGXX');
  });
});
