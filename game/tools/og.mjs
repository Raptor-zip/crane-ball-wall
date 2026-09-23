#!/usr/bin/env node
// Makes public/og.png (1200x630): a Playwright screenshot of the title screen (GAME_DESIGN.md §7.13 "OGP"). Owner: O7.
// The only image file of the project; it is used for link previews only (never loaded by the game, not in the single HTML).
//
//   node tools/og.mjs                      starts `vite` on OG_PORT (default 5199) and shoots http://localhost:<port>/
//   node tools/og.mjs --url http://localhost:8787/     shoots an already running build (e.g. `npm run worker:dev`)
//   node tools/og.mjs --demo               shoots dev/ui-demo.html?screen=title (2D stand-in scene) instead of the game
//   options: --out <file> (default public/og.png), --lang ja|en (default ja), --wait <ms> attract-loop time (default 900:
//            the ball clearing wall A of 2-2 under software WebGL; the loop runs on frame time, so re-check the frame
//            by eye and adjust --wait on other machines)
//            --gpu: hardware WebGL (ANGLE on the host GPU) instead of SwiftShader: antialiased lines, the real look
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
};
const has = (name) => args.includes(`--${name}`);

const W = 1200;
const H = 630;
const out = resolve(ROOT, opt('out', 'public/og.png'));
const lang = opt('lang', 'ja') === 'en' ? 'en' : 'ja';
const waitMs = Number(opt('wait', has('gpu') ? '1600' : '900')); // --gpu: 1600 ms is the same moment (checked on an RTX laptop)
const port = Number(process.env.OG_PORT ?? opt('port', '5199'));

async function waitForServer(url, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`og: server did not start at ${url}`);
}

let server = null;
let base = opt('url', null);
if (!base) {
  server = spawn('npx', ['vite', '--port', String(port), '--strictPort'], { cwd: ROOT, stdio: 'ignore', detached: process.platform !== 'win32' });
  base = `http://localhost:${port}/`;
  await waitForServer(base, 60_000);
}

const target = has('demo')
  ? new URL(`dev/ui-demo.html?screen=title&lang=${lang}`, base).href
  : new URL(`?og=1`, base).href;

const browser = await chromium.launch(
  has('gpu') ? { args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=gl', '--enable-unsafe-swiftshader=false'] } : {},
);
try {
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, locale: lang === 'ja' ? 'ja-JP' : 'en-US' });
  // First visit in a clean profile: pin the language so the title shows the right logo.
  await context.addInitScript((l) => {
    try {
      const k = 'yurapita:v1';
      const raw = localStorage.getItem(k);
      const d = raw ? JSON.parse(raw) : null;
      if (d?.settings) {
        d.settings.lang = l;
        d.settings.langPicked = true;
        localStorage.setItem(k, JSON.stringify(d));
      }
    } catch {
      /* ignore */
    }
  }, lang);
  const page = await context.newPage();
  await page.goto(target);
  await page.waitForSelector('.yp[data-screen="title"]', { timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);
  // Link previews show the logo, the tagline and the attract loop; the buttons (not clickable in a preview) are left out.
  await page.addStyleTag({ content: '.title-corner, .title-links, .title-hint, .title-play, #demo-log { display: none !important; }' });
  await page.waitForTimeout(waitMs);
  mkdirSync(dirname(out), { recursive: true });
  await page.screenshot({ path: out, clip: { x: 0, y: 0, width: W, height: H } });
  console.log(`og: wrote ${out} (${W}x${H}) from ${target}`);
} finally {
  await browser.close();
  if (server) {
    try {
      process.kill(-server.pid);
    } catch {
      server.kill();
    }
  }
}
