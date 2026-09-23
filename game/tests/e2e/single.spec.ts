// Single-HTML build (GAME_DESIGN.md §10.7 bullet 6, §7.12). Owner: O0.
// file://<dist-single>/index.html?yptest=1: boots with no network but Google Fonts, completes 1-1 through
// playReplay (the same session code as the web build), shows the results card and keeps the PB in localStorage.
import { existsSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  DIST_SINGLE, SINGLE_ALLOWED_HOSTS, SINGLE_HTML_URL, STATUS, bot11, collectErrors, playReplay, readSave, shot, waitForApp,
} from './helpers';

test.use({ viewport: { width: 1280, height: 720 } });
test.describe.configure({ timeout: 60_000 });

test('file:// single HTML completes 1-1 with only Google Fonts requests', async ({ page }, info) => {
  test.skip(!existsSync(`${DIST_SINGLE}/index.html`), `no single build at ${DIST_SINGLE} (npm run build:single)`);
  const errors = collectErrors(page);
  const requests: string[] = [];
  const external: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.protocol === 'data:' || u.protocol === 'blob:') return;
    requests.push(`${u.protocol}//${u.host}${u.pathname}`);
    if (u.protocol === 'file:') {
      if (!u.pathname.endsWith('/index.html')) external.push(r.url()); // nothing else is loaded from disk
      return;
    }
    if (!SINGLE_ALLOWED_HOSTS.includes(u.host)) external.push(r.url());
  });

  await page.goto(SINGLE_HTML_URL);
  const s0 = await waitForApp(page);
  expect(s0.state).toBe('TITLE');
  expect(s0.offline).toBe(true); // VITE_NET=off: the API is never used
  await expect(page.locator('#app canvas')).toBeVisible();
  await page.waitForTimeout(500);
  await shot(page, info, 'single-title');

  const bot = bot11();
  const r = await playReplay(page, '1-1', bot.replay);
  expect(r).toMatchObject({ status: STATUS.Success, score: bot.score, state: 'RESULTS' });
  await expect(page.locator('section.res')).toBeVisible();
  await expect(page.locator('section.res .res-time')).toContainText((bot.score / 120).toFixed(3));
  expect((await readSave(page))!.levels['1-1']!.bestSub).toBe(bot.score);
  await page.waitForTimeout(900);
  await shot(page, info, 'single-results');

  info.annotations.push({ type: 'requests', description: [...new Set(requests)].join(', ') });
  expect(external, 'requests outside Google Fonts').toEqual([]);
  expect(requests.some((u) => u.includes('/api/'))).toBe(false);
  expect(errors).toEqual([]);
});
