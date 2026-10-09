#!/usr/bin/env node
// Export aggregate production statistics only; never export browser IDs.
// Run from any directory: node game/tools/readme-stats.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const game = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// plays preserves first participation; runs supplies records predating plays.
// Deduplicate both sources before counting, since runs is updated on improvements.
const sql = `WITH records AS (
  SELECT board, pidh, MIN(created) AS first_ms FROM (
    SELECT board, pidh, created FROM plays
    UNION ALL SELECT board, pidh, created FROM runs
  ) GROUP BY board, pidh
), users AS (
  SELECT pidh, MIN(first_ms) AS first_ms FROM records GROUP BY pidh
), events AS (
  SELECT strftime('%Y-%m-%d', first_ms/1000, 'unixepoch', '+9 hours') AS date_jst,
    1 AS new_users, 0 AS level_clears, 0 AS daily_entries FROM users
  UNION ALL
  SELECT strftime('%Y-%m-%d', first_ms/1000, 'unixepoch', '+9 hours'),
    0, CASE WHEN board >= 'L:' AND board < 'L;' THEN 1 ELSE 0 END,
    CASE WHEN board >= 'D:' AND board < 'D;' THEN 1 ELSE 0 END FROM records
)
SELECT date_jst, SUM(new_users) AS new_users, SUM(level_clears) AS level_clears,
  SUM(daily_entries) AS daily_entries FROM events GROUP BY date_jst ORDER BY date_jst`;
const raw = execFileSync('npx', ['wrangler', 'd1', 'execute', 'yurapita', '--remote', '--json', '--command', sql], {
  cwd: game, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 << 20,
});
const result = JSON.parse(raw)[0];
if (!result?.success || !Array.isArray(result.results) || !result.results.length) {
  throw new Error('Missing or unsuccessful D1 statistics response');
}
const daily = result.results.map((r) => ({
  date_jst: r.date_jst, new_users: Number(r.new_users),
  level_clears: Number(r.level_clears), daily_entries: Number(r.daily_entries),
}));
const sum = (key) => daily.reduce((n, r) => n + r[key], 0);
const snapshot = {
  sampled_at_utc: new Date().toISOString(),
  source: 'Production yurapita D1: plays UNION runs, deduplicated by (board, pidh)',
  users_definition: 'Distinct browser IDs with a recorded level clear or daily participation',
  plays_definition: 'One first clear per browser and level board, plus one participation per browser and daily board; retries and repeat clears are not counted',
  caveat: 'plays began 2026-09-23 20:44 JST; earlier records are incomplete. Dates are first known server records, not necessarily actual play dates. Counts exclude unsubmitted offline/assisted/practice play and may count one person across multiple browsers.',
  totals: { users: sum('new_users'), recorded_plays: sum('level_clears') + sum('daily_entries'),
    level_clears: sum('level_clears'), daily_entries: sum('daily_entries') },
  daily,
};
const out = resolve(game, '../docs/stats');
mkdirSync(out, { recursive: true });
writeFileSync(resolve(out, 'snapshot.json'), JSON.stringify(snapshot, null, 2) + '\n');
console.log(JSON.stringify({ sampled_at_utc: snapshot.sampled_at_utc, ...snapshot.totals }, null, 2));
