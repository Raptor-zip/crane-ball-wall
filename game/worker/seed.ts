// One-off seed of the level histograms (GAME_DESIGN.md §7.7 「面のヒストグラムと順位の推定」). Owner: O9.
// Not a migration: migrations run before the deploy (while the old Worker still serves), in every local and test DB,
// and cannot know the current level keys. tools/seed-level-hist.mjs turns the keys of the live boot answer into a SQL
// file that the main session applies once with `wrangler d1 execute --remote --file` after the deploy.
//
// Pure, no imports and erasable TypeScript only: Node runs this file directly through type stripping.
//
// Safe at any time after migration 0003, and idempotent: (a) is a monotone min (a rerun writes 0 rows), (b) only
// raises today's write estimate, (c) only arms the rebuild. Stale-hash boards are never touched. Without the seed the
// hourly rebuild stays unarmed and level hists stay NULL (estimates hidden).

/** A level board key `L:<id>:<levelHash>:s<SIM_VERSION>` (the same shape parseBoardKey accepts). */
export const LEVEL_KEY_RE = /^L:[1-5]-[1-9]:[0-9a-f]{8}:s[1-9][0-9]{0,3}$/;

/** The seeding statements for the current level boards `keys` (every key must match LEVEL_KEY_RE; throws otherwise). */
export function seedLevelHistSql(keys: readonly string[]): string[] {
  if (keys.length === 0) throw new Error('seedLevelHistSql: no keys');
  const seen = new Set<string>();
  for (const k of keys) {
    if (typeof k !== 'string' || !LEVEL_KEY_RE.test(k)) throw new Error(`seedLevelHistSql: not a level board key: ${String(k)}`);
    if (seen.has(k)) throw new Error(`seedLevelHistSql: duplicate key: ${k}`);
    seen.add(k);
  }
  // The keys match LEVEL_KEY_RE, so they hold no quote: plain single-quoted literals are safe.
  const inList = keys.map((k) => `'${k}'`).join(', ');
  return [
    // (a) runs -> plays: the top-100 / AI-beaten times become histogram positions; a faster plays time is kept.
    'INSERT INTO plays (board, pidh, created, t120) ' +
      `SELECT board, pidh, created, t120 FROM runs WHERE board IN (${inList}) AND t120 IS NOT NULL ` +
      'ON CONFLICT (board, pidh) DO UPDATE SET t120 = excluded.t120 ' +
      'WHERE plays.t120 IS NULL OR excluded.t120 < plays.t120',
    // (b) the rows (a) can write (an upper bound) + these 2 counters rows go into today's JST write estimate
    //     (the soft / lite valves see them).
    'INSERT INTO counters (k, n) ' +
      `SELECT 'wr:' || date('now', '+9 hours'), COUNT(*) + 2 FROM runs WHERE board IN (${inList}) AND t120 IS NOT NULL ` +
      'ON CONFLICT (k) DO UPDATE SET n = n + excluded.n',
    // (c) arm the hourly rebuild (worker/hist.ts): it runs at the next :07.
    "INSERT INTO counters (k, n) VALUES ('hist:next', 0) ON CONFLICT (k) DO UPDATE SET n = 0",
  ];
}
