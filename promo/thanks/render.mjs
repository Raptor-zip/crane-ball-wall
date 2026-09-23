// Renders thanks.html -> thanks<N>.png (1600x900 @2x = 3200x1800, X 16:9). Uses the game's Playwright.
//   node promo/thanks/render.mjs 2000     # 2,000 players (N = 1000..9000)
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../game/package.json', import.meta.url));
const { chromium } = require('playwright');
const n = Number(process.argv[2] ?? 1000);
if (!Number.isInteger(n) || n < 1000 || n > 9000 || n % 1000) throw new Error('N must be one of 1000, 2000, ..., 9000');
const url = new URL('./thanks.html', import.meta.url);
url.searchParams.set('k', String(n / 1000));
const out = new URL(`./thanks${n}.png`, import.meta.url).pathname;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
await page.goto(url.href);
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: out });
await browser.close();
console.log(`wrote ${out}`);
