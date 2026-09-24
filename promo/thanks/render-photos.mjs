// Renders photos.html -> thanks<N>-photos.png (1600x900 @2x = 3200x1800, X 16:9). Uses the game's Playwright.
//   node promo/thanks/capture-scenes.mjs                 # once: the four in-game scenes (needs the game's dev server)
//   node promo/thanks/render-photos.mjs 4000 --clear 2   # 4,000 players; the note says 2 players cleared all 18 levels
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../game/package.json', import.meta.url));
const { chromium } = require('playwright');
const args = process.argv.slice(2);
const n = Number(args[0] ?? 4000);
if (!Number.isInteger(n) || n < 1000 || n % 1000) throw new Error('N must be a multiple of 1000');
const ci = args.indexOf('--clear');
if (!existsSync(new URL('./scenes/classic.png', import.meta.url))) throw new Error('scenes/ missing: run capture-scenes.mjs first');
const url = new URL('./photos.html', import.meta.url);
url.searchParams.set('n', String(n));
if (ci >= 0) url.searchParams.set('clear', String(Number(args[ci + 1])));
const out = new URL(`./thanks${n}-photos.png`, import.meta.url).pathname;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
await page.goto(url.href);
await page.evaluate(() => document.fonts.ready);
await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
await page.screenshot({ path: out });
await browser.close();
console.log(`wrote ${out}`);
