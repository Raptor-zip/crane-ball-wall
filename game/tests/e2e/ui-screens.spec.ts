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
import { DECK_FORCE_H, TALL_BENCH_H, TALL_FRAME_K } from '../../src/ui/layout';

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
  // Skins (GAME_DESIGN.md §7.14): the sheet over the title attract on each tab, and a locked skin tried on.
  'skins', 'skins-crane', 'skins-trail', 'skins-stage', 'skins-try',
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

/** Screen y of the floor's front edge (y = -0.08 m in the ball plane, render/scene.ts), lowest over the visible x. */
const floorFront = (page: Page): Promise<number> => page.evaluate(() => {
  const at = (x: number): { x: number; y: number } | null =>
    window.__UI_DEMO__ ? window.__UI_DEMO__.toScreen(x, -0.08) : (window.__YP_TEST__?.toScreen?.(x, -0.08) ?? null);
  const ys: number[] = [];
  for (let x = -1.5; x <= 4.5; x += 0.25) {
    const q = at(x);
    if (q && q.x >= 0 && q.x <= window.innerWidth) ys.push(q.y);
  }
  return Math.max(...ys);
});
/** Waits until the one toast on screen is another one (the next in the queue after the first expired). */
async function nextToast(page: Page): Promise<void> {
  const [first] = await page.locator('.toast').allTextContents();
  await expect.poll(async () => {
    const now = await page.locator('.toast').allTextContents();
    return now.length === 1 && now[0] !== first;
  }, { timeout: 5_000 }).toBe(true);
}
/** The tall deck's children and anything drawn in it outside the drag surface (a 2D view of the rail would be). */
const deckShape = (page: Page): Promise<{ kids: string[]; drawn: number }> => page.evaluate(() => {
  const d = document.querySelector('.yp-deck')!;
  return {
    kids: [...d.children].map((e) => e.className),
    drawn: [...d.querySelectorAll('svg, canvas')].filter((e) => !e.closest('.deck-surface')).length,
  };
});

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
    // The play area (the scene above the bench band) is sized for a 2.0-2.3 m window (TALL_FRAME_K w / W px for the
    // camera frame).
    expect(l.bench).toBe(TALL_BENCH_H);
    const win = (TALL_FRAME_K * l.w) / (l.scene.h - l.hudTop - TALL_BENCH_H);
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
    expect(pop.bottom).toBeLessThanOrEqual(l.deck!.y - l.bench!);
  });

  test('popups placed low are kept above the bench band (the toasts own it)', async ({ page }) => {
    for (const vp of [{ width: 390, height: 844 }, { width: 320, height: 568 }] as const) {
      await page.setViewportSize(vp);
      await open(page, 'screen=hud-run&lang=ja&still=1');
      const l = await page.evaluate(() => window.__UI_DEMO__!.layout());
      // A crash right at the floor: 「ゴンッ」 above it, the depth and cause 56 px under it (into the band unless clamped).
      await page.evaluate((y) => window.__UI_DEMO__!.ui.fx({ t: 'crash', kind: 1, wall: 0, x: 0, y: 0, overlapMm: 4 }, { x: 160, y }), l.deck!.y - l.bench! - 8);
      await page.waitForTimeout(150);
      const pops = await rects(page, '.pop--crash .pop-in, .pop--crashinfo .pop-in');
      expect(pops.length, `${vp.width}x${vp.height}`).toBe(2);
      for (const r of pops) expect(r.bottom, `${vp.width}x${vp.height}`).toBeLessThanOrEqual(l.deck!.y - l.bench! + 1);
    }
  });

  // No 2D mini rail in the deck: the force bar, then the drag surface right under it.
  test('deck: the force bar and the drag surface only, the surface right under the bar', async ({ page }) => {
    await open(page, 'screen=hud-run&lang=ja&still=1');
    const l = await page.evaluate(() => window.__UI_DEMO__!.layout());
    expect(await deckShape(page)).toEqual({ kids: ['deck-force', 'deck-surface'], drawn: 0 });
    const surface = (await rects(page, '.deck-surface'))[0]!;
    // 2 px deck border, then the 8 px force bar.
    expect(Math.abs(surface.top - (l.deck!.y + 2 + DECK_FORCE_H))).toBeLessThanOrEqual(1);
    expect(surface.bottom).toBe(844);
  });

  // HUD toasts sit on the bench band, right under the floor's front edge: never on the ball, the goal zone or its pad.
  test('HUD toasts: one at a time under the floor front, the next one after it', async ({ page }) => {
    for (const vp of [{ width: 390, height: 844 }, { width: 360, height: 640 }, { width: 375, height: 548 }] as const) {
      await page.setViewportSize(vp);
      await open(page, 'screen=hud-run&lang=ja&still=1&toasts=2');
      const tag = `${vp.width}x${vp.height}`;
      const l = await page.evaluate(() => window.__UI_DEMO__!.layout());
      const front = await floorFront(page);
      const toasts = await rects(page, '.toast');
      expect(toasts.length, tag).toBe(1);
      // One line: inside the bench band.
      expect(toasts[0]!.top, tag).toBeGreaterThanOrEqual(front);
      expect(toasts[0]!.bottom, tag).toBeLessThanOrEqual(l.deck!.y);
      // The second one waited for it and takes its place.
      await nextToast(page);
    }
  });

  // A toast too tall for the band (125 % text: two or three lines on a narrow phone) still shows at once: it runs on
  // over the force bar and the top of the drag surface, never up over the floor (the 1-1 pad it talks about).
  for (const [w, h, lang] of [[320, 568, 'ja'], [320, 568, 'en'], [360, 560, 'ja'], [320, 640, 'en'], [375, 548, 'en']] as const) {
    test(`HUD long toast at 125 % ${w}x${h} ${lang}: shown at once under the floor front, the next one after it`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await open(page, `screen=hud-1-1&lang=${lang}&still=1&ts=125`);
      const long = lang === 'ja' ? 'パッドの上で指（キー）を離すと、クレーンが揺れを止めてくれる' : 'Let go over the pad (finger or key) and the crane stops the swing for you';
      await page.evaluate((t) => {
        window.__UI_DEMO__!.ui.toast(t, 'info');
        window.__UI_DEMO__!.ui.toast('SHORT', 'info');
      }, long);
      await page.waitForTimeout(300);
      const [t] = await rects(page, '.toast');
      expect(await page.locator('.toast').textContent()).toBe(long);
      expect(t!.bottom - t!.top).toBeGreaterThan(50);
      expect(t!.top).toBeGreaterThanOrEqual(await floorFront(page));
      expect(t!.bottom).toBeLessThanOrEqual(h - 8);
      // 1-1's pad (x 1.2-1.8: the floor plate, whose front reaches the floor front, and its curtain) is off the toast.
      const zone = await page.evaluate(() => {
        const d = window.__UI_DEMO__!;
        return { left: d.toScreen(1.2, 0.6).x, top: d.toScreen(1.2, 0.6).y, right: d.toScreen(1.8, 0).x, bottom: d.toScreen(1.8, -0.075).y };
      });
      expect(hit(t!, zone)).toBe(false);
      await expect(page.locator('.toast')).toHaveText('SHORT', { timeout: 5_000 });
    });
  }
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

// World rank (§9.4): the rank row / stamp under the time, the ranking's own row and pinned 「あなた」 row. The stamp is a
// graphic that never wraps (125 % text included) and stays inside the card, clear of the ピタッ stamp.
const RANK_SCREENS = [
  'results&rank=in-from', 'results&rank=up', 'results&rank=wr-again', 'results&rank=est-up', 'results&rank=pending', 'results&rank=nonpb',
  'board&board=pin', 'board&board=pin-pending', 'board&board=instant', 'board&board=partial', 'board&board=daily-pin',
] as const;
for (const vp of [{ width: 360, height: 740, touch: true, ts: '' }, { width: 360, height: 740, touch: true, ts: '125' }, { width: 1280, height: 720, touch: false, ts: '' }] as const) {
  test.describe(`world rank ${vp.width}x${vp.height}${vp.ts ? ` text ${vp.ts} %` : ''}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.touch });
    for (const lang of LANGS) {
      for (const screen of RANK_SCREENS) {
        test(`${lang} ${screen}`, async ({ page }) => {
          const errors = collectErrors(page);
          await open(page, `screen=${screen}&lang=${lang}&still=1${vp.ts ? `&ts=${vp.ts}` : ''}`);
          if (screen.startsWith('board')) await page.waitForSelector('.board-pin');
          const tag = screen.replace(/[&=]/g, '-');
          await page.screenshot({ path: `${OUT()}/${lang}-${vp.width}x${vp.height}${vp.ts ? `-ts${vp.ts}` : ''}-${tag}.png` });
          expect(errors).toEqual([]);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
          expect(await sidewaysClipped(page)).toEqual([]);
          if (vp.touch) expect(await smallTargets(page)).toEqual([]);
          const W = vp.width;
          if (screen.startsWith('results')) {
            // right under the time, inside the card
            expect(await page.evaluate(() => document.querySelector('.res-rank')?.previousElementSibling?.classList.contains('res-time'))).toBe(true);
            const card = (await rects(page, '.res-scroll'))[0]!;
            for (const r of await rects(page, '.res-rank, .res-rank > *')) {
              expect(r.left).toBeGreaterThanOrEqual(card.left - 1);
              expect(r.right).toBeLessThanOrEqual(card.right + 1);
            }
            const stamp = (await rects(page, '.stamp--rank'))[0];
            if (stamp) {
              // one word line and one number line: no wrapped stamp; clear of the ピタッ stamp in the corner
              const lines = await page.locator('.stamp--rank > span').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
              expect(lines).toHaveLength(2);
              expect(lines[0]!).toBeLessThan(30);
              expect(lines[1]!).toBeLessThan(40);
              expect(hit(stamp, (await rects(page, '.res-stamp .stamp'))[0]!)).toBe(false);
              expect(await page.locator('.res-rank .sr-only').textContent()).toMatch(lang === 'ja' ? /世界\d+位/ : /World #\d+/);
            } else {
              expect(await page.locator('.res-rank').textContent()).toMatch(lang === 'ja' ? /約/ : /~/);
            }
          } else {
            // the pinned row is on screen, inside the page, and marks its rank as an estimate (or has none)
            const pin = (await rects(page, '.board-pin'))[0]!;
            expect(pin.left).toBeGreaterThanOrEqual(0);
            expect(pin.right).toBeLessThanOrEqual(W);
            expect(pin.bottom).toBeLessThanOrEqual(vp.height);
            expect(pin.top).toBeGreaterThan(0);
            const rank = await page.locator('.board-pin-rank').textContent();
            expect(rank).toMatch(lang === 'ja' ? /^(約[\d,]+位|–)$/ : /^(~#[\d,]+|–)$/);
            if (screen === 'board&board=partial') await expect(page.locator('.board-partial')).toBeVisible();
            if (screen === 'board&board=instant') expect(await page.locator('.skel').count()).toBe(6);
          }
        });
      }
    }
  });
}

test.describe('world rank: the stamp choreography', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  test('a late answer: 見込み first, then the stamp is pressed and the ↑n pill rises after it', async ({ page }) => {
    await open(page, 'screen=results&rank=up&arrive=1200&lang=ja');
    await expect(page.locator('.res-rank')).toContainText('約37位の見込み・確認中…');
    await expect(page.locator('.stamp--rank.is-new')).toBeVisible({ timeout: 5000 });
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.querySelector('.rank-up')!).opacity), { timeout: 3000 }).toBe('1');
    const t = await page.evaluate(() => getComputedStyle(document.querySelector('.stamp--rank')!).transform);
    expect(t).not.toBe('none');   // rotated -5°, final scale 1
  });
  test('motion off: the stamp fades in (no press)', async ({ page }) => {
    await open(page, 'screen=results&rank=in&lang=ja&motion=off');
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.stamp--rank')!).animationName)).toBe('yp-fade-in');
  });
});

test.describe('world rank: a short landscape card', () => {
  test.use({ viewport: { width: 568, height: 320 }, hasTouch: true });
  test('the card scrolls the rank row into view before the stamp is pressed (it starts below the fold)', async ({ page }) => {
    await open(page, 'screen=results&rank=up&lang=ja');
    const cut = (): Promise<boolean> => page.evaluate(() => {
      const s = document.querySelector('.res-scroll')!.getBoundingClientRect();
      const r = document.querySelector('.res-rank')!.getBoundingClientRect();
      return r.bottom > s.bottom + 0.5;
    });
    await expect.poll(cut, { timeout: 3000 }).toBe(false);
    // it got there by scrolling: at 568x320 the row opens below the fold
    expect(await page.evaluate(() => document.querySelector('.res-scroll')!.scrollTop)).toBeGreaterThan(0);
    const time = await page.evaluate(() => {
      const s = document.querySelector('.res-scroll')!.getBoundingClientRect();
      return document.querySelector('.res-time')!.getBoundingClientRect().bottom > s.top;
    });
    expect(time).toBe(true);          // the time is still on the card
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

// First visit: the language follows the browser (§3.5, HANDOFF D17) — English unless navigator.language is ja*.
test.describe('first-visit language', () => {
  for (const [locale, lang, play] of [['en-US', 'en', /play/i], ['fr-FR', 'en', /play/i], ['ja-JP', 'ja', /あそぶ/]] as const) {
    test(`${locale} -> ${lang}`, async ({ browser, baseURL }) => {
      const ctx = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, locale });
      const page = await ctx.newPage();
      await page.goto('/?yptest=1');
      await page.waitForSelector('.yp[data-screen="title"]', { timeout: 30_000 });
      expect(await page.evaluate(() => document.documentElement.lang)).toBe(lang);
      await expect(page.locator('.title-play')).toHaveText(play);
      await ctx.close();
    });
  }
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

// Few players read the x / θ / F graphs: on the results card they start closed behind a quiet text toggle, and the AI
// demo's F(t) panel is small and never covers the ball or the goal zone (tall: the deck; wide: a strip under the floor).
test.describe('quiet graphs', () => {
  test('results: the graphs start closed; the toggle opens and closes them (tap and keyboard)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, 'screen=results&lang=ja&still=1');
    const toggle = page.locator('.res-graphs .graphs-toggle');
    const body = page.locator('.res-graphs .graphs');
    await expect(toggle).toHaveText('グラフを見る');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(body).toBeHidden();
    expect(await body.getAttribute('id')).toBe(await toggle.getAttribute('aria-controls'));
    // Quiet: secondary ink, no border, no fill.
    const look = await toggle.evaluate((b) => {
      const cs = getComputedStyle(b);
      return { color: cs.color, border: cs.borderTopColor, bg: cs.backgroundColor, h: b.getBoundingClientRect().height };
    });
    expect(look).toEqual({ color: 'rgb(75, 86, 112)', border: 'rgba(0, 0, 0, 0)', bg: 'rgba(0, 0, 0, 0)', h: 44 });
    await toggle.scrollIntoViewIfNeeded();
    await toggle.click();
    await expect(body).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle).toHaveText('グラフを閉じる');
    await expect(body.locator('.graph')).toHaveCount(3);
    await expect(body.locator('.graph-legend')).toBeVisible();
    // Enter on the focused toggle closes it again and does not reach the game (Enter = retry).
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(body).toBeHidden();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#demo-log')).not.toHaveText(/^retry/);
  });

  for (const [vp, lang, ts] of [
    [{ width: 390, height: 844 }, 'ja', 100], [{ width: 320, height: 568 }, 'en', 125], [{ width: 375, height: 548 }, 'ja', 125],
    [{ width: 844, height: 390 }, 'ja', 100], [{ width: 568, height: 320 }, 'en', 100], [{ width: 1280, height: 720 }, 'ja', 100],
    [{ width: 568, height: 320 }, 'en', 125], [{ width: 568, height: 320 }, 'ja', 125], [{ width: 533, height: 320 }, 'en', 125],
    [{ width: 667, height: 375 }, 'en', 125], [{ width: 1280, height: 720 }, 'en', 125],
  ] as const) {
    test(`AI demo ${vp.width}x${vp.height} ${lang} ${ts} %: the F(t) panel stays under the floor, small, with the hint`, async ({ page }) => {
      await page.setViewportSize(vp);
      await open(page, `screen=demo&lang=${lang}&still=1&ts=${ts}`);
      await page.screenshot({ path: `${OUT()}/${lang}-${vp.width}x${vp.height}-demo-ts${ts}.png` });
      const l = await page.evaluate(() => window.__UI_DEMO__!.layout());
      const floorY = await page.evaluate(() => window.__UI_DEMO__!.toScreen(0, 0).y);
      const [panel] = await rects(page, '.demo-panel');
      const graph = await page.locator('.demo-graph').boundingBox();
      expect(panel!.top).toBeGreaterThan(floorY);
      expect(panel!.bottom).toBeLessThanOrEqual(vp.height);
      expect(graph!.height).toBeGreaterThanOrEqual(l.kind === 'tall' ? 40 : 30);
      if (l.kind === 'tall') {
        // The deck's place, growing up over the bench band on short decks (never up to the floor's front edge).
        expect(panel!.top).toBeLessThanOrEqual(l.deck!.y + 1);
        expect(panel!.top).toBeGreaterThanOrEqual(l.deck!.y - TALL_BENCH_H + 15);
        expect(graph!.height).toBeLessThanOrEqual(96);
      } else {
        // A low strip: at most two lines of text beside the graph on a landscape phone (the AI's numbers are on the
        // results card), and the graph keeps at least 40 % of the strip's inside, however long the words.
        expect(panel!.bottom - panel!.top).toBeLessThanOrEqual(vp.height < 500 ? 42 : 64);
        const inner = await page.locator('.demo-panel').evaluate((e) => {
          const cs = getComputedStyle(e);
          return e.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        });
        expect(graph!.width).toBeGreaterThanOrEqual(0.4 * inner - 0.5);
        expect(graph!.width).toBeGreaterThanOrEqual(150);
      }
      // The hint: readable size, secondary ink (6.9:1 on the card), except on the narrowest landscape phones where the
      // skip button says the same.
      const hint = page.locator('.demo-panel .demo-hint');
      if (l.kind === 'wide' && vp.width < 560) await expect(hint).toBeHidden();
      else {
        await expect(hint).toBeVisible();
        const look = await hint.evaluate((e) => ({
          color: getComputedStyle(e).color, px: parseFloat(getComputedStyle(e).fontSize), rem: parseFloat(getComputedStyle(document.documentElement).fontSize),
        }));
        expect(look.color).toBe('rgb(75, 86, 112)');
        expect(look.px).toBeGreaterThanOrEqual(0.72 * look.rem - 0.01);
      }
      expect(await page.evaluate(() => {
        const e = document.querySelector<HTMLElement>('.demo-panel')!;
        return e.scrollHeight <= e.clientHeight + 1;
      })).toBe(true);
    });
  }

  // Landscape: toasts go top right under the skip button, one at a time (not on the strip nor the swinging ball).
  for (const vp of [{ width: 568, height: 320 }, { width: 844, height: 390 }, { width: 1280, height: 720 }] as const) {
    test(`AI demo ${vp.width}x${vp.height}: toasts one at a time under the skip button`, async ({ page }) => {
      await page.setViewportSize(vp);
      await open(page, 'screen=demo&lang=ja&still=1&toasts=2');
      const toasts = await rects(page, '.toast');
      expect(toasts.length).toBe(1);
      const [skip] = await rects(page, '.demo-top .btn');
      const [panel] = await rects(page, '.demo-panel');
      const t = toasts[0]!;
      expect(t.top).toBeGreaterThanOrEqual(skip!.bottom);
      expect(t.right).toBeGreaterThan(vp.width - 20);
      expect(hit(t, panel!)).toBe(false);
      // Above 1 m: the ball hangs 1 m under the 1.25 m hook and never swings that high.
      expect(t.bottom).toBeLessThanOrEqual(await page.evaluate(() => window.__UI_DEMO__!.toScreen(0, 1).y));
      await nextToast(page);
    });
  }

  // The real scene: the floor's front edge (z = 0.32 m, seen from 6° above) is ~8 cm under the ball plane's floor line.
  for (const [vp, ts] of [[{ width: 844, height: 390 }, 100], [{ width: 568, height: 320 }, 100], [{ width: 568, height: 320 }, 125], [{ width: 390, height: 844 }, 100]] as const) {
    test(`AI demo in the real game ${vp.width}x${vp.height} ${ts} %: the panel is under the floor front, the playhead moves`, async ({ page }) => {
      test.setTimeout(60_000);
      await page.setViewportSize(vp);
      if (ts !== 100) {
        await page.addInitScript((scale) => {
          if (!localStorage.getItem('yurapita:v1')) localStorage.setItem('yurapita:v1', JSON.stringify({ v: 1, settings: { lang: 'ja', langPicked: true, textScale: scale } }));
        }, ts);
      }
      await page.goto('/?yptest=1');
      await page.waitForSelector('.yp[data-screen="title"]', { timeout: 30_000 });
      for (const id of ['1-1', '2-2']) {
        await page.evaluate((lvl) => window.__YP_TEST__!.command(`openLevel:${lvl}`), id);
        // (2-2 opens with its briefing card the first time; the demo starts from there too)
        await page.waitForSelector('.yp[data-screen="hud"], .yp[data-screen="briefing"]');
        // A toast from play (here the ghost set) flushes when the demo opens: in landscape it goes under the skip button.
        await page.evaluate(() => window.__YP_TEST__!.command('ghostCycle'));
        await page.evaluate(() => window.__YP_TEST__!.command('demo'));
        await page.waitForSelector('.yp[data-screen="demo"] .demo-panel');
        const x0 = await page.locator('.demo-graph line').last().getAttribute('x1');
        await page.waitForTimeout(700);
        await page.screenshot({ path: `${OUT()}/game-ja-${vp.width}x${vp.height}-ts${ts}-demo-${id}.png` });
        const front = await floorFront(page);
        const [panel] = await rects(page, '.demo-panel');
        expect(panel!.top, id).toBeGreaterThanOrEqual(front);
        expect(await page.locator('.demo-graph line').last().getAttribute('x1'), id).not.toBe(x0);
        if (vp.width > vp.height) {
          const [skip] = await rects(page, '.demo-top .btn');
          const hoverY = await page.evaluate(() => window.__YP_TEST__!.toScreen!(0, 1)!.y);
          for (const t of await rects(page, '.toast')) {
            expect(t.top, id).toBeGreaterThanOrEqual(skip!.bottom);
            expect(t.bottom, id).toBeLessThanOrEqual(hoverY);
            expect(hit(t, panel!), id).toBe(false);
          }
        }
        await page.keyboard.press('Escape');
        await page.waitForSelector('.yp[data-screen="hud"]');
      }
    });
  }

  // The real game's tall deck (touch.spec.ts checks it in the build too) and a HUD toast under the floor front.
  test('real game 390x844: the deck is the force bar and the drag surface; a toast sits under the floor front', async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/?yptest=1');
    await page.waitForSelector('.yp[data-screen="title"]', { timeout: 30_000 });
    await page.evaluate(() => window.__YP_TEST__!.command('openLevel:1-1'));
    await page.waitForSelector('.yp[data-screen="hud"]');
    await page.waitForTimeout(500);
    expect(await deckShape(page)).toEqual({ kids: ['deck-force', 'deck-surface'], drawn: 0 });
    const [deck] = await rects(page, '.yp-deck');
    const [surface] = await rects(page, '.deck-surface');
    expect(Math.abs(surface!.top - (deck!.top + 2 + DECK_FORCE_H))).toBeLessThanOrEqual(1);
    await page.evaluate(() => window.__YP_TEST__!.command('ghostCycle'));
    await page.waitForTimeout(300);
    const [t] = await rects(page, '.toast');
    expect(t!.top).toBeGreaterThanOrEqual(await floorFront(page));
    expect(t!.bottom).toBeLessThanOrEqual(deck!.top + 1);
  });
});

// Ranking replays (§7.5 item 6, §8.4 item 6, §9.4): the viewer's bar and F(t) strip on every kind of screen, and the
// ranking's 「1位のリプレイを見る」 / ▶ column.
test.describe('ranking replays', () => {
  /** Buttons smaller than 44 px, except the ▶ of the rows (the whole row is their touch target). */
  const smallButtons = async (page: Page): Promise<string[]> => (await smallTargets(page)).filter((s) => !s.startsWith('b-play-btn'));

  for (const [vp, lang, ts, rank] of [
    [{ width: 390, height: 844 }, 'ja', 100, 12], [{ width: 320, height: 568 }, 'en', 125, 100], [{ width: 360, height: 740 }, 'ja', 100, 1],
    [{ width: 844, height: 390 }, 'ja', 100, 12], [{ width: 844, height: 390 }, 'en', 100, 1], [{ width: 568, height: 320 }, 'ja', 100, 12],
    [{ width: 568, height: 320 }, 'en', 100, 100], [{ width: 568, height: 320 }, 'ja', 125, 12], [{ width: 640, height: 360 }, 'en', 125, 12],
    [{ width: 667, height: 375 }, 'ja', 100, 37], [{ width: 1280, height: 720 }, 'ja', 100, 12], [{ width: 1280, height: 720 }, 'en', 125, 1],
  ] as const) {
    test(`viewer ${vp.width}x${vp.height} ${lang} ${ts} % #${rank}: the bar fits with who and the time, the strip keeps the clock`, async ({ page }) => {
      const errors = collectErrors(page);
      await page.setViewportSize(vp);
      await open(page, `screen=replay&rank=${rank}&lang=${lang}&still=1&ts=${ts}`);
      await page.screenshot({ path: `${OUT()}/${lang}-${vp.width}x${vp.height}-replay${rank}-ts${ts}.png` });
      expect(errors).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(await sidewaysClipped(page)).toEqual([]);
      expect(await smallButtons(page)).toEqual([]);
      const l = await page.evaluate(() => window.__UI_DEMO__!.layout());
      const bar = await page.locator('.demo-top').evaluate((top) => {
        const kids = [...top.children].filter((e) => getComputedStyle(e).display !== 'none').map((e) => e.getBoundingClientRect());
        const name = top.querySelector<HTMLElement>('.demo-who-name');
        return {
          overflow: top.scrollWidth > top.clientWidth + 1,
          overlap: kids.some((a, i) => kids.slice(i + 1).some((b) => a.left < b.right - 1 && b.left < a.right - 1 && a.width > 0 && b.width > 0)),
          name: name ? name.scrollWidth <= name.clientWidth + 1 : null,
          nameW: name?.getBoundingClientRect().width ?? 0,
          time: top.querySelector('.demo-who-time')?.getBoundingClientRect().width ?? null,
        };
      });
      expect(bar.overflow).toBe(false);
      expect(bar.overlap).toBe(false);
      if (l.kind === 'wide') {
        // who is playing and the ranked time stay readable (the bar tightens its buttons first; at 125 % text on the
        // narrowest landscape phones the name may lose its end, never the time)
        if (ts === 100) expect(bar.name).toBe(true);
        else expect(bar.nameW).toBeGreaterThan(80);
        expect(bar.time).toBeGreaterThan(20);
      }
      const floorY = await page.evaluate(() => window.__UI_DEMO__!.toScreen(0, 0).y);
      const [panel] = await rects(page, '.demo-panel');
      expect(panel!.top).toBeGreaterThan(floorY);
      expect(panel!.bottom).toBeLessThanOrEqual(vp.height);
      expect(await page.evaluate(() => {
        const e = document.querySelector<HTMLElement>('.demo-panel')!;
        return e.scrollHeight <= e.clientHeight + 1;
      })).toBe(true);
      // The replay's numbers (not on the results card) are shown everywhere, starting with whose they are; the clock
      // is on screen on landscape phones too.
      const nums = page.locator('.demo-panel .demo-nums');
      await expect(nums).toBeVisible();
      await expect(nums.locator('.demo-owner')).toHaveText(lang === 'ja' ? `${rank}位` : `#${rank}`);
      await expect(nums.locator('.demo-clock')).toBeVisible();
      if (l.kind === 'wide') {
        // at most two lines of text in the strip beside the graph on a landscape phone
        expect(panel!.bottom - panel!.top).toBeLessThanOrEqual(vp.height < 500 ? 42 : 64);
        // landscape phones: each of the two rows on one line (its items' middles within a few px)
        const rows = await page.locator('.demo-panel .demo-row').evaluateAll((es) => es.filter((e) => getComputedStyle(e).display !== 'none')
          .map((e) => {
            const mids = [...e.children].filter((c) => getComputedStyle(c).display !== 'none')
              .map((c) => { const r = c.getBoundingClientRect(); return (r.top + r.bottom) / 2; });
            return Math.max(...mids) - Math.min(...mids) < 5 ? 1 : 2;
          }));
        if (vp.height < 520) expect(rows).toEqual([1, 1]);
      }
      // The hint (landscape screens that are not phones): inside the strip.
      const hint = page.locator('.demo-panel .demo-hint');
      if (await hint.isVisible()) {
        const out = await hint.evaluate((e) => {
          const r = document.createRange();
          r.selectNodeContents(e);
          return r.getBoundingClientRect().right - document.querySelector('.demo-panel')!.getBoundingClientRect().right;
        });
        expect(out).toBeLessThanOrEqual(0);
      }
    });
  }

  for (const vp of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 568, height: 320 }, { width: 640, height: 360 }, { width: 844, height: 390 }, { width: 1280, height: 720 }] as const) {
    for (const lang of LANGS) {
      for (const board of ['replay', 'replay-daily'] as const) {
        test(`ranking ${board} ${vp.width}x${vp.height} ${lang}: the #1 button keeps its label and #1's time, the header stays low`, async ({ page }) => {
          const errors = collectErrors(page);
          await page.setViewportSize(vp);
          await open(page, `screen=board&board=${board}&lang=${lang}&still=1`);
          await page.waitForSelector('.board-wr');
          await page.screenshot({ path: `${OUT()}/${lang}-${vp.width}x${vp.height}-board-${board}.png` });
          expect(errors).toEqual([]);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
          expect(await sidewaysClipped(page)).toEqual([]);
          expect(await smallButtons(page)).toEqual([]);
          const l = await page.evaluate(() => window.__UI_DEMO__!.layout());
          const head = await page.locator('.page-head').evaluate((e) => {
            const clipped = (el: Element | null): boolean | null => (el ? el.scrollWidth > el.clientWidth + 1 : null);
            const shown = (s: string): Element[] => [...e.querySelectorAll(s)].filter((x) => getComputedStyle(x).display !== 'none' && x.getBoundingClientRect().width > 0);
            const back = e.querySelector('.btn--icon')!.getBoundingClientRect();
            const title = e.querySelector('.page-title')!.getBoundingClientRect();
            return {
              h: e.getBoundingClientRect().height,
              titleBesideBack: Math.abs(title.top - back.top) < back.height,
              titleClipped: clipped(e.querySelector('.page-title > span:last-child')),
              label: shown('.board-wr .board-wr-long, .board-wr .board-wr-short').map((x) => clipped(x)),
              time: shown('.board-wr .board-wr-time, .board-wr .board-wr-subtime').map((x) => [x.textContent, clipped(x)]),
            };
          });
          // tall: the title beside the back button (cut short there as without the button), the #1 button a row under
          expect(head.titleBesideBack).toBe(true);
          expect(head.h).toBeLessThanOrEqual(l.kind === 'tall' ? 135 : 80);
          if (l.kind === 'wide') expect(head.titleClipped).toBe(false);
          expect(head.label).toEqual([false]);
          expect(head.time).toHaveLength(1);
          expect(head.time[0]![1]).toBe(false);
          // the ▶ column does not make the rows lower nor cut the time / gap columns
          const cells = await page.locator('table.board tbody tr[data-rank]').first().evaluate((tr) => ({
            h: tr.getBoundingClientRect().height,
            time: [...tr.querySelectorAll('td.b-num')].map((td) => td.scrollWidth <= td.clientWidth + 1),
          }));
          expect(cells.h).toBeGreaterThanOrEqual(38);
          expect(cells.time).toEqual([true, true]);
        });
      }
    }
  }

  test('offline / low quota: only #1 can be watched, so the table has no ▶ column (the names keep their width)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, 'screen=board&board=replay-lite&lang=en&still=1');
    await page.waitForSelector('.board-wr');
    await expect(page.locator('table.board .b-play')).toHaveCount(0);
    await expect(page.locator('table.board thead th')).toHaveCount(4);
    await expect(page.locator('table.board tr[data-rank="1"]')).toHaveClass(/is-watch/);
  });

  test('loading: a spinner, and with motion off a still hourglass (not a 「…」 that reads as a menu)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const [q, want] of [['', 'spinner'], ['&motion=off', 'hourglass'], ['&still=1', 'hourglass']] as const) {
      await open(page, `screen=board&board=replay-busy&lang=ja${q}`);
      const btn = page.locator('tr[data-rank="3"] .b-play-btn');
      await expect(btn).toHaveClass(/is-busy/);
      const look = await btn.evaluate((b) => ({
        wait: getComputedStyle(b.querySelector('.ico-wait')!).display,
        after: getComputedStyle(b, '::after').content,
        spin: getComputedStyle(b, '::after').animationName,
      }));
      if (want === 'spinner') expect(look).toMatchObject({ wait: 'none', spin: 'yp-spin' });
      else expect(look).toMatchObject({ wait: 'block', after: 'none' });
    }
  });

  test('a refused load: the ⓘ toast (not ✓, not the no-connection icon), its two lines balanced', async ({ page }) => {
    await page.setViewportSize({ width: 568, height: 320 });
    await open(page, 'screen=board&board=replay-limit&lang=ja');
    const toast = page.locator('.toast').first();
    await expect(toast).toContainText('リプレイの読み込み上限です');
    await expect(toast).toHaveClass(/toast--notice/);
    const lines = await toast.locator('span').evaluate((s) => {
      const r = document.createRange();
      r.selectNodeContents(s);
      const rows = new Map<number, number>();
      for (const x of r.getClientRects()) rows.set(Math.round(x.top), (rows.get(Math.round(x.top)) ?? 0) + x.width);
      return [...rows.values()];
    });
    // no word (or one character) left alone on the last line
    if (lines.length > 1) expect(Math.min(...lines)).toBeGreaterThan(0.4 * Math.max(...lines));
  });
});
