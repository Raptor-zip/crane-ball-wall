// Cron triggers (GAME_DESIGN.md §7.7 構成). Owner: O9.
// Daily 30 15 * * * (00:30 JST): delete daily runs rows older than 15 days. A primary-key range DELETE (LIKE would not
// use the key). boards rows of old dailies are small and stay.
// Hourly 7 * * * *: the level histogram rebuild (worker/hist.ts). worker/index.ts scheduled() dispatches on the cron
// string; both must match wrangler.jsonc "triggers.crons" (tests/data/wrangler_crons.test.ts).
import type { Env } from './index';
import { Db, rowsWritten } from './db';
import { jstDate } from './limits';
import { dayIndexAt } from '../src/shared/daily';

export const CRON_DAILY = '30 15 * * *';
export const CRON_HIST = '7 * * * *';

export const DAILY_KEEP_DAYS = 15;

/** The exclusive upper bound of the deletion range, or null when nothing is old enough. */
export function cronCutoffKey(nowMs: number): string | null {
  const oldestKept = dayIndexAt(nowMs) - DAILY_KEEP_DAYS;
  if (oldestKept <= 0) return null;
  return `D:${String(oldestKept).padStart(5, '0')}`;
}

/** Returns the number of deleted runs rows. */
export async function runCron(env: Env, scheduledTime: number): Promise<number> {
  if (env.READ_ONLY === '1') {
    console.log(JSON.stringify({ evt: 'cron', skipped: 'READ_ONLY' }));
    return 0;
  }
  const hi = cronCutoffKey(scheduledTime);
  if (hi === null) {
    console.log(JSON.stringify({ evt: 'cron', below: null, deleted: 0 }));
    return 0;
  }
  const db = new Db(env.DB);
  const del = await db.run(db.prepare("DELETE FROM runs WHERE board >= 'D:' AND board < ?").bind(hi));
  const deleted = Number(del.meta?.changes ?? 0) || 0;
  // The deletions count towards today's estimated writes (lite safety valve, §7.8 step 10).
  if (deleted > 0) {
    await db.run(
      db.prepare('INSERT INTO counters (k, n) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET n = n + excluded.n')
        .bind(`wr:${jstDate(scheduledTime)}`, Math.max(deleted, rowsWritten([del])) + 1),
    );
  }
  console.log(JSON.stringify({ evt: 'cron', below: hi, deleted }));
  return deleted;
}
