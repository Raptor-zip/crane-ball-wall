// Core play loop (GAME_DESIGN.md §10.7 bullets 2-4, §9.4). Owner: O0.
//   - 1-1 with the bot's success replay -> SUCCESS_BEAT -> the results card, and the PB (time + replay) in localStorage;
//   - 1-2 driven into the knee-high wall -> CRASH_BEAT (about 0.7 s) -> READY by itself, and a key press ends the beat at once;
//   - retry (R key, ↺ button and the hook command) -> READY with the clock at 0 in < 100 ms, measured in the page.
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  STATUS, armInputProbe, bot11, collectErrors, command, playReplay, readInputProbe, readSave, shot, simulate, softwareGl,
  startStateTrace, state, stopStateTrace, waitForApp, waitForState, wallCrashReplay12,
} from './helpers';
import type { InputProbe } from './helpers';

test.use({ viewport: { width: 1280, height: 720 } });
test.describe.configure({ timeout: 180_000 });

async function openLevel(page: Page, id: string): Promise<void> {
  await command(page, `openLevel:${id}`);
  const s = await waitForState(page, (x) => x.state === 'READY' && x.level === id, `READY on ${id}`);
  expect(s.ticks).toBe(0);
}

test('1-1: the success replay shows the results card and stores the PB', async ({ page }, info) => {
  const errors = collectErrors(page);
  const bot = bot11();
  const ref = simulate('1-1', bot.replay);
  expect(ref.status).toBe(STATUS.Success);
  expect(ref.score).toBe(bot.score);

  await page.goto('/');
  await waitForApp(page);
  expect(await readSave(page).then((s) => s?.levels['1-1']?.bestSub ?? null)).toBeNull();

  await startStateTrace(page);
  const r = await playReplay(page, '1-1', bot.replay);
  const trace = await stopStateTrace(page);
  expect(r.status).toBe(STATUS.Success);
  expect(r.score).toBe(bot.score); // the browser's session agrees with Node's simulateReplay
  expect(r.state).toBe('RESULTS');
  const states = trace.map(([, s]) => s);
  expect(states).toContain('SUCCESS_BEAT');
  expect(states[states.length - 1]).toBe('RESULTS');

  // the card: time with 3 decimals, stamp, medal, buttons
  const card = page.locator('section.res');
  await expect(card).toBeVisible();
  await expect(card.locator('.res-time')).toContainText((bot.score / 120).toFixed(3));
  await expect(card.getByRole('button', { name: /もう一回/ })).toBeVisible();
  await expect(card.getByRole('button', { name: /次へ/ })).toBeVisible();
  await page.waitForTimeout(900); // medal / stamp animations
  await shot(page, info, 'play-1-1-results');

  const s = await state(page);
  expect(s.last?.ok).toBe(true);
  expect(s.bestSub).toBe(bot.score);

  // PB in localStorage: time and a replay that re-simulates to the same result
  const save = await readSave(page);
  const p = save!.levels['1-1']!;
  expect(p.cleared).toBe(true);
  expect(p.bestSub).toBe(bot.score);
  expect(p.bestReplay).toBeTruthy();
  const again = simulate('1-1', p.bestReplay!);
  expect(again.score).toBe(bot.score);
  expect(again.stateHash).toBe(bot.stateHash);

  // the PB survives a reload (it is really persisted, not only in memory)
  await page.reload();
  await waitForApp(page);
  expect((await readSave(page))!.levels['1-1']!.bestSub).toBe(bot.score);
  expect(errors).toEqual([]);
});

test('1-2: hitting the wall plays CRASH_BEAT and returns to READY', async ({ page }, info) => {
  const errors = collectErrors(page);
  const crash = wallCrashReplay12();
  await page.goto('/');
  await waitForApp(page);
  await openLevel(page, '1-2');
  // the AI ghost runs next to the player from the second level on (1-1's very first attempt hides it, §5.1)
  expect((await state(page)).ghosts).toContain('ai');
  // The first user gesture creates the AudioContext (§9.6), 70-110 ms in headless Chromium: not part of a retry.
  await page.keyboard.press('x');
  expect((await state(page)).state).toBe('READY');

  // 1) the beat runs out by itself (picture taken inside the beat)
  await startStateTrace(page);
  const run = playReplay(page, '1-2', crash.b64);
  await waitForState(page, (x) => x.state === 'CRASH_BEAT', 'CRASH_BEAT', 5000);
  await shot(page, info, 'play-1-2-crash-beat');
  const r = await run;
  const trace = await stopStateTrace(page);
  expect(r.status).toBe(STATUS.Crash);
  expect(r.ticks).toBe(crash.ticks);
  expect(r.state).toBe('READY');
  const iBeat = trace.findIndex(([, s]) => s === 'CRASH_BEAT');
  expect(iBeat, `trace ${JSON.stringify(trace)}`).toBeGreaterThanOrEqual(0);
  expect(trace[iBeat + 1]?.[1]).toBe('READY');
  const beatMs = trace[iBeat + 1]![0] - trace[iBeat]![0];
  info.annotations.push({ type: 'crash beat', description: `${beatMs.toFixed(0)} ms` });
  // 0.7 s of game time (§2.1). Frames are long on software GL, so wall time only has a loose upper bound.
  expect(beatMs).toBeGreaterThan(500);
  expect(beatMs).toBeLessThan(3000);
  const s = await state(page);
  expect(s.ticks).toBe(0);
  expect(s.last).toMatchObject({ ok: false, status: STATUS.Crash });
  const prog = (await readSave(page))!.levels['1-2']!;
  expect(prog.attempts).toBe(1);
  expect(prog.fails).toBe(1);
  expect(prog.cleared).toBe(false);

  // 2) any input ends the beat at once (§2.1 4). The key is dispatched inside the page one frame into the beat:
  //    a key sent through the test runner can arrive after the 0.7 s beat on a loaded machine.
  const k = await page.evaluate(async (b64) => {
    const st = (): { state: string; ticks: number } => {
      const s = window.__YP_TEST__!.state() as { state: string; ticks: number };
      return { state: s.state, ticks: s.ticks };
    };
    void window.__YP_TEST__!.playReplay('1-2', b64); // steps the whole run synchronously: the beat has begun
    await new Promise((r) => requestAnimationFrame(r));
    const before = st().state;
    const t0 = performance.now();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', code: 'KeyX', bubbles: true }));
    const t1 = performance.now();
    const after = st();
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'x', code: 'KeyX', bubbles: true }));
    return { before, after, ms: t1 - t0 };
  }, crash.b64);
  expect(k.before).toBe('CRASH_BEAT');
  expect(k.after).toEqual({ state: 'READY', ticks: 0 });
  expect(k.ms).toBeLessThan(100);
  expect(errors).toEqual([]);
});

test('1-2: three crashes in a row start the AI demo once (§2.1 middle loop)', async ({ page }, info) => {
  const errors = collectErrors(page);
  const crash = wallCrashReplay12();
  await page.goto('/');
  await waitForApp(page);
  await openLevel(page, '1-2');
  const after: string[] = [];
  for (let i = 1; i <= 3; i++) after.push((await playReplay(page, '1-2', crash.b64)).state);
  expect(after).toEqual(['READY', 'READY', 'DEMO']);
  const d = await state(page);
  expect(d.mode).toBe('demo');
  expect(d.ghosts).toEqual(['calm']);
  await page.waitForTimeout(800);
  await shot(page, info, 'play-1-2-auto-demo');
  // skippable with any input once the 0.35 s guard is over
  await page.keyboard.press('x');
  await waitForState(page, (x) => x.state === 'READY', 'READY after skipping the demo');
  expect((await readSave(page))!.levels['1-2']!.demoShown).toBe(true);
  // once per level: three more crashes stay on READY
  const again: string[] = [];
  for (let i = 1; i <= 3; i++) again.push((await playReplay(page, '1-2', crash.b64)).state);
  expect(again).toEqual(['READY', 'READY', 'READY']);
  // and hint 1 opened after 3 failures (§5.3: 3 / 6 / 10)
  const p = (await readSave(page))!.levels['1-2']!;
  expect(p.fails).toBe(6);
  expect((await state(page)).hint).toBeTruthy();
  await expect(page.locator('.yp')).toContainText((await state(page)).hint!.slice(0, 12));
  await shot(page, info, 'play-1-2-hint');
  expect(errors).toEqual([]);
});

/**
 * Presses R (or clicks ↺ / calls the hook) during a run started with real keyboard input.
 *   handlerMs - input reaches the page -> the game's handler returned with the state READY: the retry itself
 *               (the session resets in place, nothing is rebuilt: §9.4 "< 100 ms");
 *   frameMs   - input -> the first animation frame in READY (adds the wait for the frame being drawn).
 */
async function retryOnce(page: Page, how: 'key' | 'button' | 'command', minTicks: number): Promise<InputProbe> {
  await page.keyboard.down('ArrowRight');
  await waitForState(page, (x) => x.state === 'RUNNING' && x.ticks > minTicks, 'RUNNING');
  await page.keyboard.up('ArrowRight');
  expect((await state(page)).state).toBe('RUNNING');
  const kind = how === 'key' ? 'keydown' : how === 'button' ? 'click' : 'command';
  await armInputProbe(page, { kind, want: 'READY', button: 'リトライ', command: 'retry' });
  if (how === 'key') await page.keyboard.press('r');
  if (how === 'button') await page.getByRole('button', { name: /リトライ/ }).click();
  return readInputProbe(page);
}

test('retry: READY in < 100 ms (key, button, command)', async ({ page }, info) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await waitForApp(page);
  const software = await softwareGl(page);
  // 1-1 has no wall: the run cannot end by itself (crash) between the key presses and the retry
  await openLevel(page, '1-1');
  const results: string[] = [];
  let counted = 0;
  // early and later mid-run retries: those before 60 ticks (1 s) are false starts that do not count (§7.4)
  const plan = [['key', 10], ['button', 10], ['command', 75], ['key', 75]] as const;
  for (const [how, minTicks] of plan) {
    const t = await retryOnce(page, how, minTicks);
    expect(t.stateAtInput).toBe('RUNNING');
    if (t.ticksAtInput >= 60) counted++;
    results.push(`${how}: handled ${t.handlerMs.toFixed(1)} ms, first READY frame ${t.frameMs.toFixed(0)} ms (at tick ${t.ticksAtInput})`);
    expect(t.after, `${how}: READY right after the input was handled`).toEqual({ state: 'READY', ticks: 0 });
    expect(t.handlerMs, `${how}: input handled -> READY`).toBeLessThan(100);
    if (!software) expect(t.frameMs, `${how}: input -> first READY frame`).toBeLessThan(100);
    await expect(page.locator('.hud-clock')).toHaveText('0.000');
  }
  const note = `${software ? 'software GL' : 'hardware GL'}; ${results.join('; ')}`;
  info.annotations.push({ type: 'retry', description: note });
  console.log(`[retry] ${note}`);
  const prog = (await readSave(page))!.levels['1-1']!;
  expect(prog.attempts).toBe(counted);
  expect(prog.fails).toBe(counted);
  await shot(page, info, 'play-retry-ready');
  expect(errors).toEqual([]);
});

test('practice (D3): holding R rewinds 5 s and the run goes on; a short R press retries', async ({ page }, info) => {
  const errors = collectErrors(page);
  // steady assist (§3.7) off: it would settle the ball on the pad and end the run
  await page.addInitScript(() => {
    if (!localStorage.getItem('yurapita:v1')) localStorage.setItem('yurapita:v1', JSON.stringify({ v: 1, settings: { lang: 'ja', steady: false } }));
  });
  await page.goto('/');
  await waitForApp(page);
  expect((await readSave(page))?.settings.steady).toBe(false);
  await openLevel(page, '1-1'); // no wall: nothing can end the run by itself
  await command(page, 'practice');
  await waitForState(page, (x) => x.state === 'READY' && x.mode === 'practice', 'practice READY');
  expect((await state(page)).timeScale).toBeCloseTo(0.5, 5);
  // a real run (x0.5): nudge the trolley, then let it go on past 5 s of game time
  await page.keyboard.down('ArrowRight');
  await waitForState(page, (x) => x.state === 'RUNNING' && x.ticks > 20, 'RUNNING');
  await page.keyboard.up('ArrowRight');
  await waitForState(page, (x) => x.ticks > 330, 'past 5.5 s of game time', 30_000);
  const before = (await state(page)).ticks;
  // R held for 300 ms rewinds (and repeats every 300 ms while held): release after the first one
  await page.keyboard.down('KeyR');
  await page.waitForTimeout(450);
  await page.keyboard.up('KeyR');
  const after = await state(page);
  info.annotations.push({ type: 'rewind', description: `ticks ${before} -> ${after.ticks}` });
  expect(after.state).toBe('RUNNING'); // no retry on the release of a long press
  expect(after.ticks).toBeLessThan(before - 200);
  expect(after.ticks).toBeGreaterThan(before - 300 - 60);
  await shot(page, info, 'play-practice-rewind');
  // a short R press is still a retry (on key-up in practice mode)
  await page.keyboard.press('KeyR');
  const r = await waitForState(page, (x) => x.state === 'READY', 'READY after a short R');
  expect(r.ticks).toBe(0);
  expect(r.mode).toBe('practice');
  expect(errors).toEqual([]);
});
