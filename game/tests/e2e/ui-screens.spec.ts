// UI screens (GAME_DESIGN.md §11 M6): every screen of dev/ui-demo.html in ja and en at 390x844 and 1280x720,
// the 1200x630 share card, no console errors, nothing clipped sideways, touch targets >= 44 px. Owner: O7.
// Runs in the Playwright "demo" project (vite dev server). Screenshots: <outputDir>/ui-screens/ (PW_OUTPUT_DIR).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { collectErrors } from './helpers';
import { TALL_FRAME_K } from '../../src/ui/layout';

/** Screenshot directory of the running test: <project outputDir>/ui-screens (follows PW_OUTPUT_DIR). */
function OUT(): string {
  const dir = join(test.info().project.outputDir, 'ui-screens');
  mkdirSync(dir, { recursive: true });
  return dir;
}

// The dev server is shared with other work in progress: a hot reload in the middle of a test is not a UI failure.
test.describe.configure({ retries: 2 });

const SCREENS = [
  'title', 'select', 'briefing', 'hud', 'hud-1-1', 'hud-run', 'hud-egg', 'hud-daily', 'hud-daily-ready', 'hud-hold', 'hud-success', 'hud-crash',
  'hud-practice', 'pause', 'pause-practice', 'results', 'results-fail', 'results-crown', 'results-practice', 'share', 'demo', 'board', 'daily',
  'settings', 'about', 'notes',
] as const;
const VIEWPORTS = [
  { width: 390, height: 844, touch: true },
  { width: 1280, height: 720, touch: false },
] as const;
const LANGS = ['ja', 'en'] as const;

async function open(page: Page, query: string): Promise<void> {
  await page.goto(`/dev/ui-demo.html?${query}`);
  await page.waitForFunction(() => window.__UI_DEMO__?.ready === true, null, { timeout: 20_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
}

/** Visible buttons that stick out of the viewport sideways (inside horizontal scrollers is fine). */
async function sidewaysClipped(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const W = window.innerWidth;
    const bad: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('.yp button, .yp .chip, .yp .sheet')) {
      if (el.closest('.wpages, .wtabs, [hidden]')) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === 'hidden') continue;
      if (r.left < -1 || r.right > W + 1) bad.push(`${el.className} "${(el.textContent ?? '').trim().slice(0, 24)}" [${Math.round(r.left)}..${Math.round(r.right)}]`);
    }
    return bad;
  });
}

/** Visible buttons smaller than 44 px in either direction (§3.5). */
async function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const bad: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('.yp button')) {
      if (el.closest('[hidden]')) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      if (Math.min(r.width, r.height) < 43.5) bad.push(`${el.className} "${(el.textContent ?? '').trim().slice(0, 20)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    return bad;
  });
}

for (const vp of VIEWPORTS) {
  test.describe(`${vp.width}x${vp.height}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.touch });
    for (const lang of LANGS) {
      for (const screen of SCREENS) {
        test(`${lang} ${screen}`, async ({ page }) => {
          const errors = collectErrors(page);
          await open(page, `screen=${screen}&lang=${lang}&still=1`);
          if (screen === 'share') await page.waitForSelector('.share-prev canvas', { timeout: 10_000 });
          await page.screenshot({ path: `${OUT()}/${lang}-${vp.width}x${vp.height}-${screen}.png` });
          expect(errors).toEqual([]);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
          expect(await sidewaysClipped(page)).toEqual([]);
          if (vp.touch) expect(await smallTargets(page)).toEqual([]);
        });
      }
    }
  });
}

type R = { left: number; top: number; right: number; bottom: number };
const hit = (a: R, b: R): boolean => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
const rects = (page: Page, sel: string): Promise<R[]> => page.evaluate((s) => [...document.querySelectorAll<HTMLElement>(s)]
  .filter((e) => e.offsetWidth > 0 && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden')
  .map((e) => {
    const r = e.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }), sel);

// Small phones (D10): the tall HUD never runs off the side, from the very first frame, in both languages.
test.describe('320x640 (small phone, tall)', () => {
  test.use({ viewport: { width: 320, height: 640 }, hasTouch: true });
  for (const lang of LANGS) {
    for (const screen of ['hud', 'hud-1-1', 'hud-run', 'hud-egg', 'hud-daily', 'hud-daily-ready', 'hud-practice', 'pause-practice', 'results', 'results-fail'] as const) {
      test(`${lang} ${screen}`, async ({ page }) => {
        const errors = collectErrors(page);
        await open(page, `screen=${screen}&lang=${lang}&still=1`);
        await page.screenshot({ path: `${OUT()}/${lang}-320x640-${screen}.png` });
        expect(errors).toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        expect(await sidewaysClipped(page)).toEqual([]);
        expect(await smallTargets(page)).toEqual([]);
        // Nothing in the status row overlaps (it compacts to icon chips instead).
        const row = await rects(page, '.hud-status .chip, .hud-status .hud-rack, .hud-status .hud-tension');
        for (let i = 0; i < row.length; i++) for (let j = i + 1; j < row.length; j++) expect(hit(row[i]!, row[j]!), `${i}/${j}`).toBe(false);
      });
    }
  }
});

test.describe('tall HUD (D10) at 390x844', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('the dock ends at hudTop, the play area starts there, nothing of the HUD sits on the deck', async ({ page }) => {
    await open(page, 'screen=hud-run&lang=ja&still=1');
    const l = await page.evaluate(() => window.__UI_DEMO__!.layout());
    expect(l.kind).toBe('tall');
    const dock = (await rects(page, '.hud-dock'))[0]!;
    expect(Math.abs(dock.bottom - l.hudTop)).toBeLessThanOrEqual(1);
    for (const r of await rects(page, '.hud-dock .hud-board, .hud-dock .hud-status, .hud-band')) expect(r.bottom).toBeLessThanOrEqual(l.hudTop + 1);
    // The play area is sized for a 2.0-2.3 m window (TALL_FRAME_K w / W px for the camera frame).
    const win = (TALL_FRAME_K * l.w) / (l.scene.h - l.hudTop);
    expect(win).toBeGreaterThanOrEqual(2.0);
    expect(win).toBeLessThanOrEqual(2.3);
  });

  test('daily READY: the READY marker is on the deck (not squeezed by the rack), the hint box is not on the deck', async ({ page }) => {
    await open(page, 'screen=hud-daily-ready&lang=ja&still=1');
    const l = await page.evaluate(() => window.__UI_DEMO__!.layout());
    const ready = (await rects(page, '.deck-ready'))[0]!;
    const surface = (await rects(page, '.deck-surface'))[0]!;
    expect(ready.top).toBeGreaterThanOrEqual(surface.top);
    // Above the fine band (bottom third of the surface).
    expect(ready.bottom).toBeLessThanOrEqual(surface.top + (surface.bottom - surface.top) * (2 / 3) + 1);
    const rack = (await rects(page, '.hud-rack'))[0]!;
    expect(hit(rack, ready)).toBe(false);
    const hint = (await rects(page, '.hud-hint'))[0]!;
    expect(hint.bottom).toBeLessThanOrEqual(l.deck!.y);
    expect(hint.bottom).toBeLessThanOrEqual(l.hudTop + 1);
    expect(await page.locator('.hud-hint').textContent()).not.toBe('');
  });

  test('near-miss label: beside the wall, inside the play area, off the ball', async ({ page }) => {
    await open(page, 'screen=hud-run&lang=ja&still=1');
    const l = await page.evaluate(() => window.__UI_DEMO__!.layout());
    const pop = (await rects(page, '.pop--near .pop-in'))[0]!;
    expect(pop.left).toBeGreaterThanOrEqual(0);
    expect(pop.right).toBeLessThanOrEqual(l.w);
    expect(pop.top).toBeGreaterThanOrEqual(l.hudTop);
    expect(pop.bottom).toBeLessThanOrEqual(l.deck!.y);
  });

  test('HUD toasts sit over the mini rail, never on the drag surface', async ({ page }) => {
    await open(page, 'screen=hud&lang=ja&still=1&toasts=2');
    const surface = (await rects(page, '.deck-surface'))[0]!;
    const toasts = await rects(page, '.toast');
    expect(toasts.length).toBe(2);
    for (const t of toasts) expect(t.bottom).toBeLessThanOrEqual(surface.top + 1);
  });
});

// Toasts (tricks, badges, unlocks) never cover a card's buttons: they go to the free side or wait until it closes.
test.describe('toasts vs cards', () => {
  for (const vp of [{ width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1280, height: 720 }] as const) {
    for (const screen of ['results', 'results-fail', 'pause'] as const) {
      test(`${vp.width}x${vp.height} ${screen}`, async ({ page }) => {
        await page.setViewportSize(vp);
        await open(page, `screen=${screen}&lang=ja&still=1&toasts=3`);
        await page.screenshot({ path: `${OUT()}/ja-${vp.width}x${vp.height}-${screen}-toasts.png` });
        const cards = await rects(page, '.yp-layer .sheet');
        const buttons = await rects(page, '.yp-layer .sheet button');
        expect(cards.length).toBeGreaterThan(0);
        const check = async (): Promise<number> => {
          const toasts = await rects(page, '.toast');
          const banners = await rects(page, '.pop--banner .pop-in');
          for (const t of toasts) {
            for (const b of buttons) expect(hit(t, b)).toBe(false);
            for (const c of cards) expect(hit(t, c)).toBe(false);
            // The PB banner of the run (over the card, next to it) keeps its room too.
            for (const b of banners) expect(hit(t, b)).toBe(false);
          }
          return toasts.length;
        };
        await check();
        // Where there is room they show right away, or once the PB banner is gone (the rest wait for a free slot).
        if (!(vp.height === 390 && screen === 'pause')) await expect.poll(check, { timeout: 6_000 }).toBeGreaterThan(0);
      });
    }
  }
});

test.describe('landscape phone 844x390 (wide, short)', () => {
  test.use({ viewport: { width: 844, height: 390 }, hasTouch: true });
  for (const screen of ['title', 'hud-run', 'pause', 'results', 'results-fail', 'share', 'briefing', 'select', 'settings'] as const) {
    test(`ja ${screen}`, async ({ page }) => {
      const errors = collectErrors(page);
      await open(page, `screen=${screen}&lang=ja&still=1`);
      if (screen === 'share') await page.waitForSelector('.share-prev canvas', { timeout: 10_000 });
      await page.screenshot({ path: `${OUT()}/ja-844x390-${screen}.png` });
      expect(errors).toEqual([]);
      expect(await sidewaysClipped(page)).toEqual([]);
      expect(await smallTargets(page)).toEqual([]);
      // The main choices must be on screen without scrolling.
      const offscreen = await page.evaluate(() => {
        const H = window.innerHeight;
        const sel = '.res-foot .btn, .pause-grid .btn, .title-play, .card-foot .btn';
        return [...document.querySelectorAll<HTMLElement>(sel)].filter((b) => {
          const r = b.getBoundingClientRect();
          return r.height > 0 && (r.top < 0 || r.bottom > H + 1);
        }).map((b) => (b.textContent ?? '').trim());
      });
      expect(offscreen).toEqual([]);
    });
  }
});

test.describe('near-miss label in landscape (844x390)', () => {
  test.use({ viewport: { width: 844, height: 390 }, hasTouch: true });
  test('stays below the gantry beam and the ghost tags, inside the view', async ({ page }) => {
    await open(page, 'screen=hud-run&lang=ja&still=1');
    const beamY = await page.evaluate(() => window.__UI_DEMO__!.toScreen(1, 1.30).y);
    const pop = (await rects(page, '.pop--near .pop-in'))[0]!;
    expect(pop.top).toBeGreaterThanOrEqual(beamY);
    expect(pop.right).toBeLessThanOrEqual(844);
    expect(pop.left).toBeGreaterThanOrEqual(0);
    expect(pop.bottom).toBeLessThanOrEqual(390);
  });
});

test.describe('text size 125 %', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  for (const screen of ['select', 'results', 'pause', 'settings', 'hud-run'] as const) {
    test(`ja ${screen} at 125 %`, async ({ page }) => {
      const errors = collectErrors(page);
      await open(page, `screen=${screen}&lang=ja&still=1&ts=125`);
      expect(await page.evaluate(() => document.documentElement.classList.contains('yp-ts125'))).toBe(true);
      await page.screenshot({ path: `${OUT()}/ja-390x844-${screen}-ts125.png` });
      expect(errors).toEqual([]);
      expect(await sidewaysClipped(page)).toEqual([]);
    });
  }
});

test.describe('reduced motion (§3.5)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  test('motion off: the stamp fades in instead of the 1.6x -> 1.0x press', async ({ page }) => {
    const errors = collectErrors(page);
    await open(page, 'screen=hud-success&lang=ja&motion=off');
    expect(await page.evaluate(() => document.querySelector('.yp')!.classList.contains('yp--reduce'))).toBe(true);
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.pop--stamp .pop-in')!).animationName)).toBe('yp-fade');
    await page.screenshot({ path: `${OUT()}/ja-390x844-hud-success-reduced.png` });
    expect(errors).toEqual([]);
  });
  test('motion auto follows prefers-reduced-motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page, 'screen=hud-success&lang=ja');
    expect(await page.evaluate(() => document.querySelector('.yp')!.classList.contains('yp--reduce'))).toBe(true);
  });
});

test.describe('offline', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  for (const screen of ['daily', 'board', 'results'] as const) {
    test(`ja ${screen} offline`, async ({ page }) => {
      const errors = collectErrors(page);
      await open(page, `screen=${screen}&lang=ja&still=1&offline=1`);
      await page.waitForTimeout(150);
      await page.screenshot({ path: `${OUT()}/ja-390x844-${screen}-offline.png` });
      expect(errors).toEqual([]);
      expect(await sidewaysClipped(page)).toEqual([]);
      expect(await page.evaluate(() => /NaN|undefined|Infinity/.test(document.querySelector('.yp')!.textContent ?? ''))).toBe(false);
    });
  }
  test('board of a level without walls shows — in the gap column, never 0mm', async ({ page }) => {
    await page.goto('/dev/ui-demo.html?screen=board&level=1-1&lang=ja&still=1');
    await page.waitForFunction(() => window.__UI_DEMO__?.ready === true, null, { timeout: 20_000 });
    await page.waitForSelector('table.board td.b-num');
    const gaps = await page.locator('table.board tbody tr:not(.is-ai) td:last-child').allTextContents();
    expect(gaps.length).toBeGreaterThan(5);
    expect(gaps.every((g) => g === '—')).toBe(true);
  });

  test('pause ghost cycling skips the sets that need the network', async ({ page }) => {
    await open(page, 'screen=pause&lang=ja&offline=1');
    const ghost = page.locator('.pause-grid .btn', { hasText: 'ゴースト' }).first();
    await expect(ghost.locator('.btn-state')).toHaveText('AI＋自己ベスト');
    await ghost.click();
    await expect(ghost.locator('.btn-state')).toHaveText('AIだけ');
    await ghost.click();
    await expect(ghost.locator('.btn-state')).toHaveText('なし');
  });
});

test.describe('share card', () => {
  for (const lang of LANGS) {
    test(`${lang} PNG is 1200x630`, async ({ page }) => {
      await open(page, `screen=about&lang=${lang}`);
      const card = await page.evaluate(() => window.__UI_DEMO__!.card());
      expect(card.w).toBe(1200);
      expect(card.h).toBe(630);
      const png = Buffer.from(card.png.split(',')[1]!, 'base64');
      // PNG IHDR: width and height are big-endian at bytes 16..23.
      expect(png.subarray(1, 4).toString('ascii')).toBe('PNG');
      expect(png.readUInt32BE(16)).toBe(1200);
      expect(png.readUInt32BE(20)).toBe(630);
      writeFileSync(`${OUT()}/sharecard-${lang}.png`, png);
    });
  }
});

test.describe('keyboard', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test('pause: Escape resumes, arrows move focus, Enter activates', async ({ page }) => {
    await open(page, 'screen=pause&lang=ja');
    await expect(page.locator('.pause-grid .btn--primary')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('.pause-grid .btn').nth(1)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#demo-log')).toHaveText(/^retry/);
    await page.keyboard.press('Escape');
    await expect(page.locator('#demo-log')).toHaveText(/^resume/);
  });

  test('HUD ↺ / ⏸ pressed with the mouse give the focus back to the game', async ({ page }) => {
    await open(page, 'screen=hud&lang=ja&still=1');
    for (const i of [0, 1]) {
      if (i === 1) await open(page, 'screen=hud&lang=ja&still=1');
      await page.locator('.hud-band .hud-btn').nth(i).click();
      expect(await page.evaluate(() => !!document.activeElement?.closest('.hud-btn'))).toBe(false);
    }
  });

  test('practice: the HUD says 「R長押しで5秒もどす」 and the pause menu has 5 s rewind', async ({ page }) => {
    await open(page, 'screen=hud-practice&lang=ja&still=1');
    await expect(page.locator('.hud-rewind-hint')).toBeVisible();
    await expect(page.locator('.hud-rewind-hint')).toContainText('R長押しで5秒もどす');
    await expect(page.locator('.hud-chips .chip-btn', { hasText: '5秒もどす' })).toBeVisible();
    await open(page, 'screen=pause-practice&lang=ja');
    const rw = page.locator('.pause-grid .btn', { hasText: '5秒もどす' });
    await expect(rw).toBeVisible();
    await expect(rw.locator('.kbd')).toHaveText('R長押し');
    await rw.click();
    await expect(page.locator('#demo-log')).toHaveText(/^resume/);
  });

  test('level select: arrows walk the tiles, Enter opens a level', async ({ page }) => {
    await open(page, 'screen=select&lang=ja&world=1');
    await expect(page.locator('.tile[data-level="1-1"]')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.tile[data-level="1-2"]')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#demo-log')).toHaveText('openLevel "1-2"');
  });

  test('settings: every control is reachable with Tab and Escape goes back', async ({ page }) => {
    await open(page, 'screen=settings&lang=en');
    const reached = new Set<string>();
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press('Tab');
      reached.add(await page.evaluate(() => (document.activeElement?.textContent || document.activeElement?.getAttribute('aria-label') || '').trim()));
    }
    // Radio groups use a roving tab stop (the checked option); the others are reached with the arrow keys.
    for (const label of ['English', '100%', 'Auto', 'Speed control', 'New name']) {
      expect([...reached].some((r) => r.includes(label)), label).toBe(true);
    }
    // Escape closes the sub-screen and returns to whatever was under it.
    await page.keyboard.press('Escape');
    await expect(page.locator('.yp')).not.toHaveAttribute('data-screen', 'settings');
  });
});

test.describe('touch-only access (§3.3 key-less equivalents)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('pause offers ghosts, AI line, notes and mute by tap', async ({ page }) => {
    await open(page, 'screen=pause&lang=ja');
    for (const [label, action] of [['ゴースト', 'ghostCycle'], ['AIのライン', 'aiLine'], ['ミュート', 'mute'], ['理科ノート', 'notes']] as const) {
      await page.locator('.pause-grid .btn', { hasText: label }).first().tap();
      await expect(page.locator('#demo-log')).toHaveText(new RegExp(`^${action}`));
      if (action === 'notes') await expect(page.locator('.yp')).toHaveAttribute('data-screen', 'notes');
    }
  });

  test('results offer the same four by tap', async ({ page }) => {
    await open(page, 'screen=results&lang=ja');
    for (const action of ['ghostCycle', 'aiLine', 'mute']) {
      const idx = { ghostCycle: 0, aiLine: 1, mute: 3 }[action]!;
      await page.locator('.res-keys .btn').nth(idx).scrollIntoViewIfNeeded();
      await page.locator('.res-keys .btn').nth(idx).tap();
      await expect(page.locator('#demo-log')).toHaveText(new RegExp(`^${action}`));
    }
  });
});

// The UI inside the real game (core O3, sim O1, renderer O5) on the dev server: title -> READY -> a real successful
// run (tests/fixtures/bot_1-1_success.json) -> results -> share sheet, and the pause toggles reflecting the game.
test.describe('inside the real game', () => {
  // A fresh profile picks its language from navigator.language (§3.5): ja-JP gives the Japanese UI.
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, locale: 'ja-JP' });
  const bot = JSON.parse(readFileSync(resolve(fileURLToPath(new URL('../fixtures/bot_1-1_success.json', import.meta.url))), 'utf8')) as { replay: string };

  test('title, READY, results of a real run, share sheet, pause', async ({ page }) => {
    test.setTimeout(90_000);
    const errors = collectErrors(page);
    await page.goto('/?yptest=1');
    await page.waitForSelector('.yp[data-screen="title"]', { timeout: 30_000 });
    await page.locator('.title-play').tap();
    await page.waitForSelector('.yp[data-screen="hud"]');
    await expect(page.locator('.hud-clock')).toHaveText('0.000');
    await expect(page.locator('.hud-dock .hud-clock')).toBeVisible();
    // First visit to 1-1: the text-free onboarding hand is shown in the deck (the READY words stay away, §2.2).
    await expect(page.locator('.yp-deck .deck-hand')).toBeVisible();
    await expect(page.locator('.yp-deck .deck-ready')).toBeHidden();
    // Pointer presses on ↺ / ⏸ never keep the focus (Space / Enter must reach the game).
    expect(await page.evaluate(() => !!document.activeElement?.closest('.hud-btn'))).toBe(false);

    const res = await page.evaluate((b) => window.__YP_TEST__!.playReplay('1-1', b) as Promise<{ status: number; state: string }>, bot.replay);
    expect(res.state).toBe('RESULTS');
    const card = page.locator('.res');
    await expect(card).toBeVisible();
    await expect(card.locator('.ribbon')).toHaveText('初クリア');
    expect(await card.textContent()).not.toMatch(/NaN|undefined|Infinity/);
    await page.screenshot({ path: `${OUT()}/game-ja-390x844-results.png` });

    await card.locator('.res-row .btn--gold').tap();
    await page.waitForSelector('.share-prev canvas');
    expect(await page.locator('.share-prev canvas').evaluate((c: HTMLCanvasElement) => [c.width, c.height])).toEqual([1200, 630]);
    await expect(page.locator('.share-text')).toHaveValue(/^ゆらしてピタッ 1-1『おつかい』\d+\.\d{3}秒 AI比 [+−]\d+\.\d{3}秒 #ゆらピタ/);
    await page.keyboard.press('Escape');

    // Pause from READY: the ghost toggle shows what the game picked (offline dev server: AI + PB -> AI only).
    await page.evaluate(() => window.__YP_TEST__!.command('retry'));
    await page.waitForSelector('.yp[data-screen="hud"]');
    await page.locator('.hud-band .hud-btn').nth(1).tap();
    await page.waitForSelector('.yp[data-screen="pause"]');
    const ghost = page.locator('.pause-grid .btn', { hasText: 'ゴースト' }).first();
    const before = await ghost.locator('.btn-state').textContent();
    await ghost.tap();
    await expect(ghost.locator('.btn-state')).not.toHaveText(before ?? '');
    const set = await page.evaluate(() => (window.__YP_TEST__!.state() as { ghostSet: number }).ghostSet);
    await expect(ghost.locator('.btn-state')).toHaveText(['AI＋自己ベスト', 'AIだけ', 'AI＋世界記録', 'AI＋ライバル', 'なし'][set]!);
    expect(errors).toEqual([]);
  });
});


// Release review (ui-1 .. ui-12): what a player on a small phone or in an in-app browser would see first.
declare global {
  interface Window {
    /** Lines taken by the text of an element (text nodes only; icons, key hints and sub notes do not count). */
    __textLines?(el: Element): number;
  }
}

test.describe('release review', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.__textLines = (el: Element): number => {
        let n = 0;
        const walk = (e: Element): void => {
          for (const node of e.childNodes) {
            if (node.nodeType === 3 && node.textContent?.trim()) {
              const r = document.createRange();
              r.selectNodeContents(node);
              n = Math.max(n, new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size);
            } else if (node instanceof HTMLElement && !node.classList.contains('kbd') && !node.classList.contains('btn-sub') && getComputedStyle(node).display !== 'none') walk(node);
          }
        };
        walk(el);
        return n;
      };
    });
  });

  // ui-1: the crown / PB banner starts during the 0.75 s success beat and must stay visible over the results card.
  for (const vp of [{ width: 390, height: 844 }, { width: 844, height: 390 }] as const) {
    for (const [kind, screen, after] of [['crown', 'results-firstcrown', 1000], ['pb', 'results', 300]] as const) {
      test(`ui-1 ${vp.width}x${vp.height}: the ${kind} banner is on top of the results card ${after} ms after it opened`, async ({ page }) => {
        // (the card opens 750 ms after the success, SUCCESS_BEAT; the banner lives 150 .. 2250 ms / 1850 ms for a PB)
        const errors = collectErrors(page);
        await page.setViewportSize(vp);
        await open(page, `screen=${screen}&lang=ja&beat=750&defer=1`);
        // One round trip: success -> (the 750 ms beat) -> card -> `after` ms, timed from the success like core does.
        const r = await page.evaluate(async ([k, ms]) => {
          const sleep = (t: number): Promise<void> => new Promise((res) => setTimeout(res, t));
          const t0 = window.__UI_DEMO__!.start();
          while (!document.querySelector('.yp[data-screen="results"] .res')) await sleep(5);
          while (performance.now() < t0 + 750 + ms) await sleep(5);
          const inner = document.querySelector<HTMLElement>(`.pop--banner[data-kind="${k}"] .pop-in`);
          if (!inner) return null;
          const b = inner.getBoundingClientRect();
          // Banners never take a tap (pointer-events: none): make this one hit-testable just for the check.
          inner.style.pointerEvents = 'auto';
          const top = document.elementFromPoint((b.left + b.right) / 2, (b.top + b.bottom) / 2);
          inner.style.pointerEvents = '';
          const buttons = [...document.querySelectorAll('.res button')].map((e) => e.getBoundingClientRect()).filter((x) => x.width > 0);
          const overButton = buttons.some((x) => x.left < b.right - 1 && b.left < x.right - 1 && x.top < b.bottom - 1 && b.top < x.bottom - 1);
          return { onTop: !!top?.closest('.pop--banner'), overButton, count: inner.querySelector('.pop-banner-count')?.textContent ?? null, tick: !!inner.querySelector('.is-tick'), left: b.left, right: b.right, top: b.top, bottom: b.bottom };
        }, [kind, after] as const);
        await page.screenshot({ path: `${OUT()}/ja-${vp.width}x${vp.height}-${kind}-banner.png` });
        expect(r, 'banner still up').not.toBeNull();
        expect(r!.onTop).toBe(true);
        expect(r!.overButton).toBe(false);
        expect(r!.left).toBeGreaterThanOrEqual(0);
        expect(r!.right).toBeLessThanOrEqual(vp.width);
        expect(r!.top).toBeGreaterThanOrEqual(0);
        if (kind === 'crown') {
          expect(r!.tick).toBe(true);
          expect(r!.count).toMatch(/^\d+\/18$/);
        }
        expect(errors).toEqual([]);
      });
    }
  }

  // ui-2: the title's footer (tagline, あそぶ, links) fits short portrait screens.
  for (const vp of [{ width: 375, height: 548 }, { width: 360, height: 560 }, { width: 320, height: 568 }] as const) {
    for (const lang of LANGS) {
      test(`ui-2 ${lang} ${vp.width}x${vp.height}: the title footer is on screen, the links on one line`, async ({ page }) => {
        await page.setViewportSize(vp);
        await open(page, `screen=title&lang=${lang}&still=1`);
        await page.screenshot({ path: `${OUT()}/${lang}-${vp.width}x${vp.height}-title.png` });
        const m = await page.evaluate(() => {
          const f = document.querySelector<HTMLElement>('.title-foot')!;
          const tag = document.querySelector<HTMLElement>('.tagline')!.getBoundingClientRect();
          const links = [...document.querySelectorAll<HTMLElement>('.title-links .btn')];
          const lineOf = window.__textLines!;
          return {
            scroll: f.scrollHeight, client: f.clientHeight, footTop: f.getBoundingClientRect().top, tagTop: tag.top,
            linksBottom: Math.max(...links.map((b) => b.getBoundingClientRect().bottom)), rows: new Set(links.map((b) => Math.round(b.getBoundingClientRect().top))).size,
            wrapped: links.filter((b) => lineOf(b) > 1).map((b) => b.textContent), vh: window.innerHeight,
          };
        });
        expect(m.scroll).toBeLessThanOrEqual(m.client);
        expect(m.linksBottom).toBeLessThanOrEqual(m.vh);
        expect(m.tagTop).toBeGreaterThanOrEqual(m.footTop);
        expect(m.rows).toBe(1);
        expect(m.wrapped).toEqual([]);
      });
    }
  }

  // ui-3 / ui-9: results labels never break inside a word or collapse to 「AI…」; 「タイムアップ」 stays on one line.
  for (const vp of [{ width: 320, height: 640 }, { width: 360, height: 640 }, { width: 375, height: 667 }, { width: 568, height: 320 }] as const) {
    for (const lang of LANGS) {
      for (const screen of ['results', 'results-fail'] as const) {
        test(`ui-3 ${lang} ${vp.width}x${vp.height} ${screen}: no wrapped or cut labels`, async ({ page }) => {
          await page.setViewportSize(vp);
          await open(page, `screen=${screen}&lang=${lang}&still=1`);
          const bad = await page.evaluate(() => {
            const lineOf = window.__textLines!;
            const out: string[] = [];
            // The stacked assist button (label + note) may wrap, between words only (U+200B / spaces).
            for (const b of document.querySelectorAll<HTMLElement>('.res-foot .btn:not(.btn-stack), .res-keys .btn')) {
              if (b.offsetWidth === 0) continue;
              if (lineOf(b) > 1) out.push(`wrapped: ${b.textContent}`);
              for (const sp of b.querySelectorAll<HTMLElement>('span')) if (sp.offsetWidth && sp.scrollWidth > sp.clientWidth + 1) out.push(`cut: ${sp.textContent}`);
            }
            for (const sp of document.querySelectorAll<HTMLElement>('.res-foot .btn-stack > span:first-child')) {
              if (!/[\s\u200b]/.test(sp.textContent ?? '') && lineOf(sp) > 1) out.push(`broken word: ${sp.textContent}`);
            }
            const title = document.querySelector('.res-fail-title');
            if (title && lineOf(title) > 1) out.push('fail title wraps');
            return out;
          });
          expect(bad).toEqual([]);
        });
      }
    }
  }

  test('ui-9 125 % text at 390x844: 「タイムアップ」 stays clear of the × stamp', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, 'screen=results-fail&lang=ja&still=1&ts=125');
    const title = (await rects(page, '.res-fail-title'))[0]!;
    const stamp = (await rects(page, '.res-stamp .stamp'))[0]!;
    expect(title.right).toBeLessThanOrEqual(stamp.left + 1);
  });

  // ui-4: short landscape pause menu: no label stacked a glyph per line, nothing sticks out of its button.
  for (const vp of [{ width: 640, height: 360 }, { width: 568, height: 320 }, { width: 667, height: 375 }] as const) {
    for (const lang of LANGS) {
      test(`ui-4 ${lang} ${vp.width}x${vp.height}: pause labels stay whole`, async ({ page }) => {
        await page.setViewportSize(vp);
        await open(page, `screen=pause&lang=${lang}&still=1`);
        await page.screenshot({ path: `${OUT()}/${lang}-${vp.width}x${vp.height}-pause.png` });
        const bad = await page.evaluate(() => {
          const lineOf = window.__textLines!;
          const out: string[] = [];
          for (const b of document.querySelectorAll<HTMLElement>('.pause-grid .btn')) {
            const br = b.getBoundingClientRect();
            for (const c of b.querySelectorAll<HTMLElement>('span')) {
              if (c.offsetWidth === 0) continue;
              if (c.getBoundingClientRect().right > br.right + 1) out.push(`sticks out: ${c.textContent}`);
              if (c.classList.contains('btn-state') && c.scrollWidth > c.clientWidth + 1) out.push(`state cut: ${c.textContent}`);
            }
            const label = b.querySelector<HTMLElement>('.btn-stack > span:first-child') ?? b.querySelector<HTMLElement>(':scope > span:not(.kbd)');
            if (label && lineOf(label) > 1 && !/[\s\u200b]/.test(label.textContent ?? '')) out.push(`wrapped: ${label.textContent}`);
          }
          return out;
        });
        expect(bad).toEqual([]);
      });
    }
  }

  // ui-5 / ui-6 / ui-8: id chips on one line, the daily card title on one line, the daily hub inside 320 px.
  for (const lang of LANGS) {
    test(`ui-5 ${lang} 320x568: level id chips never wrap (results, briefing)`, async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 568 });
      for (const screen of ['results', 'briefing', 'pause'] as const) {
        await open(page, `screen=${screen}&lang=${lang}&still=1`);
        const chips = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.idchip')].filter((c) => c.offsetWidth).map((c) => [c.textContent, c.scrollHeight <= c.clientHeight + 1, c.scrollWidth <= c.clientWidth + 1]));
        expect(chips.length, screen).toBeGreaterThan(0);
        for (const [text, h, w] of chips) expect([text, h, w], screen).toEqual([text, true, true]);
      }
    });

    for (const vp of [{ width: 568, height: 320 }, { width: 640, height: 360 }, { width: 320, height: 568 }] as const) {
      test(`ui-6 ${lang} ${vp.width}x${vp.height}: the daily card title is one line`, async ({ page }) => {
        await page.setViewportSize(vp);
        await open(page, `screen=select&lang=${lang}&still=1`);
        const n = await page.evaluate(() => window.__textLines!(document.querySelector('.dcard-title')!));
        expect(n).toBe(1);
        const [card] = await rects(page, '.dcard');
        const [go] = await rects(page, '.dcard .btn');
        expect(go!.right).toBeLessThanOrEqual(card!.right);
      });
    }

    test(`ui-8 ${lang} 320x568: the daily hub fits the screen (cards, share button, stats)`, async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 568 });
      await open(page, `screen=daily&lang=${lang}&still=1`);
      const m = await page.evaluate(() => {
        const body = document.querySelector<HTMLElement>('.page-body')!;
        const clipped = [...document.querySelectorAll<HTMLElement>('.daily-grid .sheet, .daily-grid .btn, .daily-grid .stat, .daily-grid table')]
          .filter((e) => e.getBoundingClientRect().right > window.innerWidth + 0.5).map((e) => e.className);
        return { sw: body.scrollWidth, cw: body.clientWidth, clipped };
      });
      expect(m.sw).toBeLessThanOrEqual(m.cw);
      expect(m.clipped).toEqual([]);
    });
  }

  // ui-7: short tall phones: with a status row (daily rack, offline) the scoreboard stays in the dock, even with a split.
  for (const vp of [{ width: 375, height: 548 }, { width: 360, height: 560 }, { width: 360, height: 640 }, { width: 390, height: 664 }] as const) {
    test(`ui-7 ${vp.width}x${vp.height}: the scoreboard never runs into the play area`, async ({ page }) => {
      await page.setViewportSize(vp);
      await open(page, 'screen=hud-daily&lang=ja&still=1');
      await page.evaluate(() => window.__UI_DEMO__!.ui.fx({ t: 'split', index: 0, deltaSub: -28, vs: 'pb' }));
      await page.waitForTimeout(100);
      const l = await page.evaluate(() => window.__UI_DEMO__!.layout());
      for (const r of await rects(page, '.hud-board, .hud-board *')) expect(r.bottom).toBeLessThanOrEqual(l.hudTop + 0.5);
      expect(await sidewaysClipped(page)).toEqual([]);
    });
  }

  // ui-12: landscape phones: in-play toasts go to the bottom-right corner under the floor, one at a time.
  for (const vp of [{ width: 844, height: 390 }, { width: 568, height: 320 }] as const) {
    test(`ui-12 ${vp.width}x${vp.height}: in-play toasts stay off the scene`, async ({ page }) => {
      await page.setViewportSize(vp);
      await open(page, 'screen=hud-run&lang=ja&still=1&toasts=3');
      await page.screenshot({ path: `${OUT()}/ja-${vp.width}x${vp.height}-hud-run-toasts.png` });
      const floorY = await page.evaluate(() => window.__UI_DEMO__!.toScreen(0, 0).y);
      const toasts = await rects(page, '.toast');
      const [bar] = await rects(page, '.hud-force');
      expect(toasts.length).toBe(1);
      for (const t of toasts) {
        expect(t.top).toBeGreaterThanOrEqual(floorY);
        expect(t.right).toBeLessThanOrEqual(vp.width);
        expect(hit(t, bar!)).toBe(false);
      }
    });
  }
});
