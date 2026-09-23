#!/usr/bin/env node
// Deploy guard for DAILY_EPOCH (GAME_DESIGN.md §7.5, §11 M12). Owner: O0.
//
// Every JST day before DAILY_EPOCH has dayIndex 0, so before the epoch the daily board key of days that are a
// multiple of 7 apart collides, the client cannot tell two such days apart by dayIndex alone, and the "#N" of the
// share line is wrong. The spec therefore says: if the launch day is earlier than the epoch, move the epoch to the
// launch day before deploying. This check makes that mechanical - `npm run deploy` fails while the epoch is still
// in the future.
//
// Usage: node tools/check-epoch.mjs [--now <ms>]   (exit 0 = fine, 1 = the epoch has not started yet)
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SRC = join(ROOT, 'src/shared/daily.ts');

const i = process.argv.indexOf('--now');
const now = i >= 0 ? Number(process.argv[i + 1]) : Date.now();
if (!Number.isFinite(now)) {
  console.error('check-epoch: --now must be a number (ms since the epoch)');
  process.exit(1);
}

const src = readFileSync(SRC, 'utf8');
const m = /export const DAILY_EPOCH = Date\.UTC\(([-0-9,\s]+)\);/.exec(src);
if (!m) {
  console.error(`check-epoch: no "export const DAILY_EPOCH = Date.UTC(...)" in ${SRC}`);
  process.exit(1);
}
const args = m[1].split(',').map((s) => Number(s.trim()));
if (args.some((n) => !Number.isFinite(n))) {
  console.error(`check-epoch: cannot read DAILY_EPOCH arguments: ${m[1]}`);
  process.exit(1);
}
const epoch = Date.UTC(...args);
const fmt = (ms) => new Date(ms + 9 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' JST';

if (now < epoch) {
  const days = Math.ceil((epoch - now) / 86400000);
  console.error(
    `check-epoch: DAILY_EPOCH is ${fmt(epoch)}, which is ${days} day(s) in the future (now ${fmt(now)}).\n`
    + '  Every JST day before it has dayIndex 0 (GAME_DESIGN.md §7.5), so the daily board key, the client\'s\n'
    + '  day rollover and the share line\'s "#N" are all wrong before the epoch.\n'
    + `  Fix: set DAILY_EPOCH in ${SRC} to 00:00 JST of the launch day, update the pinned value in\n`
    + '  tests/core/daily.test.ts, and deploy again. Never change it after launch.',
  );
  process.exit(1);
}
console.log(`check-epoch: OK (DAILY_EPOCH ${fmt(epoch)}, day index ${Math.floor((now - epoch) / 86400000)})`);
