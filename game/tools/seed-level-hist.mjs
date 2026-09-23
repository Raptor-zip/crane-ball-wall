#!/usr/bin/env node
// Generates the one-off level-histogram seed (GAME_DESIGN.md §7.7 「面のヒストグラムと順位の推定」). Owner: O9.
//
// Usage: node tools/seed-level-hist.mjs --origin https://<prod origin> [--out <file>]
//
// Reads the current level board keys from GET <origin>/api/boot?day=0 (1 read request, nothing is written), checks
// them (one per level of src/data/levels.json, 18 today; every key a level board key; no duplicates) and writes the
// statements of worker/seed.ts seedLevelHistSql to --out (default stdout). The SQL is NOT applied here: the commands
// to check, apply and verify it are printed on stderr, and the main session runs them (§12.2 of the stage-2 spec).
// Exit 1 on any problem, with nothing written.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEVEL_KEY_RE, seedLevelHistSql } from '../worker/seed.ts';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length && !args[i + 1].startsWith('--') ? args[i + 1] : null;
};
const fail = (msg) => {
  console.error(`seed-level-hist: ${msg}`);
  process.exit(1);
};

const origin = opt('origin');
const out = opt('out');
if (!origin || !/^https?:\/\/[^/]+$/.test(origin.replace(/\/$/, ''))) {
  fail('usage: node tools/seed-level-hist.mjs --origin https://<prod origin> [--out <file>]');
}
const base = origin.replace(/\/$/, '');

// The level ids the Worker serves (worker/verify.ts levelTargets: every level of levels.json).
const levelIds = JSON.parse(readFileSync(resolve(ROOT, 'src/data/levels.json'), 'utf8')).levels.map((l) => l.id);

let boot;
try {
  const res = await fetch(`${base}/api/boot?day=0`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) fail(`GET ${base}/api/boot?day=0 answered ${res.status}`);
  boot = await res.json();
} catch (e) {
  fail(`GET ${base}/api/boot?day=0 failed: ${String(e)}`);
}
if (typeof boot !== 'object' || boot === null || typeof boot.boards !== 'object' || boot.boards === null) {
  fail('the boot answer has no "boards" object');
}

const entries = Object.entries(boot.boards);
const keys = entries.map(([, b]) => (typeof b === 'object' && b !== null ? b.key : undefined));
if (keys.length !== levelIds.length) fail(`expected ${levelIds.length} level boards, the boot answer has ${keys.length}`);
for (const [id, b] of entries) {
  if (!levelIds.includes(id)) fail(`boot board "${id}" is not a level of src/data/levels.json`);
  if (typeof b?.key !== 'string' || !LEVEL_KEY_RE.test(b.key)) fail(`boot board "${id}" has a bad key: ${JSON.stringify(b?.key)}`);
  if (b.key.split(':')[1] !== id) fail(`boot board "${id}" has the key of another level: ${b.key}`);
}
if (new Set(keys).size !== keys.length) fail('the boot answer repeats a board key');
if (boot.soft === true || boot.lite === true) {
  console.error('seed-level-hist: WARNING: the Worker reports soft/lite today; wait for the next JST day before applying.');
}

const sql = seedLevelHistSql(keys).join(';\n') + ';\n';
if (out) writeFileSync(out, sql);
else process.stdout.write(sql);

const file = out ?? '<file>';
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const d1 = (sqlText) => `npx wrangler d1 execute yurapita --remote --command "${sqlText}"`;
console.error(`seed-level-hist: ${keys.length} current level keys from ${base}${out ? `, SQL written to ${out}` : ''}.

Pre-check (read-only):
  ${d1('PRAGMA table_info(plays)')}          # shows t120 (migration 0003 applied)
  ${d1(`SELECT k, n FROM counters WHERE k IN ('wr:${today}', 'req:${today}', 'hist:next')`)}
  ${d1("SELECT board, COUNT(*) runs FROM runs WHERE board >= 'L:' AND board < 'L;' GROUP BY board")}
  Apply only if wr:${today} + the runs total < 30000 (otherwise wait for the next JST day), and at least 10 min after
  the deploy (old isolates drained). Read ${file} first.

Apply (the one production write):
  npx wrangler d1 execute yurapita --remote --file "${file}"

Verify (read-only):
  ${d1("SELECT board, COUNT(*) plays, SUM(t120 IS NOT NULL) counted FROM plays WHERE board >= 'L:' AND board < 'L;' GROUP BY board")}
    # counted >= runs for every current key
  ${d1(`SELECT k, n FROM counters WHERE k IN ('wr:${today}', 'req:${today}', 'hist:next')`)}
    # hist:next = 0, wr went up
  After the next :07: npx wrangler tail yurapita --format json | grep hist-rebuild   # {read, written <= 20}
  Then boot shows boards["1-1"].hist with a sum close to counted.`);
