// Offline play (GAME_DESIGN.md §10.7 bullet 5, §7.12). Owner: O0.
// Every /api/* request is aborted (a dead network or an API outage): the game still boots, is playable with touch,
// records the PB locally and shows the 「オフライン」 chip; the ranking button stays hidden.
import { expect, test } from '@playwright/test';
import {
  STATUS, bot11, centreOf, collectErrors, playReplay, readSave, shot, touchDrag, waitForApp, waitForState,
} from './helpers';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

test('/api/* blocked: playable, 「オフライン」 chip', async ({ page, context }, info) => {
  const blocked: string[] = [];
  await context.route('**/api/**', (route) => {
    blocked.push(route.request().url());
    return route.abort('internetdisconnected');
  });
  // the aborted requests themselves are logged by Chromium as failed loads: expected here
  const errors = collectErrors(page, [/\/api\//, /ERR_INTERNET_DISCONNECTED/]);
  await page.goto('/');
  await waitForApp(page);
  await expect.poll(() => blocked.length, { message: 'the client tried GET /api/boot' }).toBeGreaterThan(0);
  expect(blocked[0]).toContain('/api/boot');
  await waitForState(page, (s) => s.offline, 'offline');

  // title -> 1-1 with a tap
  await page.getByRole('button', { name: /あそぶ/ }).tap();
  await waitForState(page, (s) => s.state === 'READY' && s.level === '1-1', 'READY on 1-1');
  const chip = page.locator('.chip--offline');
  await expect(chip).toBeVisible();
  await expect(chip).toContainText('オフライン');
  await page.waitForTimeout(300);
  await shot(page, info, 'offline-390x844-ready');

  // playable with a finger on the deck: the run starts
  const deck = await centreOf(page, '.deck-surface');
  await touchDrag(page, { x: deck.x - deck.w * 0.3, y: deck.y }, { x: deck.x + deck.w * 0.2, y: deck.y }, { holdMs: 200 });
  const run = await waitForState(page, (s) => s.state === 'RUNNING' || s.ticks > 0, 'the drag started a run');
  expect(run.level).toBe('1-1');
  await shot(page, info, 'offline-390x844-running');

  // and a full clear works offline: results card without the ranking button, PB saved locally
  const bot = bot11();
  const r = await playReplay(page, '1-1', bot.replay);
  expect(r.status).toBe(STATUS.Success);
  expect(r.state).toBe('RESULTS');
  const card = page.locator('section.res');
  await expect(card).toBeVisible();
  await expect(card.getByRole('button', { name: /ランキング/ })).toHaveCount(0);
  await expect(card.getByRole('button', { name: /シェア/ })).toBeVisible();
  expect((await readSave(page))!.levels['1-1']!.bestSub).toBe(bot.score);
  await page.waitForTimeout(900);
  await shot(page, info, 'offline-390x844-results');

  // nothing but /api/boot was attempted: no submit while offline (the outbox keeps the run)
  expect(blocked.filter((u) => !u.includes('/api/boot'))).toEqual([]);
  expect(errors).toEqual([]);
});
