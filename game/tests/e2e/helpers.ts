// Shared E2E helpers (GAME_DESIGN.md §10.7). Owner: O0.
//
// The game exposes window.__YP_TEST__ (src/core/debug.ts) in dist-test/ and in any build opened with ?yptest=1:
//   playReplay(levelId, b64), state() (AppDebugState), command(c).
// Replays are built here with the real simulation (src/sim), so the expected outcomes are computed, not hard-coded.
import { mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';
import type { AppDebugState, PlayReplayResult } from '../../src/core/app';
import type { LevelDef, LevelsFile } from '../../src/sim/level';
import { levelHash } from '../../src/sim/level';
import { decodeReplay, encodeReplay, simulateReplay } from '../../src/sim/replay';
import type { ReplayResult } from '../../src/sim/replay';
import { b64urlDecode, b64urlEncode } from '../../src/sim/b64';
import { SIM_VERSION } from '../../src/sim/constants';
import { bangBang, runBot } from '../sim/bots';

export const GAME_DIR = resolve(fileURLToPath(new URL('../..', import.meta.url)));

/** Single-HTML build directory (vite.config.ts and tools/check-single.mjs read the same variable). */
export const DIST_SINGLE = resolve(GAME_DIR, process.env.YP_DIST_SINGLE || 'dist-single');
/** file:// URL of the single-HTML build with the test hook enabled. */
export const SINGLE_HTML_URL = `${pathToFileURL(join(DIST_SINGLE, 'index.html')).href}?yptest=1`;

/** Hosts the single HTML may contact (§7.12: Google Fonts only). */
export const SINGLE_ALLOWED_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

// ------------------------------------------------------------------------------------------------ worker.spec.ts

const PREVIEW_PORT = Number(process.env.PW_PREVIEW_PORT ?? 4273);
/** wrangler dev port of worker.spec.ts (own range so that it never meets the preview / dev servers). */
export const WORKER_PORT = Number(process.env.PW_WORKER_PORT ?? PREVIEW_PORT + 4000);
export const WORKER_INSPECTOR_PORT = Number(process.env.PW_WORKER_INSPECTOR_PORT ?? WORKER_PORT + 1000);
/** Scratch directory of worker.spec.ts: production build, generated wrangler config, local D1. */
export const WORKER_DIR = resolve(process.env.YP_E2E_WORKER_DIR || join(tmpdir(), `yp-e2e-worker-${WORKER_PORT}`));

// ------------------------------------------------------------------------------------------------ errors

/**
 * Collects console errors and uncaught page errors. A failed Google Fonts download (no network) is not a game
 * error; `ignore` drops further expected messages (e.g. the aborted /api/* requests of the offline test).
 */
export function collectErrors(page: Page, ignore: RegExp[] = []): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const where = m.location()?.url ?? '';
    let host = '';
    try {
      host = new URL(where).host;
    } catch {
      host = '';
    }
    if (SINGLE_ALLOWED_HOSTS.includes(host)) return;
    const text = `console: ${m.text()}${where ? ` @ ${where}` : ''}`;
    if (ignore.some((r) => r.test(text))) return;
    errors.push(text);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

// ------------------------------------------------------------------------------------------------ the test hook

export type YpState = AppDebugState;

/** Waits until the app has started (the hook is installed and the state machine left BOOT). */
export async function waitForApp(page: Page, timeout = 15_000): Promise<YpState> {
  await page.waitForFunction(() => {
    const h = window.__YP_TEST__;
    if (!h) return false;
    try {
      return (h.state() as { state: string }).state !== 'BOOT';
    } catch {
      return false;
    }
  }, null, { timeout });
  return state(page);
}

export function state(page: Page): Promise<YpState> {
  return page.evaluate(() => window.__YP_TEST__!.state() as never);
}

export async function command(page: Page, c: string): Promise<void> {
  await page.evaluate((cmd) => window.__YP_TEST__!.command(cmd), c);
}

export function playReplay(page: Page, levelId: string, b64: string): Promise<PlayReplayResult> {
  return page.evaluate(([id, r]) => window.__YP_TEST__!.playReplay(id!, r!) as Promise<never>, [levelId, b64]);
}

/** Polls state() until pred holds. */
export async function waitForState(page: Page, pred: (s: YpState) => boolean, what: string, timeout = 10_000): Promise<YpState> {
  let last: YpState | null = null;
  await expect.poll(async () => {
    last = await state(page);
    return pred(last);
  }, { message: `waiting for ${what}`, timeout, intervals: [20, 50, 100] }).toBe(true);
  return last!;
}

/**
 * Records every state change with its rAF time (performance.now()) in window.__ypTrace, so that short states
 * (CRASH_BEAT 0.7 s, SUCCESS_BEAT 0.75 s) and their durations can be checked after the fact.
 */
export async function startStateTrace(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __ypTrace: [number, string][]; __ypTraceOn: boolean };
    w.__ypTrace = [];
    w.__ypTraceOn = true;
    let last = '';
    const tick = (): void => {
      if (!w.__ypTraceOn) return;
      const s = (window.__YP_TEST__!.state() as { state: string }).state;
      if (s !== last) {
        w.__ypTrace.push([performance.now(), s]);
        last = s;
      }
      requestAnimationFrame(tick);
    };
    tick();
  });
}

export async function stopStateTrace(page: Page): Promise<[number, string][]> {
  return page.evaluate(() => {
    const w = window as unknown as { __ypTrace: [number, string][]; __ypTraceOn: boolean };
    w.__ypTraceOn = false;
    return w.__ypTrace;
  });
}

export interface InputProbe {
  /** From the moment the input reached the page's JS to the end of the game's handler for it. */
  handlerMs: number;
  /** From the same moment to the first animation frame in which the state was `want` (includes waiting for the
   *  frame that was being drawn when the input came: long on software GL). */
  frameMs: number;
  /** State and run ticks right after the handler. */
  after: { state: string; ticks: number };
  /** State and run ticks when the input arrived. */
  stateAtInput: string;
  ticksAtInput: number;
}

/**
 * Arms an in-page probe around the next input of one kind, so that latencies are measured without the CDP
 * round trips of the test runner:
 *   'keydown'  - the game listens on window (bubble): a capture listener runs before it, a later bubble listener after it;
 *   'click'    - on the button whose aria-label matches `button` (a listener added to the same button runs after the UI's);
 *   'command'  - window.__YP_TEST__.command(c) right away.
 * Then perform the input and call readInputProbe().
 */
export async function armInputProbe(
  page: Page, o: { kind: 'keydown' | 'click' | 'command'; want: string | string[]; button?: string; command?: string },
): Promise<void> {
  await page.evaluate((opt) => {
    type Rec = { t0: number; t1: number; frame: number; after: { state: string; ticks: number } | null; stateAtInput: string; ticksAtInput: number };
    const rec: Rec = { t0: -1, t1: -1, frame: -1, after: null, stateAtInput: '', ticksAtInput: -1 };
    (window as unknown as { __ypProbe: Rec }).__ypProbe = rec;
    const st = (): { state: string; ticks: number } => {
      const s = window.__YP_TEST__!.state() as { state: string; ticks: number };
      return { state: s.state, ticks: s.ticks };
    };
    const begin = (): void => {
      if (rec.t0 >= 0) return;
      rec.t0 = performance.now();
      const s = st();
      rec.stateAtInput = s.state;
      rec.ticksAtInput = s.ticks;
    };
    const end = (): void => {
      if (rec.t0 < 0 || rec.t1 >= 0) return;
      rec.t1 = performance.now();
      rec.after = st();
    };
    const wanted = Array.isArray(opt.want) ? opt.want : [opt.want];
    const poll = (): void => {
      if (rec.t0 >= 0 && wanted.includes(st().state)) {
        rec.frame = performance.now();
        return;
      }
      requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
    if (opt.kind === 'keydown') {
      window.addEventListener('keydown', begin, { capture: true, once: true });
      window.addEventListener('keydown', end, { once: true });
    } else if (opt.kind === 'click') {
      const re = new RegExp(opt.button ?? '.');
      const btn = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => re.test(b.getAttribute('aria-label') ?? b.textContent ?? ''));
      if (!btn) throw new Error(`armInputProbe: no button ${opt.button}`);
      window.addEventListener('click', begin, { capture: true, once: true });
      btn.addEventListener('click', end, { once: true });
    } else {
      begin();
      window.__YP_TEST__!.command(opt.command ?? 'retry');
      end();
    }
  }, o);
}

export async function readInputProbe(page: Page, timeout = 5000): Promise<InputProbe> {
  try {
    await page.waitForFunction(() => {
      const r = (window as unknown as { __ypProbe?: { t1: number; frame: number } }).__ypProbe;
      return !!r && r.t1 >= 0 && r.frame >= 0;
    }, null, { timeout });
  } catch (e) {
    const r = await page.evaluate(() => JSON.stringify({
      probe: (window as unknown as { __ypProbe?: unknown }).__ypProbe,
      state: window.__YP_TEST__?.state(),
      active: document.activeElement?.outerHTML.slice(0, 120),
    }));
    throw new Error(`input probe incomplete: ${r}`, { cause: e });
  }
  const r = await page.evaluate(() => (window as unknown as {
    __ypProbe: { t0: number; t1: number; frame: number; after: { state: string; ticks: number }; stateAtInput: string; ticksAtInput: number };
  }).__ypProbe);
  return { handlerMs: r.t1 - r.t0, frameMs: r.frame - r.t0, after: r.after, stateAtInput: r.stateAtInput, ticksAtInput: r.ticksAtInput };
}

/**
 * Records the text of every toast the UI shows (.toast elements), from the first moment of the page on. Toasts
 * shown at boot can be gone again by the time a slow first frame is over, so they are collected, not looked up.
 * Call before page.goto(); read with toasts(page).
 */
export async function recordToasts(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __ypToasts: string[] };
    w.__ypToasts = [];
    const seen = new WeakSet<Node>();
    const scan = (n: Node): void => {
      if (!(n instanceof HTMLElement)) return;
      const found = n.matches('.toast') ? [n] : [...n.querySelectorAll('.toast')];
      for (const el of found) {
        if (seen.has(el)) continue;
        seen.add(el);
        w.__ypToasts.push((el.textContent ?? '').trim());
      }
    };
    new MutationObserver((list) => {
      for (const m of list) m.addedNodes.forEach(scan);
    }).observe(document, { childList: true, subtree: true });
  });
}

export function toasts(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __ypToasts?: string[] }).__ypToasts ?? []);
}

/**
 * The game's save (localStorage 'yurapita:v1'), or null. The store writes with a 250 ms throttle (src/store/save.ts),
 * so the read waits on a 300 ms timer inside the page first: timers fire in expiry order, so a pending write has
 * happened by then, however long the page's frames are.
 */
export async function readSave(page: Page): Promise<SaveLike | null> {
  const raw = await page.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 300));
    return localStorage.getItem('yurapita:v1');
  });
  return raw ? (JSON.parse(raw) as SaveLike) : null;
}

export interface SaveLike {
  v: 1;
  id: { secret: string; pidh: string; nameSeed: number };
  settings: { lang: string; muted: boolean; ghostSet: number; aiLine: boolean | null } & Record<string, unknown>;
  levels: Record<string, { cleared: boolean; attempts: number; fails: number; bestSub: number | null; bestReplay: string | null } & Record<string, unknown>>;
  daily: { dayIndex: number; balls: (string | null)[]; bestSub: number | null } & Record<string, unknown>;
}

// ------------------------------------------------------------------------------------------------ touch

/**
 * A one-finger drag with real touch events (CDP Input.dispatchTouchEvent; the page needs hasTouch). Chromium turns
 * them into pointer events of pointerType 'touch', exactly like a phone.
 */
export async function touchDrag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, o: { steps?: number; stepMs?: number; holdMs?: number } = {}): Promise<void> {
  const steps = o.steps ?? 12;
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y, id: 1 }] });
    for (let i = 1; i <= steps; i++) {
      const f = i / steps;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + (to.x - from.x) * f, y: from.y + (to.y - from.y) * f, id: 1 }] });
      await page.waitForTimeout(o.stepMs ?? 16);
    }
    if (o.holdMs) await page.waitForTimeout(o.holdMs);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

/** Centre of an element's box (CSS px). */
export async function centreOf(page: Page, selector: string): Promise<{ x: number; y: number; w: number; h: number }> {
  const b = await page.locator(selector).first().boundingBox();
  if (!b) throw new Error(`no box for ${selector}`);
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height };
}

// ------------------------------------------------------------------------------------------------ environment

/** The page's WebGL renderer string (WEBGL_debug_renderer_info), '' when unavailable. */
export function glRenderer(page: Page): Promise<string> {
  return page.evaluate(() => {
    try {
      const c = document.createElement('canvas').getContext('webgl2');
      const ext = c?.getExtension('WEBGL_debug_renderer_info');
      const r = ext && c ? String(c.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
      c?.getExtension('WEBGL_lose_context')?.loseContext();
      return r;
    } catch {
      return '';
    }
  });
}

/**
 * True when WebGL runs in software (SwiftShader / llvmpipe: headless Chromium without a GPU). Frame times there are
 * 5-50x a phone's, so frame-bound budgets (first paint, input -> next frame) are only enforced on hardware GL.
 */
export async function softwareGl(page: Page): Promise<boolean> {
  return /swiftshader|llvmpipe|softpipe|software/i.test(await glRenderer(page));
}

// ------------------------------------------------------------------------------------------------ screenshots

/** Saves a screenshot under <outputDir>/e2e-shots/<name>.png (kept for the report; the directory is per run). */
export async function shot(page: Page, info: TestInfo, name: string): Promise<string> {
  const dir = join(info.project.outputDir, 'e2e-shots');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.png`);
  await page.screenshot({ path });
  return path;
}

// ------------------------------------------------------------------------------------------------ replays

const LEVELS = (JSON.parse(readFileSync(join(GAME_DIR, 'src/data/levels.json'), 'utf8')) as LevelsFile).levels;

export function level(id: string): LevelDef {
  const l = LEVELS.find((x) => x.id === id);
  if (!l) throw new Error(`no level ${id}`);
  return l;
}

/** b64url replay of a q sequence on a campaign level (device 0, no flags), exactly as the game encodes it. */
export function makeReplay(levelId: string, qs: Int8Array): string {
  const l = level(levelId);
  return b64urlEncode(encodeReplay({ fmt: 1, sim: SIM_VERSION, levelHash: levelHash(l.physics), device: 0, flags: 0, nTicks: qs.length }, qs));
}

/** Re-simulates a b64url replay in Node (the reference for stateHash / score). */
export function simulate(levelId: string, b64: string): ReplayResult & { levelHash: string; nTicks: number } {
  const l = level(levelId);
  const { h, qs } = decodeReplay(b64urlDecode(b64));
  return { ...simulateReplay(l.physics, qs), levelHash: h.levelHash, nTicks: h.nTicks };
}

interface BotFixture { levelId: string; levelHash: string; replay: string; score: number; stateHash: number; nTicks: number }

/** tests/fixtures/bot_1-1_success.json (O1): a replay that clears 1-1. */
export function bot11(): BotFixture {
  return JSON.parse(readFileSync(join(GAME_DIR, 'tests/fixtures/bot_1-1_success.json'), 'utf8')) as BotFixture;
}

/**
 * A *second*, slower 1-1 clear with inputs of its own: the same bang-bang family as the fixture but with a
 * longer brake (17, 13 instead of 17, 11), so the whole q sequence differs. The Worker rejects a run whose
 * inputs copy another player's top-100 row (§7.8 step 6, worker/dup.ts), so a test that posts a run under its
 * own secret and later has the browser post the fixture replay needs two different runs. Checked against the
 * real simulation here: Success on the last tick, and slower than the fixture, so the fixture stays rank 1.
 */
export function altBot11(): { replay: string; score: number; ticks: number } {
  const phys = level('1-1').physics;
  const qs = runBot(phys, bangBang(17, 13)(phys), 600);
  const r = simulateReplay(phys, qs);
  const fixture = bot11();
  if (r.status !== STATUS.Success || r.score === null || r.ticks !== qs.length) {
    throw new Error(`alt 1-1 bot does not clear on its last tick: ${JSON.stringify(r)}`);
  }
  if (r.score <= fixture.score) throw new Error(`alt 1-1 bot (${r.score}) must be slower than the fixture (${fixture.score})`);
  return { replay: makeReplay('1-1', qs), score: r.score, ticks: qs.length };
}

/** Status codes of src/sim/run.ts (a const enum there). */
export const STATUS = { Ready: 0, Running: 1, Success: 2, Crash: 3, Timeout: 4 } as const;

/**
 * A replay that drives the ball into 1-2's knee-high wall: a gentle constant push (q = +20) keeps the swing small,
 * so the hanging ball meets the wall face (checked against the simulation before it is used).
 */
export function wallCrashReplay12(): { b64: string; ticks: number } {
  const qs = new Int8Array(90).fill(20);
  const b64 = makeReplay('1-2', qs);
  const r = simulate('1-2', b64);
  if (r.status !== STATUS.Crash || !r.crash || r.crash.wall !== 0) throw new Error(`1-2 crash replay does not hit wall 0: ${JSON.stringify(r)}`);
  return { b64, ticks: r.ticks };
}
