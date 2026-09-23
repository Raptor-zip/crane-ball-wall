// Challenge links (GAME_DESIGN.md §7.5 3, §7.13, §11 M11). Owner: O0.
//   - round trip: clear 1-1 -> シェア -> the share text carries {origin}/#c=1-1.<replay>; a fresh browser opening that
//     link plays 1-1 with the white 「挑戦状」 ghost, and the replay in the link re-simulates (Node and browser) to
//     the original run's stateHash and time;
//   - a stale link (other levelHash) opens the level without the ghost and says so; a broken link goes to level select.
import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { encodeReplay, decodeReplay } from '../../src/sim/replay';
import { b64urlDecode, b64urlEncode } from '../../src/sim/b64';
import {
  STATUS, bot11, collectErrors, playReplay, recordToasts, shot, simulate, state, toasts, waitForApp, waitForState,
} from './helpers';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
test.describe.configure({ timeout: 180_000 });

/** A new browser context (fresh localStorage: the friend who receives the link). */
async function friend(browser: Browser, baseURL: string | undefined): Promise<Page> {
  const ctx = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: 'ja-JP' });
  return ctx.newPage();
}

test('share -> #c= link -> the challenge ghost, same stateHash', async ({ page, browser, baseURL }, info) => {
  const errors = collectErrors(page);
  const bot = bot11();
  await page.goto('/');
  await waitForApp(page);
  const r = await playReplay(page, '1-1', bot.replay);
  expect(r).toMatchObject({ status: STATUS.Success, score: bot.score, state: 'RESULTS' });

  // the share sheet shows the text that would be posted (§7.13)
  await page.locator('section.res').getByRole('button', { name: /シェア/ }).tap();
  const area = page.locator('textarea.share-text');
  await expect(area).toBeVisible();
  const text = await area.inputValue();
  info.annotations.push({ type: 'share text', description: text });
  expect(text).toContain('ゆらしてピタッ 1-1');
  expect(text).toContain((bot.score / 120).toFixed(3));
  expect(text).toContain('#ゆらピタ');
  const m = /(https?:\/\/\S+?\/#c=([^.\s]+)\.(\S+))$/.exec(text);
  expect(m, `challenge URL at the end of: ${text}`).not.toBeNull();
  const [, url, levelId, replay] = m!;
  expect(levelId).toBe('1-1');
  expect(new URL(url!).origin).toBe(new URL(page.url()).origin);
  await page.waitForTimeout(500);
  await shot(page, info, 'challenge-share-sheet');

  // the replay in the link is the run: same result and stateHash as the original, re-simulated in Node
  const orig = simulate('1-1', bot.replay);
  const link = simulate('1-1', replay!);
  expect(link.status).toBe(STATUS.Success);
  expect(link.score).toBe(orig.score);
  expect(link.stateHash).toBe(orig.stateHash);
  expect(link.stateHash).toBe(bot.stateHash);

  // a friend opens the link
  const p2 = await friend(browser, baseURL);
  const errors2 = collectErrors(p2);
  await p2.goto(url!);
  const s = await waitForApp(p2);
  expect(s.state).toBe('READY');
  expect(s.level).toBe('1-1');
  expect(s.mode).toBe('challenge');
  expect(s.ghosts).toContain('challenge');
  // when the game exposes the ghost's own stateHash (debugState().challengeHash), it must be the original's too
  const exposed = (s as unknown as { challengeHash?: number | null }).challengeHash;
  if (exposed !== undefined) expect(exposed).toBe(orig.stateHash);
  else info.annotations.push({ type: 'note', description: 'debugState().challengeHash not exposed: ghost hash checked via the link replay' });
  await p2.waitForTimeout(600);
  await shot(p2, info, 'challenge-friend-ready');

  // the friend's browser re-simulates the link replay to the same time (browser vs Node determinism)
  const r2 = await playReplay(p2, '1-1', replay!);
  expect(r2).toMatchObject({ status: STATUS.Success, score: orig.score, ticks: bot.nTicks });
  expect((await state(p2)).mode).toBe('challenge');
  await p2.close();
  expect(errors).toEqual([]);
  expect(errors2).toEqual([]);
});

test('stale and broken challenge links', async ({ browser, baseURL }, info) => {
  const bot = bot11();
  // stale: the same q sequence recorded against another levelHash
  const { h, qs } = decodeReplay(b64urlDecode(bot.replay));
  const stale = b64urlEncode(encodeReplay({ ...h, levelHash: h.levelHash === 'deadbeef' ? 'cafebabe' : 'deadbeef' }, qs));
  const p1 = await friend(browser, baseURL);
  const e1 = collectErrors(p1);
  await recordToasts(p1);
  await p1.goto(`/#c=1-1.${stale}`);
  const s1 = await waitForApp(p1);
  expect(s1.state).toBe('READY');
  expect(s1.level).toBe('1-1');
  expect(s1.ghosts).not.toContain('challenge');
  await expect.poll(() => toasts(p1)).toContain('この挑戦状は古いバージョンのものです');
  await shot(p1, info, 'challenge-stale');
  await p1.close();

  // broken replay: level select and a message, no exception
  const p2 = await friend(browser, baseURL);
  const e2 = collectErrors(p2);
  await recordToasts(p2);
  await p2.goto('/#c=1-1.@@not-a-replay@@');
  await waitForState(p2, (s) => s.state === 'LEVEL_SELECT', 'LEVEL_SELECT');
  await expect.poll(() => toasts(p2)).toContain('この挑戦状は開けませんでした');
  await shot(p2, info, 'challenge-broken');
  // unknown level id: same
  await p2.goto('about:blank');
  await p2.goto(`/#c=9-9.${bot.replay}`);
  await waitForState(p2, (s) => s.state === 'LEVEL_SELECT', 'LEVEL_SELECT (unknown level)');
  await p2.close();
  expect(e1).toEqual([]);
  expect(e2).toEqual([]);
});
