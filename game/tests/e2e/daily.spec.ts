// Today's 5 balls (GAME_DESIGN.md §7.5 2, §11 M11 "5 球の消費"). Owner: O0.
// Real keyboard input on today's daily level:
//   - opening the level, or retrying before any input, uses no ball; the first input of a run uses one;
//   - mid-run retries and crashes are red; after the 5th ball the daily screen (share) comes back with 5 red balls,
//     the share text has the 5 squares, and further runs are practice that use nothing;
//   - the rack survives a reload.
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { collectErrors, command, readSave, recordToasts, shot, state, toasts, waitForApp, waitForState } from './helpers';
import type { YpState } from './helpers';

test.use({ viewport: { width: 1280, height: 720 } });
test.describe.configure({ timeout: 300_000 });

const used = (s: YpState): number => (s.dailyBalls ?? []).filter((b) => b !== null).length;

/** Starts a run with → and ends it with R (or lets a crash end it). Returns the state it lands in. */
async function spendBall(page: Page): Promise<YpState> {
  await page.keyboard.down('ArrowRight');
  await waitForState(page, (s) => s.state !== 'READY' || s.ticks > 0, 'the run started');
  await page.waitForTimeout(150);
  await page.keyboard.up('ArrowRight');
  if ((await state(page)).state === 'RUNNING') await page.keyboard.press('r');
  return waitForState(page, (s) => s.state === 'READY' || s.state === 'DAILY_HUB', 'READY or the daily screen', 15_000);
}

test('five balls: first input consumes, retry / crash are red, then practice', async ({ page }, info) => {
  const errors = collectErrors(page);
  await recordToasts(page);
  await page.goto('/');
  await waitForApp(page);

  await command(page, 'openDaily');
  await waitForState(page, (s) => s.state === 'DAILY_HUB', 'DAILY_HUB');
  const hub = page.locator('.page', { hasText: '今日の5球' });
  await expect(hub).toBeVisible();
  await expect(hub.getByRole('button', { name: /シェア/ })).toBeDisabled();
  await page.waitForTimeout(400);
  await shot(page, info, 'daily-hub-fresh');

  await hub.getByRole('button', { name: /あそぶ/ }).click();
  const s0 = await waitForState(page, (s) => s.state === 'READY', 'READY on the daily level');
  expect(s0.level).toMatch(/^d:\d+$/);
  expect(s0.mode).toBe('daily');
  expect(s0.dailyBalls).toEqual([null, null, null, null, null]);
  await page.waitForTimeout(300);
  await shot(page, info, 'daily-ready');

  // no input, no ball: a retry in READY changes nothing
  await page.keyboard.press('r');
  await page.waitForTimeout(200);
  expect(used(await state(page))).toBe(0);

  const trail: string[] = [];
  for (let i = 1; i <= 5; i++) {
    const s = await spendBall(page);
    trail.push(`${i}: ${s.state} ${JSON.stringify(s.dailyBalls)}`);
    const balls = (await readSave(page))!.daily.balls;
    expect(balls.filter((b) => b !== null).length, `balls after run ${i}`).toBe(i);
    expect(balls.filter((b) => b !== null).every((b) => b === 'fail'), 'unfinished runs are red').toBe(true);
    if (i < 5) expect(s.state).toBe('READY');
    else expect(s.state).toBe('DAILY_HUB');
  }
  info.annotations.push({ type: 'balls', description: trail.join(' | ') });
  await expect.poll(() => toasts(page)).toContain('今日の5球を使い切りました');

  // the daily screen after the 5th ball: sharing is open, the text has 5 red squares
  await expect(hub.getByRole('button', { name: /シェア/ })).toBeEnabled();
  await page.waitForTimeout(400);
  await shot(page, info, 'daily-hub-done');
  await hub.getByRole('button', { name: /シェア/ }).click();
  const text = await page.locator('textarea.share-text').inputValue();
  info.annotations.push({ type: 'share text', description: text });
  expect(text).toContain('ゆらしてピタッ 今日の5球 #');
  expect(text).toContain('\u{1F7E5}'.repeat(5));
  await shot(page, info, 'daily-share');
  await page.keyboard.press('Escape');

  // from now on: practice, no ball is used
  await hub.getByRole('button', { name: /練習する/ }).click();
  await waitForState(page, (s) => s.state === 'READY', 'READY (practice)');
  await expect.poll(() => toasts(page)).toContain('練習モード（記録なし）');
  const p = await spendBall(page);
  expect(p.state).toBe('READY'); // not back to the daily screen
  expect((await readSave(page))!.daily.balls).toEqual(['fail', 'fail', 'fail', 'fail', 'fail']);

  // the rack is saved
  await page.reload();
  await waitForApp(page);
  expect((await readSave(page))!.daily.balls).toEqual(['fail', 'fail', 'fail', 'fail', 'fail']);
  expect(errors).toEqual([]);
});
