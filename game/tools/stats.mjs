#!/usr/bin/env node
// Play-population stats from the production D1 (read-only SELECTs through `wrangler d1 execute --remote`).
//
//   npm run stats                 # a readable summary (run from game/)
//   npm run stats -- --json       # the same numbers as JSON (for scripts)
//   node game/tools/stats.mjs     # from the repository root
//
// Needs a logged-in wrangler with D1 access (npx wrangler login). Nothing is written.
// "Devices" are browsers (plays ∪ runs, GAME_DESIGN.md §7.7), not people: one person on two devices counts twice, and a
// visitor who never cleared a level is not counted. plays started 2026-09-23 20:44 JST; earlier clears are only known
// from runs (top 100 / first AI-beaten) and the one-off seed, so the totals are a lower bound.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const asJson = process.argv.includes('--json');

const LEVEL_IDS = JSON.parse(readFileSync(resolve(ROOT, 'src/data/levels.json'), 'utf8')).levels.map((l) => l.id);
const DAILY_EPOCH = Date.UTC(2026, 8, 22, 15, 0, 0); // src/shared/daily.ts: 2026-09-23 00:00 JST
const DAY_MS = 86_400_000;
const JST_MS = 9 * 3_600_000;

const now = Date.now();
const dayIndex = Math.floor((now - DAILY_EPOCH) / DAY_MS);
const todayStart = DAILY_EPOCH + dayIndex * DAY_MS; // today 00:00 JST, epoch ms
const jstDate = new Date(now + JST_MS).toISOString().slice(0, 10);
const dailyPrefix = `D:${String(dayIndex).padStart(5, '0')}:`;

// Every clear a device is known for, per level id (all level hashes: a changed level still counts as cleared).
const CLEARS = `SELECT pidh, substr(board, 3, 3) AS lv FROM plays WHERE board >= 'L:' AND board < 'L;'
  UNION SELECT pidh, substr(board, 3, 3) AS lv FROM runs WHERE board >= 'L:' AND board < 'L;'`;
const SQL = [
  `SELECT COUNT(DISTINCT pidh) AS n FROM (SELECT pidh FROM plays UNION SELECT pidh FROM runs)`,
  `SELECT COUNT(DISTINCT pidh) AS n FROM plays WHERE created >= ${todayStart}`,
  `SELECT COUNT(*) AS n FROM (SELECT pidh FROM plays GROUP BY pidh HAVING MIN(created) >= ${todayStart})`,
  `SELECT lv, COUNT(DISTINCT pidh) AS n FROM (${CLEARS}) GROUP BY lv`,
  `SELECT levels, COUNT(*) AS n FROM (SELECT pidh, COUNT(DISTINCT lv) AS levels FROM (${CLEARS}) GROUP BY pidh) GROUP BY levels`,
  `SELECT substr(board, 3, 3) AS lv, SUM(ai_beaten) AS n FROM boards WHERE board >= 'L:' AND board < 'L;' GROUP BY lv`,
  `SELECT n, cleared FROM boards WHERE board >= '${dailyPrefix}' AND board < '${dailyPrefix};'`,
  `SELECT k, n FROM counters WHERE k IN ('req:${jstDate}', 'wr:${jstDate}')`,
].join(';\n');

const query = () => execFileSync('npx', ['wrangler', 'd1', 'execute', 'yurapita', '--remote', '--json', '--command', SQL], {
  cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 << 20,
});
let raw;
try {
  raw = query();
} catch {
  // One retry: the first call after a while sometimes fails while wrangler refreshes its OAuth token.
  try {
    raw = query();
  } catch (e) {
    process.stderr.write(`stats: wrangler failed (logged in? npx wrangler login)\n${e.stdout ?? ''}${e.stderr ?? e.message}\n`);
    process.exit(1);
  }
}
const res = JSON.parse(raw);
if (!Array.isArray(res)) {
  process.stderr.write(`stats: unexpected wrangler output\n${raw}\n`);
  process.exit(1);
}
const rows = (i) => res[i]?.results ?? [];
const one = (i) => Number(rows(i)[0]?.n ?? 0);
const byLevel = (i) => Object.fromEntries(rows(i).map((r) => [r.lv, Number(r.n)]));

const clears = byLevel(3);
const aiBeaten = byLevel(5);
const dist = Object.fromEntries(rows(4).map((r) => [Number(r.levels), Number(r.n)]));
const allClear = LEVEL_IDS.length;
const atLeast = (k) => Object.entries(dist).reduce((s, [lv, n]) => s + (Number(lv) >= k ? n : 0), 0);
const daily = rows(6)[0] ?? null;
const counter = Object.fromEntries(rows(7).map((r) => [r.k.split(':')[0], Number(r.n)]));

const out = {
  at: new Date(now + JST_MS).toISOString().replace('T', ' ').slice(0, 16) + ' JST',
  devices: one(0),
  activeToday: one(1),
  newToday: one(2),
  allClear: dist[allClear] ?? 0,
  levelsCleared: dist,
  perLevel: LEVEL_IDS.map((id) => ({ level: id, cleared: clears[id] ?? 0, aiBeaten: aiBeaten[id] ?? 0 })),
  daily: daily && { day: dayIndex, players: Number(daily.n), cleared: Number(daily.cleared) },
  todayCounters: { requests: counter.req ?? null, rowsWritten: counter.wr ?? null },
};

if (asJson) {
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  process.exit(0);
}

const fmt = (n) => n.toLocaleString('ja-JP');
const pad = (s, w) => String(s).padStart(w);
const lines = [
  `ゆらしてピタッ プレイ人口（${out.at}、端末数＝ブラウザ単位の下限）`,
  '',
  `  プレイ人口（どれか1面をクリア）  ${pad(fmt(out.devices), 7)}`,
  `  今日遊んだ端末                  ${pad(fmt(out.activeToday), 7)}（うち今日はじめて記録 ${fmt(out.newToday)}。昔の記録の再送を含む）`,
  `  全 ${allClear} 面クリア                   ${pad(fmt(out.allClear), 7)}`,
  `  ${allClear - 1} 面以上 / 12 面以上 / 6 面以上   ${fmt(atLeast(allClear - 1))} / ${fmt(atLeast(12))} / ${fmt(atLeast(6))}`,
  '',
  '  面     クリア   AIに勝った',
  ...out.perLevel.map((r) => `  ${r.level}  ${pad(fmt(r.cleared), 7)}  ${pad(fmt(r.aiBeaten), 7)}`),
  '',
  out.daily ? `  今日の5球 #${out.daily.day}: 参加 ${fmt(out.daily.players)}、クリア ${fmt(out.daily.cleared)}` : '  今日の5球: まだ参加なし',
  `  今日の D1: 書き込み ${out.todayCounters.rowsWritten === null ? '-' : fmt(out.todayCounters.rowsWritten)} 行（無料枠 10 万、安全弁 5 万）` +
    `、要求 ${out.todayCounters.requests === null ? '-' : fmt(out.todayCounters.requests)} 件（Worker の自前カウンタ。実際より少なめ）`,
];
process.stdout.write(lines.join('\n') + '\n');
