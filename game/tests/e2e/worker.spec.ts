// Worker integration (GAME_DESIGN.md §7.7-§7.9, §11 M8 / M9). Owner: O0. Playwright project "worker".
//
// beforeAll builds the production bundle (no VITE_TEST; the page is opened with ?yptest=1) into a scratch directory,
// writes a wrangler config next to it (absolute paths: the shared dist/ and .wrangler/ are never touched), applies
// migrations/ to a throw-away local D1 and starts `wrangler dev` on PW_WORKER_PORT with DEV=1. Then:
//   - GET /api/boot is 200 with the §7.7 shape and Cache-Control; GET / is the game (static assets);
//   - POST /api/submit with a 1-1 replay is accepted (rank 1); a replay with one q flipped is a mismatch, and the
//     same inputs under a second secret are a 'dup' (§7.8 step 6);
//   - in the browser: clear 1-1 -> the rank-in send at the success tick -> accepted, 「世界一！」 on the card; the
//     ranking screen shows the run as 「あなた」 (flashed); a second visitor gets the WR ghost from boot and watches
//     #1's replay from its ranking (boot's wr, re-simulated to the accepted run's stateHash, no /api/ghost);
//   - a seeded 1-1 board (100-row top, 150 counted players) and the hourly rebuild (/__scheduled): a slow clear shows
//     「世界 約N位」 and the ranking pins 「あなた 約N位」; a faster clear enters the top 100 with 「ランクイン！」 (§9.4).
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';
import { decodeReplay, encodeReplay } from '../../src/sim/replay';
import { b64urlDecode, b64urlEncode } from '../../src/sim/b64';
import { levelHash } from '../../src/sim/level';
import { levelBoardKey } from '../../src/shared/api';
import type { BoardResponse, BootResponse, SubmitResponse } from '../../src/shared/api';
import { newSecret, pidhFromSecret } from '../../src/shared/names';
import {
  GAME_DIR, STATUS, WORKER_DIR, WORKER_INSPECTOR_PORT, WORKER_PORT, altBot11, bangBang11, bot11, collectErrors, command, level,
  playReplay, readSave, shot, state, waitForApp, waitForState,
} from './helpers';

const BASE = `http://127.0.0.1:${WORKER_PORT}`;
const BIN = (name: string): string => join(GAME_DIR, 'node_modules', '.bin', name);
const KEY_11 = levelBoardKey('1-1', levelHash(level('1-1').physics));

test.describe.configure({ mode: 'serial', timeout: 120_000 });
test.use({ viewport: { width: 1280, height: 720 }, locale: 'ja-JP' });

let server: ChildProcess | null = null;
let serverLog = '';
/** The generated wrangler config and the local D1 directory (set in beforeAll; the seeding test writes through them). */
let wranglerCfg = '';
let d1State = '';
const wranglerEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1', NO_COLOR: '1' };
  delete env.VITE_TEST;
  delete env.VITE_PUBLIC_ORIGIN;
  return env;
};

/** wrangler.jsonc without comments (strings are left alone). */
function readJsonc(path: string): Record<string, unknown> {
  const src = readFileSync(path, 'utf8');
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j;
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i + 2) + 1;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1')) as Record<string, unknown>;
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): void {
  const r = spawnSync(cmd, args, { cwd: GAME_DIR, env, encoding: 'utf8', timeout: 180_000 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}):\n${r.stdout}\n${r.stderr}`);
}

test.beforeAll(async () => {
  test.setTimeout(300_000);
  rmSync(WORKER_DIR, { recursive: true, force: true });
  mkdirSync(WORKER_DIR, { recursive: true });
  const dist = join(WORKER_DIR, 'dist');
  const state = join(WORKER_DIR, 'state');
  const env: NodeJS.ProcessEnv = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1', NO_COLOR: '1' };
  delete env.VITE_TEST;
  delete env.VITE_PUBLIC_ORIGIN;

  // 1) the production bundle (the Worker serves it as static assets)
  run(BIN('vite'), ['build', '--outDir', dist, '--emptyOutDir'], env);
  expect(existsSync(join(dist, 'index.html'))).toBe(true);

  // 2) wrangler.jsonc with absolute paths, next to the build (wrangler keeps its .wrangler/ there too)
  const cfg = readJsonc(join(GAME_DIR, 'wrangler.jsonc'));
  delete cfg.$schema;
  cfg.main = join(GAME_DIR, String(cfg.main));
  (cfg.assets as Record<string, unknown>).directory = dist;
  // `--test-scheduled` answers /__scheduled from the Worker, but the SPA fallback of the assets would take it first
  const assets = cfg.assets as { run_worker_first?: string[] };
  assets.run_worker_first = [...(assets.run_worker_first ?? []), '/__scheduled'];
  for (const d of cfg.d1_databases as Record<string, unknown>[]) d.migrations_dir = join(GAME_DIR, String(d.migrations_dir ?? 'migrations'));
  const cfgPath = join(WORKER_DIR, 'wrangler.json');
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  wranglerCfg = cfgPath;
  d1State = state;

  // 3) a fresh local D1 with the migrations
  run(BIN('wrangler'), ['d1', 'migrations', 'apply', 'yurapita', '--local', '--persist-to', state, '-c', cfgPath], env);

  // 4) wrangler dev (DEV=1 as .dev.vars would give it)
  server = spawn(BIN('wrangler'), [
    'dev', '-c', cfgPath, '--local', '--persist-to', state, '--ip', '127.0.0.1', '--port', String(WORKER_PORT),
    '--inspector-port', String(WORKER_INSPECTOR_PORT), '--var', 'DEV:1', '--show-interactive-dev-session=false', '--test-scheduled',
  ], { cwd: WORKER_DIR, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout!.on('data', (b: Buffer) => { serverLog += b.toString(); });
  server.stderr!.on('data', (b: Buffer) => { serverLog += b.toString(); });
  let exited: number | null = null;
  server.on('exit', (code) => { exited = code ?? -1; });
  const t0 = Date.now();
  for (;;) {
    if (exited !== null) throw new Error(`wrangler dev exited (${exited}):\n${serverLog}`);
    if (Date.now() - t0 > 90_000) throw new Error(`wrangler dev did not answer on ${BASE}:\n${serverLog}`);
    try {
      const r = await fetch(`${BASE}/`);
      if (r.ok) break;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
});

test.afterAll(async () => {
  if (server?.pid) {
    try {
      process.kill(-server.pid, 'SIGTERM'); // wrangler and its workerd child
    } catch {
      // already gone
    }
  }
  server = null;
});

test('boot is 200 with Cache-Control, and / serves the game', async ({ request }, info) => {
  const r = await request.get(`${BASE}/api/boot?day=0`);
  expect(r.status()).toBe(200);
  expect(r.headers()['cache-control']).toBe('public, max-age=60, stale-while-revalidate=300');
  const boot = (await r.json()) as BootResponse;
  expect(boot.v).toBe(1);
  expect(boot.sim).toBe(1);
  expect(Object.keys(boot.boards)).toHaveLength(18);
  expect(boot.boards['1-1']!.key).toBe(KEY_11);
  expect(boot.daily.key).toMatch(/^D:\d{5}:[0-9a-f]{8}:s1$/);
  info.annotations.push({ type: 'boot', description: `1-1 ${JSON.stringify(boot.boards['1-1'])}` });

  const home = await request.get(`${BASE}/`);
  expect(home.status()).toBe(200);
  expect(home.headers()['content-type']).toContain('text/html');
  expect(await home.text()).toContain('<div id="app">');
  // the SPA fallback serves the game for deep links too, and /api/* never falls through to it
  expect((await request.get(`${BASE}/some/deep/link`)).status()).toBe(200);
  expect((await request.get(`${BASE}/api/nope`)).status()).toBe(404);
});

test('POST /api/submit: a run is accepted, a tampered one is a mismatch, a copy is a dup', async ({ request }) => {
  // Not the bundled fixture replay: the in-game test below posts that one from the browser, and §7.8 step 6
  // rejects a second player whose inputs copy a top-100 row. altBot11 is a slower 1-1 clear of its own.
  const alt = altBot11();
  const secret = newSecret();
  const submit = async (replay: string, t120 = alt.score, s = secret): Promise<SubmitResponse> => {
    const r = await request.post(`${BASE}/api/submit`, {
      data: { v: 1, secret: s, nameSeed: 1234, runs: [{ board: KEY_11, level: '1-1', replay, t120, device: 0 }] },
    });
    expect(r.status()).toBe(200);
    return (await r.json()) as SubmitResponse;
  };
  const ok = await submit(alt.replay);
  expect(ok.ok).toBe(true);
  expect(ok.results[0]).toMatchObject({ board: KEY_11, status: 'accepted', rank: 1 });

  const { h, qs } = decodeReplay(b64urlDecode(alt.replay));
  const bad = Int8Array.from(qs);
  bad[20] = -bad[20]!; // one q flipped: the claimed time no longer holds
  const res = await submit(b64urlEncode(encodeReplay(h, bad)));
  expect(res.results[0]).toMatchObject({ status: 'rejected', reason: 'mismatch' });

  // §7.8 step 6: the same inputs under a fresh identity are a duplicate, whatever the replay bytes look like
  const copy = await submit(alt.replay, alt.score, newSecret());
  expect(copy.results[0]).toMatchObject({ board: KEY_11, status: 'rejected', reason: 'dup' });

  const board = (await (await request.get(`${BASE}/api/board/${encodeURIComponent(KEY_11)}`)).json()) as BoardResponse;
  const me = board.top.find((row) => row[0] === pidhFromSecret(secret));
  expect(me, 'the accepted run is on the board').toBeTruthy();
  expect(me![2]).toBe(alt.score);
  expect(board.top, 'the copy did not land on the board').toHaveLength(1);
});

/**
 * Opens the game and waits until the boot made it online. The client gives /api/boot 3 s (§7.12) measured with a
 * timer; when the first frame blocks the main thread for longer (SwiftShader on a loaded machine: the synchronous
 * shader compile), that timer can win against a response that arrived long before, and the session stays offline.
 * The shader cache is warm on a reload, so a couple of reloads are allowed (and reported).
 */
async function gotoOnline(page: Page, info: TestInfo, base = BASE): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __ypLong: [number, number][] };
    w.__ypLong = [];
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) w.__ypLong.push([Math.round(e.startTime), Math.round(e.duration)]);
      }).observe({ type: 'longtask', buffered: true });
    } catch {
      // no long task timing
    }
  });
  for (let attempt = 1; ; attempt++) {
    await page.goto(`${base}/?yptest=1`);
    await waitForApp(page);
    try {
      await waitForState(page, (s) => !s.offline, 'online (boot answered)', 8000);
      if (attempt > 1) info.annotations.push({ type: 'boot', description: `online after ${attempt} page loads (first-frame stall beat the 3 s boot timer)` });
      return;
    } catch (e) {
      if (attempt < 3) continue;
      // say why: when /api/boot answered early but a long main-thread task outlasted the 3 s boot timer, the client
      // (src/net/api.ts) decided "offline" although the server was fine
      const why = await page.evaluate(() => ({
        boot: performance.getEntriesByType('resource').filter((r) => r.name.includes('/api/boot'))
          .map((r) => `${Math.round(r.startTime)}..${Math.round((r as PerformanceResourceTiming).responseEnd)} ms`),
        longTasks: (window as unknown as { __ypLong: [number, number][] }).__ypLong.filter(([, d]) => d > 500)
          .map(([t, d]) => `${t} ms +${d} ms`),
      }));
      throw new Error(`the game stayed offline: /api/boot ${why.boot.join(', ') || 'not requested'}; long tasks ${why.longTasks.join(', ') || 'none'}`, { cause: e });
    }
  }
}

test('in the game: clear 1-1 online, the rank-in send submits, the ranking shows the run', async ({ page, browser, request }, info) => {
  test.setTimeout(180_000);
  const errors = collectErrors(page);
  const bot = bot11();
  await gotoOnline(page, info);
  await expect(page.locator('.chip--offline')).toBeHidden();

  // A top-100 candidate (the 1-1 board is empty) goes out at the success tick, before the results card (rank-in, §7.9).
  const submitted = page.waitForResponse((resp) => resp.url().endsWith('/api/submit') && resp.request().method() === 'POST');
  const r = await playReplay(page, '1-1', bot.replay);
  expect(r).toMatchObject({ status: STATUS.Success, score: bot.score, state: 'RESULTS' });
  const card = page.locator('section.res');
  await expect(card.getByRole('button', { name: /ランキング/ })).toBeEnabled();
  // the server's answer lands on the card: rank 1 (the API run above is slower) -> the 世界一！ stamp (§9.4)
  await expect(card.locator('.res-rank .stamp--rank')).toContainText('世界一！', { timeout: 3000 });
  await expect(card.locator('.res-rank .sr-only')).toHaveText('世界一！ 世界1位');
  await page.waitForTimeout(700);
  await shot(page, info, 'worker-results-wr-stamp');
  const resp = await submitted;
  expect(resp.status()).toBe(200);
  const body = (await resp.json()) as SubmitResponse;
  info.annotations.push({ type: 'submit', description: JSON.stringify(body) });
  expect(body.results.find((x) => x.board === KEY_11)).toMatchObject({ status: 'accepted', rank: 1, counted: bot.score });
  await page.keyboard.press('n');
  await waitForState(page, (s) => s.state === 'READY' && s.level === '1-2', 'READY on 1-2');
  expect((await readSave(page))!.levels['1-1']!.sentSub).toBe(bot.score);

  // the ranking screen (from a results card) lists the run as mine
  await command(page, 'openLevel:1-1');
  await waitForState(page, (s) => s.state === 'READY' && s.level === '1-1', 'READY on 1-1');
  expect((await playReplay(page, '1-1', bot.replay)).state).toBe('RESULTS');
  await card.getByRole('button', { name: /ランキング/ }).click();
  const mine = page.locator('table.board tr.is-me');
  await expect(mine).toBeVisible();
  await expect(mine).toHaveClass(/is-flash/);
  await expect(mine).toContainText((bot.score / 120).toFixed(3));
  await expect(mine).toContainText('あなた');
  const pidh = (await readSave(page))!.id.pidh;
  await page.waitForTimeout(400);
  await shot(page, info, 'worker-board');

  // A second visitor: boot carries the WR (rank 1), which becomes the "AI + WR" ghost set. Boot is memoised for 30 s
  // per isolate and put in the Cache API under the request's origin (§7.7); the local Cache API of wrangler dev keeps
  // entries past their max-age, so the visitor comes in through another host name (localhost) once the memo expired.
  const base2 = `http://localhost:${WORKER_PORT}`;
  await expect.poll(async () => {
    const b = (await (await request.get(`${base2}/api/boot?day=0`)).json()) as BootResponse;
    return b.boards['1-1']?.wr ? 'wr' : 'none';
  }, { timeout: 60_000, intervals: [5000] }).toBe('wr');
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: 'ja-JP' });
  const p2 = await ctx2.newPage();
  const errors2 = collectErrors(p2);
  await gotoOnline(p2, info, base2);
  await command(p2, 'openLevel:1-1');
  await waitForState(p2, (s) => s.state === 'READY' && s.level === '1-1', 'READY on 1-1');
  let wr = false;
  for (let i = 0; i < 5 && !wr; i++) {
    await command(p2, 'ghostCycle');
    wr = (await state(p2)).ghosts.includes('wr');
  }
  expect(wr, 'the WR ghost set is available online').toBe(true);
  await p2.waitForTimeout(400);
  await shot(p2, info, 'worker-wr-ghost');

  // ... and watches #1 from the ranking of its own results card (§7.5 item 6): the replay is boot's wr (no /api/ghost),
  // re-simulated by the client to the run the Worker accepted (the Node reference's score and stateHash). (The
  // visitor's own clear copies the first player's inputs: the Worker rejects it as a dup, it never lands on the board.)
  const ghostReqs: string[] = [];
  p2.on('request', (rq) => {
    if (rq.url().includes('/api/ghost/')) ghostReqs.push(rq.url());
  });
  expect((await playReplay(p2, '1-1', bot.replay)).state).toBe('RESULTS');
  await p2.locator('section.res').getByRole('button', { name: /ランキング/ }).click();
  const watch = p2.locator('.page-head .board-wr');
  await expect(watch).toBeVisible();
  await expect(watch).toContainText((bot.score / 120).toFixed(3));
  await watch.click();
  const viewing = await waitForState(p2, (s) => s.state === 'DEMO' && s.replay !== null, 'the replay viewer on #1');
  expect(viewing.replay).toMatchObject({ key: KEY_11, rank: 1, pidh, t120: bot.score, score: bot.score, stateHash: bot.stateHash, source: 'boot', kind: 'wr' });
  await waitForState(p2, (s) => !!s.replay && s.replay.t >= (bot.score + 60) / 120 - 1e-6, 'held on the Success frame', 60_000);
  await shot(p2, info, 'worker-replay-wr');
  await p2.keyboard.press('Escape');
  await waitForState(p2, (s) => s.state === 'RESULTS' && s.replay === null, 'back to the ranking');
  expect(ghostReqs).toEqual([]);
  await ctx2.close();

  info.annotations.push({ type: 'player', description: pidh });
  expect(errors).toEqual([]);
  expect(errors2).toEqual([]);
});

/** Runs SQL against the local D1 of the running `wrangler dev` (the same --persist-to directory). */
function d1Exec(sqlFile: string): void {
  run(BIN('wrangler'), ['d1', 'execute', 'yurapita', '--local', '--persist-to', d1State, '-c', wranglerCfg, '--file', sqlFile, '--yes'], wranglerEnv());
}

test('a seeded board: 世界 約N位 on the card and on the pinned row; a faster clear gets ランクイン！', async ({ browser, request }, info) => {
  test.setTimeout(240_000);
  const slow = bangBang11(19, 12);
  const fast = bangBang11(18, 11);
  // 1) Seed 1-1: keep today's rows (the fixture's and the API run), fill the top to 100 with times below the slow
  //    clear and above the fast one, and count 150 players in plays (50 of them slower than the top 100).
  const cur = (await (await request.get(`${BASE}/api/board/${encodeURIComponent(KEY_11)}`)).json()) as BoardResponse;
  const last = cur.top[cur.top.length - 1]?.[2] ?? 235;   // (empty when this test runs alone)
  const pid = (i: number): string => (0x5eed0000 + i).toString(16).padStart(16, '0');
  const seededTop: [string, number, number, number, number, number][] = [];
  for (let i = 0; seededTop.length + cur.top.length < 100; i++) seededTop.push([pid(i), i, last + 5 + 3 * i, -1, 0, 1790000000000 + i]);
  const top = [...cur.top, ...seededTop];
  const cutoff = top[99]![2];
  expect(fast.score).toBeLessThan(cutoff);
  expect(slow.score).toBeGreaterThan(cutoff);
  const slower = Array.from({ length: 50 }, (_, i) => cutoff + 10 + Math.round(((1100 - cutoff) * i) / 49));
  const plays = [...seededTop.map((r) => [r[0], r[2]] as const), ...slower.map((t, i) => [pid(1000 + i), t] as const)];
  const sql = [
    // (the boards row exists after the tests above; alone, this test creates it)
    `INSERT INTO boards (board, ver, top, n, par, updated) VALUES ('${KEY_11}', 1, '${JSON.stringify(top)}', ${top.length}, ${cur.par}, 1790000000000) ` +
      `ON CONFLICT (board) DO UPDATE SET top = excluded.top, ver = boards.ver + 1;`,
    `INSERT INTO plays (board, pidh, created, t120) VALUES ${plays.map(([p, t], i) => `('${KEY_11}', '${p}', ${1790000000000 + i}, ${t})`).join(', ')};`,
    `INSERT INTO counters (k, n) VALUES ('hist:next', 0) ON CONFLICT (k) DO UPDATE SET n = 0;`,
  ].join('\n');
  const sqlFile = join(WORKER_DIR, 'seed-rank.sql');
  writeFileSync(sqlFile, sql);
  d1Exec(sqlFile);

  // 2) The hourly histogram rebuild (worker/hist.ts), then boot carries the histogram once the 30 s memo is gone.
  const logAt = serverLog.length;
  const sched = await fetch(`${BASE}/__scheduled?cron=7+*+*+*+*`);
  expect(sched.status).toBe(200);
  await expect.poll(() => /"evt":"hist-rebuild"[^\n]*/.exec(serverLog.slice(logAt))?.[0] ?? '', { timeout: 20_000 }).toMatch(/"written":/);
  await expect.poll(async () => {
    const b = (await (await request.get(`${BASE}/api/boot?day=0`)).json()) as BootResponse;
    const h = b.boards['1-1']?.hist ?? [];
    return `${h.reduce((a, x) => a + x, 0)} ${b.boards['1-1']?.cutoff}`;
  }, { timeout: 60_000, intervals: [3000] }).toBe(`${plays.length + cur.top.length} ${cutoff}`);

  // 3) A new player clears slowly: outside the top 100, the card says 世界 約N位 from the boot histogram.
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ja-JP', hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await gotoOnline(page, info);
  expect((await playReplay(page, '1-1', slow.replay)).state).toBe('RESULTS');
  const card = page.locator('section.res');
  const row = card.locator('.res-rank');
  await expect(row).toContainText(/世界 約\d+位/);
  const n = Number(/約(\d+)位/.exec((await row.textContent()) ?? '')![1]);
  expect(n).toBeGreaterThan(100);
  expect(n).toBeLessThanOrEqual(plays.length + cur.top.length + 1);
  await expect(row).toContainText(/上位[\d.]+%/);
  await page.waitForTimeout(900);
  await shot(page, info, 'worker-results-estimate');

  // 4) The ranking: the whole top 100, a 「⋮」 row, and 「あなた 約N位」 pinned (not sent yet: 未送信).
  await card.getByRole('button', { name: /ランキング/ }).click();
  await expect(page.locator('table.board tbody tr[data-rank]')).toHaveCount(100);
  await expect(page.locator('table.board tr.is-gap')).toHaveCount(1);
  const pin = page.locator('.board-pin');
  await expect(pin).toBeVisible();
  await expect(pin.locator('.board-pin-rank')).toHaveText(`約${n}位`);
  await expect(pin).toContainText('あなた');
  await expect(pin).toContainText((slow.score / 120).toFixed(3));
  await expect(pin).toContainText('未送信');
  await page.waitForTimeout(300);
  await shot(page, info, 'worker-board-pinned');

  // 5) A faster clear can enter the top 100: sent at the success tick, answered on the card with ランクイン！
  await page.locator('.page-head .btn--icon').first().click();
  await command(page, 'openLevel:1-1');
  await waitForState(page, (s) => s.state === 'READY' && s.level === '1-1', 'READY on 1-1');
  const submitted = page.waitForResponse((resp) => resp.url().endsWith('/api/submit') && resp.request().method() === 'POST');
  expect((await playReplay(page, '1-1', fast.replay)).state).toBe('RESULTS');
  const body = (await (await submitted).json()) as SubmitResponse;
  const mineRes = body.results.find((x) => x.board === KEY_11)!;
  info.annotations.push({ type: 'rank-in', description: JSON.stringify(mineRes) });
  expect(mineRes).toMatchObject({ status: 'accepted' });
  expect(mineRes.rank!).toBeLessThanOrEqual(100);
  await expect(card.locator('.res-rank .stamp--rank')).toContainText('ランクイン！', { timeout: 5000 });
  await expect(card.locator('.res-rank .stamp--rank')).toContainText(`${mineRes.rank}位`);
  await page.waitForTimeout(900);
  await shot(page, info, 'worker-results-rank-in');

  // 6) The ranking (fetched past every cache after the accepted run) has my row, centred and flashed; no pinned row.
  await card.getByRole('button', { name: /ランキング/ }).click();
  const mine = page.locator('table.board tr.is-me');
  await expect(mine).toBeVisible();
  await expect(mine).toHaveClass(/is-flash/);
  await expect(mine).toHaveAttribute('data-rank', String(mineRes.rank));
  await expect(page.locator('.board-pin')).toHaveCount(0);
  await page.waitForTimeout(1200);   // the smooth scroll
  const off = await page.evaluate(() => {
    const r = document.querySelector('table.board tr.is-me')!.getBoundingClientRect();
    const b = document.querySelector('.page-body')!.getBoundingClientRect();
    return Math.abs((r.top + r.bottom) / 2 - (b.top + b.bottom) / 2);
  });
  expect(off).toBeLessThan(40);
  await shot(page, info, 'worker-board-me');
  await ctx.close();
  expect(errors).toEqual([]);
});
