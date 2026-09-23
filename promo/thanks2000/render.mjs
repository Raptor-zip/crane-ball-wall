// Renders thanks2000.html -> thanks2000.png (1600x900 @2x = 3200x1800, X 16:9). Uses the game's Playwright.
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../game/package.json', import.meta.url));
const { chromium } = require('playwright');
const html = new URL('./thanks2000.html', import.meta.url).href;
const out = new URL('./thanks2000.png', import.meta.url).pathname;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
await page.goto(html);
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: out });
await browser.close();
console.log(`wrote ${out}`);
