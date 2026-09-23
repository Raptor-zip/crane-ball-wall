// Worker integration (GAME_DESIGN.md §7.7-§7.9, §11 M8 / M9). Owner: O0. Playwright project "worker".
//
// beforeAll builds the production bundle (no VITE_TEST; the page is opened with ?yptest=1) into a scratch directory,
// writes a wrangler config next to it (absolute paths: the shared dist/ and .wrangler/ are never touched), applies
// migrations/ to a throw-away local D1 and starts `wrangler dev` on PW_WORKER_PORT with DEV=1. Then:
//   - GET /api/boot is 200 with the §7.7 shape and Cache-Control; GET / is the game (static assets);
//   - POST /api/submit with a 1-1 replay is accepted (rank 1); a replay with one q flipped is a mismatch, and the
//     same inputs under a second secret are a 'dup' (§7.8 step 6);
//   - in the browser: clear 1-1 -> N (next level) -> the outbox submits -> accepted; the ranking screen shows the
//     run as 「あなた」; a second visitor gets the WR ghost from boot.
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
  GAME_DIR, STATUS, WORKER_DIR, WORKER_INSPECTOR_PORT, WORKER_PORT, altBot11, bot11, collectErrors, command, level,
  playReplay, readSave, shot, state, waitForApp, waitForState,
} from './helpers';

const BASE = `http://127.0.0.1:${WORKER_PORT}`;
const BIN = (name: string): string => join(GAME_DIR, 'node_modules', '.bin', name);
const KEY_11 = levelBoardKey('1-1', levelHash(level('1-1').physics));

test.describe.configure({ mode: 'serial', timeout: 120_000 });
test.use({ viewport: { width: 1280, height: 720 }, locale: 'ja-JP' });

let server: ChildProcess | null = null;
let serverLog = '';

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
  for (const d of cfg.d1_databases as Record<string, unknown>[]) d.migrations_dir = join(GAME_DIR, String(d.migrations_dir ?? 'migrations'));
  const cfgPath = join(WORKER_DIR, 'wrangler.json');
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  // 3) a fresh local D1 with the migrations
  run(BIN('wrangler'), ['d1', 'migrations', 'apply', 'yurapita', '--local', '--persist-to', state, '-c', cfgPath], env);

  // 4) wrangler dev (DEV=1 as .dev.vars would give it)
  server = spawn(BIN('wrangler'), [
    'dev', '-c', cfgPath, '--local', '--persist-to', state, '--ip', '127.0.0.1', '--port', String(WORKER_PORT),
    '--inspector-port', String(WORKER_INSPECTOR_PORT), '--var', 'DEV:1', '--show-interactive-dev-session=false',
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

test('in the game: clear 1-1 online, the outbox submits, the ranking shows the run', async ({ page, browser, request }, info) => {
  test.setTimeout(180_000);
  const errors = collectErrors(page);
  const bot = bot11();
  await gotoOnline(page, info);
  await expect(page.locator('.chip--offline')).toBeHidden();

  const r = await playReplay(page, '1-1', bot.replay);
  expect(r).toMatchObject({ status: STATUS.Success, score: bot.score, state: 'RESULTS' });
  const card = page.locator('section.res');
  await expect(card.getByRole('button', { name: /ランキング/ })).toBeEnabled();

  // leaving the results (N: the next level) flushes the outbox (§7.9)
  const submitted = page.waitForResponse((resp) => resp.url().endsWith('/api/submit') && resp.request().method() === 'POST');
  await page.keyboard.press('n');
  await waitForState(page, (s) => s.state === 'READY' && s.level === '1-2', 'READY on 1-2');
  const resp = await submitted;
  expect(resp.status()).toBe(200);
  const body = (await resp.json()) as SubmitResponse;
  info.annotations.push({ type: 'submit', description: JSON.stringify(body) });
  expect(body.results.find((x) => x.board === KEY_11)).toMatchObject({ status: 'accepted' });

  // the ranking screen (from a results card) lists the run as mine
  await command(page, 'openLevel:1-1');
  await waitForState(page, (s) => s.state === 'READY' && s.level === '1-1', 'READY on 1-1');
  expect((await playReplay(page, '1-1', bot.replay)).state).toBe('RESULTS');
  await card.getByRole('button', { name: /ランキング/ }).click();
  const mine = page.locator('table.board tr.is-me');
  await expect(mine).toBeVisible();
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
  await ctx2.close();

  info.annotations.push({ type: 'player', description: pidh });
  expect(errors).toEqual([]);
  expect(errors2).toEqual([]);
});
