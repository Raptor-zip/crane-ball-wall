// Records the gameplay clips of the promo (promo/remotion/public/clips/*.mp4 + finger paths *.json).
// Needs a local game server: cd game && npx vite --port 5311   (then: node promo/capture/capture.mjs [clip ...])
// Drag plans were searched offline in the real simulation (steady assist on) and are robust to ±2 ticks / ±4 cm.
import { mkdirSync, writeFileSync } from 'node:fs';
import { openGame, cmd, st, record } from './lib.mjs';

const BASE = process.env.YP_URL ?? 'http://localhost:5311/';
const OUT = new URL('../remotion/public/clips/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const SAVE = { v: 1, settings: { lang: 'ja', steady: true, ghostSet: 1 }, seen: { onboarding: true, notes: [1, 2, 3, 4, 5], aiLostCard: true, storageNotice: true, tricks: [] } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Target path in rail metres per 60 Hz tick: ramp to A, hold until T1, ramp to C, hold until T2, ramp to B (R ticks each). */
function plan(x0, segs, R = 6) {
  return (t) => {
    let from = x0, t0 = 0;
    for (const [x, until] of segs) {
      if (t < t0 + R) return from + (x - from) * Math.min(1, (t - t0 + 1) / R);
      if (t < until) return x;
      from = x;
      t0 = until;
    }
    return from;
  };
}

/** Drags on the deck along `path` (rail metres) for `ticks`, logging finger positions for the overlay. */
async function drag(page, rail, x0, path, ticks) {
  const cdp = await page.context().newCDPSession(page);
  const deck = await page.evaluate(() => { const r = document.querySelector('.deck-surface').getBoundingClientRect(); const d = document.querySelector('.yp-deck').getBoundingClientRect(); return { left: d.left, width: d.width, top: r.top, height: r.height }; });
  const pxPerM = deck.width / (rail[1] - rail[0]);
  const y = deck.top + deck.height * 0.35; // upper part of the surface: k = 1 (not the fine band)
  const px0 = deck.left + deck.width * 0.35;
  const at = (x) => px0 + (x - x0) * pxPerM;
  const log = [];
  const t0 = Date.now();
  const touch = (type, x) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  await touch('touchStart', px0);
  log.push({ ms: 0, x: px0, y, down: true });
  await sleep(120);
  const start = Date.now();
  for (;;) {
    const t = ((Date.now() - start) / 1000) * 60;
    if (t >= ticks) break;
    const x = at(path(Math.floor(t)));
    await touch('touchMove', x);
    log.push({ ms: Date.now() - t0, x, y, down: true });
    await sleep(8);
  }
  await touch('touchEnd');
  log.push({ ms: Date.now() - t0, x: at(path(ticks)), y, down: false });
  return log;
}

const clips = {
  // 1-4: back-swing, fling over the first wall, let go over the pocket; the steady assist settles it -> ピタッ
  async play14(page) {
    await cmd(page, 'openLevel:1-4');
    await sleep(1500);
    let fingers = null, t0 = 0;
    const r = await record(page, `${OUT}play14`, async () => {
      await sleep(600);
      t0 = Date.now();
      fingers = await drag(page, [-1, 3.2], 0, plan(0, [[-0.3, 30], [2.4, 54], [1.57, 1e9]]), 90);
      await sleep(8500);
    });
    return { ...r, fingers: fingers.map((f) => ({ ...f, ms: f.ms + 600 })), state: (await st(page)).state, t0 };
  },
  // 1-2: straight dash into the knee-high wall -> ゴンッ, bricks fly
  async crash12(page) {
    await cmd(page, 'openLevel:1-2');
    await sleep(1500);
    let fingers = null;
    const r = await record(page, `${OUT}crash12`, async () => {
      await sleep(500);
      fingers = await drag(page, [-0.6, 2.6], 0, plan(0, [[1.8, 1e9]]), 40);
      await sleep(2600);
    });
    return { ...r, fingers: fingers.map((f) => ({ ...f, ms: f.ms + 500 })), state: (await st(page)).state };
  },
  // 2-2: the AI's own run (the research planner), ×0.5 with its force curve
  async ai22(page) {
    await cmd(page, 'openLevel:2-2');
    await sleep(1500);
    await cmd(page, 'demo');
    return record(page, `${OUT}ai22`, () => sleep(9000));
  },
  async title(page) {
    await cmd(page, 'back');
    return record(page, `${OUT}title`, () => sleep(5000));
  },
};

const want = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(clips);
for (const name of want) {
  const { browser, page } = await openGame(BASE, SAVE);
  try {
    const r = await clips[name](page);
    if (r.fingers) writeFileSync(`${OUT}${name}.json`, JSON.stringify(r.fingers));
    console.log(name, JSON.stringify({ frames: r.frames, seconds: r.seconds?.toFixed(1), state: r.state }));
  } finally {
    await browser.close();
  }
}
