// Screen capture of the game for the promo video: Chrome screencast frames (1080x1920) -> CFR mp4 via ffmpeg.
// Runs with the game's Playwright (see capture.mjs). Never touches the live site: it drives a local vite server.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../game/package.json', import.meta.url));
export const { chromium } = require('playwright');

export const W = 432, H = 768, DPR = 2.5; // 1080 x 1920, tall layout (H/W >= 1.25)

export async function openGame(base, save) {
  const browser = await chromium.launch({ args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=gl'] });
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: DPR, hasTouch: true, isMobile: true, locale: 'ja-JP' });
  await ctx.addInitScript((s) => { if (s) localStorage.setItem('yurapita:v1', JSON.stringify(s)); }, save ?? null);
  const page = await ctx.newPage();
  await page.goto(`${base}?yptest=1`);
  await page.waitForFunction(() => window.__YP_TEST__ && window.__YP_TEST__.state().state !== 'BOOT', null, { timeout: 30000 });
  await page.evaluate(() => document.fonts.ready);
  // recorded from a local server: the "offline" chip would be a lie about the live game
  await page.addStyleTag({ content: '.chip--offline { display: none !important; }' });
  return { browser, page };
}

export const cmd = (page, c) => page.evaluate((x) => window.__YP_TEST__.command(x), c);
export const st = (page) => page.evaluate(() => window.__YP_TEST__.state());

/** Records the page while `body` runs; writes <out>.mp4 at 30 fps. */
export async function record(page, out, body) {
  const dir = `${out}.frames`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  let on = true;
  cdp.on('Page.screencastFrame', async (f) => {
    if (!on) return;
    const i = frames.length;
    frames.push({ t: f.metadata.timestamp, file: `${String(i).padStart(5, '0')}.jpg` });
    writeFileSync(join(dir, frames[i].file), Buffer.from(f.data, 'base64'));
    try { await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }); } catch { /* closed */ }
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: W * DPR, maxHeight: H * DPR, everyNthFrame: 1 });
  const t0 = Date.now() / 1000;
  await body();
  const t1 = Date.now() / 1000;
  on = false;
  await cdp.send('Page.stopScreencast');
  // concat list with per-frame durations (frames arrive only when the page changes)
  const lines = [];
  for (let i = 0; i < frames.length; i++) {
    const next = i + 1 < frames.length ? frames[i + 1].t : Math.max(frames[i].t + 1 / 30, frames[0].t + (t1 - t0));
    lines.push(`file '${frames[i].file}'`, `duration ${Math.max(0.001, next - frames[i].t).toFixed(4)}`);
  }
  lines.push(`file '${frames.at(-1).file}'`);
  writeFileSync(join(dir, 'list.txt'), lines.join('\n'));
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', join(dir, 'list.txt'),
    '-vf', `fps=30,scale=${W * DPR}:${H * DPR}:flags=lanczos,format=yuv420p`, '-c:v', 'libx264', '-crf', '16', '-preset', 'slow', `${out}.mp4`]);
  rmSync(dir, { recursive: true, force: true });
  return { frames: frames.length, seconds: t1 - t0 };
}
