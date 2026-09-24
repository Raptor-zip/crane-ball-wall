// Captures the four in-game scenes of photos.html into scenes/*.png (1600x900 @2x) from the game's render demo.
// Needs the game's dev server: cd game && npx vite --port 5311 --strictPort   (then: node promo/thanks/capture-scenes.mjs)
// The PNGs are regenerated from the game, so scenes/ is not tracked (promo/.gitignore).
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../game/package.json', import.meta.url));
const { chromium } = require('playwright');
const BASE = process.env.YP_URL ?? 'http://localhost:5311/';
const out = new URL('./scenes/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
// name: [skins (src/render/skinLooks.ts ids), render-demo load options]
const SCENES = {
  classic: ['', { level: '2-2', t: 'end' }],
  tancho: ['crane.tancho,stage.castle,trail.kumihimo,ball.lapis', { level: '2-2', t: 'end' }],
  wood: ['crane.wood,stage.note,trail.pencil,ball.steel', { level: '2-2', t: 'end' }],
  primer: ['crane.primer,stage.site,trail.wire,ball.wrecker', { level: '2-2', t: 'auto' }],
};
const browser = await chromium.launch();
for (const [name, [skin, opts]] of Object.entries(SCENES)) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
  await page.goto(new URL(`dev/render-demo.html?shot=1&hud=0&q=high&level=1-1&t=auto${skin ? `&skin=${skin}` : ''}`, BASE).href);
  await page.waitForFunction(() => window.__RENDER_DEMO__?.ready === true, null, { timeout: 60_000 });
  await page.evaluate(async (o) => { await window.__RENDER_DEMO__.load({ scenario: 'run', ghosts: ['ai'], ...o }); }, opts);
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}${name}.png` });
  await page.close();
  console.log(`wrote scenes/${name}.png`);
}
await browser.close();
