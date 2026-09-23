// Key-less devices (GAME_DESIGN.md §10.7 bullet 7, §3.3 "G / H / F1 / M without keys"). Owner: O0.
// 390x844 with touch only (no keyboard event is sent): a finger starts the game and a run, and the ghost set,
// the AI line, the science notes and mute are all reachable from the ⏸ menu and from the results card.
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import {
  STATUS, bot11, centreOf, collectErrors, playReplay, readSave, shot, state, touchDrag, waitForApp, waitForState,
} from './helpers';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
test.describe.configure({ timeout: 180_000 });

/** Taps and checks the target is a real touch target (>= 44 px, §3.5) that is not covered by something else. */
async function tapTarget(page: Page, loc: Locator): Promise<void> {
  await loc.scrollIntoViewIfNeeded();
  const b = await loc.boundingBox();
  expect(b, 'visible target').not.toBeNull();
  expect(Math.min(b!.width, b!.height), 'touch target size').toBeGreaterThanOrEqual(43.5);
  await loc.tap();
}

async function noKeyboard(page: Page): Promise<string[]> {
  const keys: string[] = [];
  await page.exposeFunction('__ypKey', (k: string) => keys.push(k));
  await page.addInitScript(() => {
    window.addEventListener('keydown', (e) => (window as unknown as { __ypKey(k: string): void }).__ypKey(e.key), { capture: true });
  });
  return keys;
}

test('touch only: ghosts, AI line, notes and mute are reachable', async ({ page }, info) => {
  const errors = collectErrors(page);
  const keys = await noKeyboard(page);
  await page.goto('/');
  await waitForApp(page);

  // title -> 1-1 by a tap on あそぶ
  await tapTarget(page, page.getByRole('button', { name: /あそぶ/ }));
  await waitForState(page, (s) => s.state === 'READY' && s.level === '1-1', 'READY on 1-1');

  // a finger on the deck starts the run; ↺ brings it back
  const deck = await centreOf(page, '.deck-surface');
  await touchDrag(page, { x: deck.x - deck.w * 0.3, y: deck.y }, { x: deck.x - deck.w * 0.1, y: deck.y });
  await waitForState(page, (s) => s.ticks > 0, 'the drag started a run');
  await tapTarget(page, page.getByRole('button', { name: /リトライ/ }));
  await waitForState(page, (s) => s.state === 'READY' && s.ticks === 0, 'READY after ↺');

  // ⏸ -> the pause menu
  await tapTarget(page, page.getByRole('button', { name: /ポーズ/ }));
  await waitForState(page, (s) => s.state === 'PAUSED', 'PAUSED');
  const menu = page.getByRole('dialog', { name: 'ポーズ' });
  await expect(menu).toBeVisible();
  await page.waitForTimeout(300);
  await shot(page, info, 'touch-390x844-pause');

  // ghost set: cycles through the sets that exist offline (WR / rival need the server) and back
  const ghostBtn = menu.getByRole('button', { name: /ゴースト/ });
  const seen: number[] = [(await state(page)).ghostSet];
  for (let i = 0; i < 3; i++) {
    await tapTarget(page, ghostBtn);
    seen.push((await state(page)).ghostSet);
  }
  expect(new Set(seen).size, `ghost sets ${seen.join(' -> ')}`).toBeGreaterThanOrEqual(3);
  expect(seen[seen.length - 1]).toBe(seen[0]);
  // settings are written to localStorage shortly after the change (the store batches writes)
  await expect.poll(async () => (await readSave(page))!.settings.ghostSet).toBe(seen[0]);
  await expect(ghostBtn).toContainText(/AI＋自己ベスト|AIだけ|なし/);

  // AI line: toggles (aria-pressed and the saved setting)
  const lineBtn = menu.getByRole('button', { name: /AIのライン/ });
  const line0 = await lineBtn.getAttribute('aria-pressed');
  await tapTarget(page, lineBtn);
  await expect(lineBtn).toHaveAttribute('aria-pressed', line0 === 'true' ? 'false' : 'true');
  await expect.poll(async () => (await readSave(page))!.settings.aiLine).toBe(line0 !== 'true');

  // mute: on, saved
  const muteBtn = menu.getByRole('button', { name: /ミュート/ });
  await expect(muteBtn).toHaveAttribute('aria-pressed', 'false');
  await tapTarget(page, muteBtn);
  await expect(muteBtn).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await readSave(page))!.settings.muted).toBe(true);

  // science notes: open, look, back to the menu
  await tapTarget(page, menu.getByRole('button', { name: /理科ノート/ }));
  const notes = page.locator('.page-title', { hasText: '理科ノート' });
  await expect(notes).toBeVisible();
  await page.waitForTimeout(300);
  await shot(page, info, 'touch-390x844-notes');
  await tapTarget(page, page.getByRole('button', { name: 'もどる' }).first());
  await expect(page.getByRole('dialog', { name: 'ポーズ' })).toBeVisible();

  // resume by tap
  await tapTarget(page, page.getByRole('dialog', { name: 'ポーズ' }).getByRole('button', { name: /再開/ }));
  await waitForState(page, (s) => s.state === 'READY', 'READY after 再開');

  // the results card has the same four without keys (G / H / ? / M row)
  const r = await playReplay(page, '1-1', bot11().replay);
  expect(r.status).toBe(STATUS.Success);
  const keysRow = page.getByRole('group', { name: 'その他の操作' });
  await keysRow.scrollIntoViewIfNeeded();
  await expect(keysRow).toBeVisible();
  const resGhost = keysRow.getByRole('button', { name: /ゴースト/ });
  const g0 = (await state(page)).ghostSet;
  await tapTarget(page, resGhost);
  expect((await state(page)).ghostSet).not.toBe(g0);
  const resMute = keysRow.getByRole('button', { name: /ミュート/ });
  await expect(resMute).toHaveAttribute('aria-pressed', 'true');
  await tapTarget(page, resMute);
  await expect(resMute).toHaveAttribute('aria-pressed', 'false');
  await expect(keysRow.getByRole('button', { name: /AIのライン/ })).toBeVisible();
  await expect(keysRow.getByRole('button', { name: /理科ノート/ })).toBeVisible();
  await page.waitForTimeout(600);
  await shot(page, info, 'touch-390x844-results-keys');

  expect(keys, 'no key events: touch only').toEqual([]);
  expect(errors).toEqual([]);
});
