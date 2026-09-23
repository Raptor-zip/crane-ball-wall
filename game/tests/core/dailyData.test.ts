// The bundled daily pool and daily ghosts, as the game loads them (GAME_DESIGN.md §7.5, §8.2). Owner: O3.
// Skipped while the files are not generated yet (the data module then simply has no daily).
import { describe, expect, it } from 'vitest';
import { createGameData } from '../../src/core/data';
import { createSession } from '../../src/core/session';
import { poseAt, newGhostPose, trackDuration } from '../../src/core/ghosts';
import { DAILY_EPOCH, DAY_MS, pickDaily } from '../../src/shared/daily';
import { Status } from '../../src/sim/run';

const data = createGameData();
const hasPool = data.dailyPool.length > 0;

describe.skipIf(!hasPool)('bundled daily pool', () => {
  it('84 levels, 12 per tier, each a playable daily level with its own par', () => {
    expect(data.dailyPool.length).toBe(84);
    for (let t = 1; t <= 7; t++) expect(data.dailyPool.filter((l) => l.tier === t).length).toBe(12);
    for (const l of data.dailyPool) {
      expect(l.world).toBe(0);
      expect(data.level(l.id)).toBe(l);
      expect(data.parSub(l)).toBe(l.parSub);
      expect(l.parSub).toBeGreaterThan(0);
      // a session can be built and sits at READY with q = 0
      const s = createSession(l);
      expect(s.tick(0)).toBe(Status.Ready);
    }
  });

  it('a week of picks uses one level of each tier; the AI ghost loads lazily and ends in the zone', async () => {
    const tiers = new Set<number>();
    for (let d = 0; d < 7; d++) tiers.add(pickDaily(data.dailyPool, DAILY_EPOCH + d * DAY_MS + 3600_000).level.tier);
    expect(tiers.size).toBe(7);
    const pick = pickDaily(data.dailyPool, DAILY_EPOCH + 30 * DAY_MS).level;
    expect(data.track(pick, 'ai')).toBeNull(); // not loaded yet
    expect(await data.loadDailyGhosts()).toBe(true);
    const ai = data.track(pick, 'ai');
    expect(ai).not.toBeNull();
    expect(ai!.finishSub).toBe(data.ghostJson(pick, 'ai')!.parSub);
    const pose = newGhostPose();
    poseAt(ai!, trackDuration(ai!), pose);
    const zone = pick.physics.phases.at(-1)!;
    expect(pose.bx).toBeGreaterThanOrEqual(zone.xa - 1e-3);
    expect(pose.bx).toBeLessThanOrEqual(zone.xb + 1e-3);
  });
});
