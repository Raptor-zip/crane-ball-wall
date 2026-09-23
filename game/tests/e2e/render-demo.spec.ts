// M4 renderer acceptance (GAME_DESIGN.md §10.7, §11 M4) plus renderer behaviour checks. Owner: O5.
//
// dev/render-demo.html feeds fake RenderFrames to the real renderer: a kinematic replay of the AI
// path, or the REAL simulation (src/sim) under the §3.2 servo for the crash / stop / slack scenarios.
//   - all 18 levels at 390x844, 844x390 and 1280x720: screenshot, renderer.info.render.calls <= 40
//     (§9.7), triangles <= 60k, zero console errors; rail mapper round trip <= 5 mm, unmoved by shake
//   - camera scale matches §9.2 (about 260 / 170 px/m wide) and D10 in tall: a 2.0-2.3 m follow window
//     that fills O7's play area [hudTop, scene bottom - bench] (beam right under the HUD, floor at the bottom,
//     the bench front in the layout's bench band under it),
//     look-ahead toward the goal, trolley and ball kept on screen during a 4-2 rail-end slam
//   - ghost tags never overlap each other nor sit on the player's trolley at the start pose
//   - board heading: level id, never a raw daily id (「今日の5球」 / levelLoaded.label); AI margin follows D8
//   - §9.5 crash timeline (vignette + 6 bricks gone by 0.7 s), Appendix B slack -> snap, rail-end stop
//   - reduced motion (at init and switched at runtime): no shake, no flash
//   - NaN frames do not poison the camera; no GPU resource leak across level loads
//   - unit checks of the pure modules (quality governor, shake, decals, particle cap)
// Screenshots go to testInfo.outputPath(), or to $RENDER_DEMO_SHOTS/<viewport>/<level>.png if set.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';
import { collectErrors } from './helpers';
import { TALL_BENCH_H } from '../../src/ui/layout';

interface Vp { name: string; width: number; height: number; dsf: number }
const VIEWPORTS: Vp[] = [
  { name: 'tall-390x844', width: 390, height: 844, dsf: 2 },
  { name: 'land-844x390', width: 844, height: 390, dsf: 2 },
  { name: 'desk-1280x720', width: 1280, height: 720, dsf: 1 },
];

type Demo = NonNullable<Window['__RENDER_DEMO__']>;

function shotPath(info: TestInfo, vp: Vp, name: string): string {
  const root = process.env.RENDER_DEMO_SHOTS;
  if (!root) return info.outputPath(`${vp.name}-${name}.png`);
  const dir = join(root, vp.name);
  mkdirSync(dir, { recursive: true });
  return join(dir, `${name}.png`);
}

type Stats = ReturnType<Demo['stats']>;

async function open(page: Page, query: string): Promise<void> {
  // Other owners edit src/ while this runs; the Vite dev server would broadcast full-page reloads
  // over its HMR socket. Answer that socket with a silent mock so the demo page stays put.
  await page.routeWebSocket(/.*/, () => {});
  await page.goto(`/dev/render-demo.html?shot=1&${query}`);
  await page.waitForFunction(() => window.__RENDER_DEMO__?.ready === true, null, { timeout: 60_000 });
}

async function show(page: Page, o: { level: string; t: string; scenario?: string; ghosts?: string[] }): Promise<Stats> {
  await page.evaluate(async (opts) => {
    const d = window.__RENDER_DEMO__;
    if (!d) throw new Error('render demo missing');
    await d.load({ scenario: 'run', ghosts: ['ai', 'pb', 'challenge'], ...opts } as never);
  }, o);
  return stats(page);
}

function stats(page: Page): Promise<Stats> {
  return page.evaluate(() => (window.__RENDER_DEMO__ as Demo).stats());
}

for (const vp of VIEWPORTS) {
  test.describe(vp.name, () => {
    test.use({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.dsf });

    test(`18 levels render within budget at ${vp.width}x${vp.height}`, async ({ page }, info) => {
      test.setTimeout(300_000);
      const errors = collectErrors(page);
      await open(page, 'level=1-1&t=auto');
      const ids = await page.evaluate(() => (window.__RENDER_DEMO__ as Demo).levels);
      expect(ids).toHaveLength(18);
      let maxCalls = 0;
      for (const id of ids) {
        const s = await show(page, { level: id, t: 'auto' });
        maxCalls = Math.max(maxCalls, s.calls);
        expect(s.calls, `draw calls on ${id}`).toBeLessThanOrEqual(40);
        expect(s.calls, `something was drawn on ${id}`).toBeGreaterThan(8);
        expect(s.triangles, `triangles on ${id}`).toBeLessThanOrEqual(60_000);
        // The ball is really drawn where worldToScreen (O7's popup / HUD anchor) says it is.
        const red = await page.evaluate(() => {
          const d = window.__RENDER_DEMO__ as Demo;
          const b = d.ball();
          if (b.egg) return -1;
          let n = 0;
          for (const [dx, dy] of [[0, 0], [0.45, 0], [-0.45, 0], [0, 0.45], [0, -0.45]] as const) {
            const c = d.probe(b.x + dx * b.r, b.y + dy * b.r);
            if (c && c[0] > 140 && c[0] > c[1] + 60 && c[0] > c[2] + 60) n++;
          }
          return n;
        });
        if (red >= 0) expect(red, `red ball pixels at worldToScreen(ball) on ${id}`).toBeGreaterThanOrEqual(3);
        await page.screenshot({ path: shotPath(info, vp, id) });
      }
      const mc = await page.evaluate(() => (window.__RENDER_DEMO__ as Demo).mapperCheck());
      expect(mc.samples).toBeGreaterThan(50);
      expect(mc.maxErrMm).toBeLessThanOrEqual(5);
      info.annotations.push({ type: 'maxCalls', description: String(maxCalls) });
      expect(errors).toEqual([]);
    });

    test(`ghost tags stay apart at the start pose at ${vp.width}x${vp.height}`, async ({ page }, info) => {
      test.setTimeout(120_000);
      const errors = collectErrors(page);
      await open(page, 'level=2-2&t=-0.3');
      for (const [level, ghosts] of [['2-2', ['ai', 'pb']], ['1-1', ['ai', 'pb', 'challenge']], ['4-3', ['ai', 'pb', 'wr', 'rival']]] as const) {
        await show(page, { level, t: '-0.3', ghosts: [...ghosts] });
        const r = await page.evaluate(() => {
          const d = window.__RENDER_DEMO__ as Demo;
          const p = d.pose();
          const a = d.toScreen(p.x - 0.12, 1.3), b = d.toScreen(p.x + 0.12, 1.3);
          return { tags: d.tags(), trolley: [a.x, b.x] as [number, number] };
        });
        expect(r.tags, `${level}: one tag per ghost`).toHaveLength(ghosts.length);
        for (let i = 0; i < r.tags.length; i++) {
          const t = r.tags[i]!;
          // A tag on the beam face must not sit on the player's trolley (its side plates hide it).
          if (t.row === 0) expect(t.x1 <= r.trolley[0] + 1 || t.x0 >= r.trolley[1] - 1, `${level}: ${t.label} on the trolley`).toBe(true);
          expect(t.x0, `${level}: ${t.label} on screen`).toBeGreaterThanOrEqual(-1);
          expect(t.x1, `${level}: ${t.label} on screen`).toBeLessThanOrEqual(vp.width + 1);
          for (let j = i + 1; j < r.tags.length; j++) {
            const u = r.tags[j]!;
            const overlapX = Math.min(t.x1, u.x1) - Math.max(t.x0, u.x0);
            const overlapY = Math.min(t.y1, u.y1) - Math.max(t.y0, u.y0);
            expect(overlapX <= 0.5 || overlapY <= 0.5, `${level}: tags ${t.label} / ${u.label} overlap`).toBe(true);
          }
        }
        // AI first when they stack at the start (ghost order), as one centred group over the trolley.
        const row1 = r.tags.filter((t) => t.row === 1).sort((p, q) => p.x0 - q.x0);
        if (row1.length >= 2 && ghosts[0] === 'ai') expect(row1[0]!.label).toBe('AI');
        await page.screenshot({ path: shotPath(info, vp, `tags-${level}`) });
      }
      expect(errors).toEqual([]);
    });

    test(`juice scenarios stay within budget at ${vp.width}x${vp.height}`, async ({ page }, info) => {
      test.setTimeout(180_000);
      const errors = collectErrors(page);
      await open(page, 'level=1-2&t=auto');
      const cases: { name: string; level: string; t: string; scenario?: string; ghosts?: string[] }[] = [
        { name: 'crash-2-1', level: '2-1', t: 'auto', scenario: 'crash' },
        { name: 'success-2-2', level: '2-2', t: 'end', ghosts: ['ai', 'wr', 'challenge'] },
        { name: 'stop-4-2', level: '4-2', t: 'auto', scenario: 'stop', ghosts: ['ai', 'rival'] },
        { name: 'egg-4-3', level: '4-3', t: 'auto', ghosts: ['ai', 'pb', 'wr', 'challenge'] },
        { name: 'ready-1-1', level: '1-1', t: '-0.3', ghosts: ['ai'] },
        { name: 'ready-2-2', level: '2-2', t: '-0.3', ghosts: ['ai'] },
        { name: 'slack-1-1', level: '1-1', t: 'auto', scenario: 'slack', ghosts: ['ai'] },
        { name: 'snap-1-1', level: '1-1', t: 'snap', scenario: 'slack', ghosts: ['ai'] },
      ];
      for (const c of cases) {
        const s = await show(page, c);
        expect(s.calls, `draw calls on ${c.name}`).toBeLessThanOrEqual(40);
        expect(s.triangles).toBeLessThanOrEqual(60_000);
        await page.screenshot({ path: shotPath(info, vp, c.name) });
      }
      const sc = await page.evaluate(() => (window.__RENDER_DEMO__ as Demo).shakeCheck());
      expect(sc.viewDiffPx).toBeGreaterThan(0.5); // the rendered camera shakes ...
      expect(sc.mapperErrMm).toBeLessThan(0.01); // ... the rail mapper does not.
      expect(errors).toEqual([]);
    });
  });
}

test.describe('camera scale (§9.2, D10)', () => {
  // Every page renders WebGL on the CPU; other agents may be loading the machine too.
  test.describe.configure({ timeout: 90_000 });
  const cases: { vp: Vp; level: string; lo: number; hi: number }[] = [
    // "1280x720: about 260 px/m (ball 31 px); 844x390: about 170 px/m (ball 20 px)" on the default rail.
    // Those are orthographic estimates; the exact rule is "x range and y in [-0.35, 1.6] (finger band =
    // floor front face, nearer the camera) fit below the HUD band", which gives ~159 px/m at 844x390.
    { vp: VIEWPORTS[2] as Vp, level: '2-2', lo: 260 * 0.92, hi: 260 * 1.08 },
    { vp: VIEWPORTS[1] as Vp, level: '2-2', lo: 170 * 0.92, hi: 170 * 1.08 },
    // tall (D10): a 2.0-2.3 m window (O7 sizes the play area for about 2.1 m) -> 390 / W px/m, ball >= 20 px
    // (it was 18 px at the spec's 2.6 m); 4-1 keeps a wider window (its portraitWindow 3.0 -> 2.3 m).
    { vp: VIEWPORTS[0] as Vp, level: '2-2', lo: 390 / 2.2, hi: 390 / 2.0 },
    { vp: VIEWPORTS[0] as Vp, level: '4-1', lo: (390 / 2.3) * 0.99, hi: (390 / 2.3) * 1.01 },
  ];
  for (const c of cases) {
    test(`${c.level} at ${c.vp.width}x${c.vp.height}`, async ({ browser }) => {
      const page = await browser.newPage({ viewport: { width: c.vp.width, height: c.vp.height }, deviceScaleFactor: c.vp.dsf });
      await open(page, `level=${c.level}&t=-0.3`);
      const ppm = await page.evaluate(() => (window.__RENDER_DEMO__ as Demo).pxPerM());
      expect(ppm).toBeGreaterThan(c.lo);
      expect(ppm).toBeLessThan(c.hi);
      await page.close();
    });
  }
});

test.describe('tall framing (D10)', () => {
  // Every page renders WebGL on the CPU; other agents may be loading the machine too.
  test.describe.configure({ timeout: 90_000 });
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });

  test('the play area is filled: beam right under the HUD, floor at the bottom', async ({ page }) => {
    test.setTimeout(120_000);
    for (const size of [[390, 844], [360, 780], [430, 932], [375, 667]] as const) {
      await page.setViewportSize({ width: size[0], height: size[1] });
      await open(page, 'level=2-2&t=-0.3');
      const f = await page.evaluate(() => (window.__RENDER_DEMO__ as Demo).frame());
      const bench = await page.evaluate(() => (window.__RENDER_DEMO__ as Demo).layout().bench ?? 0);
      const tag = `${size[0]}x${size[1]}`;
      expect(bench, tag).toBe(TALL_BENCH_H);
      expect(f.windowW, tag).toBeGreaterThanOrEqual(2.0 - 1e-6);
      expect(f.windowW, tag).toBeLessThanOrEqual(2.3);
      // One row of ghost tags between the HUD and the beam, no empty paper.
      expect(f.beamTopY - f.hudTop, `${tag}: room above the beam`).toBeGreaterThan(14);
      expect(f.beamTopY - f.hudTop, `${tag}: room above the beam`).toBeLessThan(40);
      // The floor edge reaches the bottom of the play area (a few px of it may fall into the bench band).
      expect(Math.abs(f.floorY - (f.sceneBottom - bench)), `${tag}: floor edge vs bottom of the play area`).toBeLessThan(20);
    }
  });

  test('a taller rect than needed: bench band under the floor first, the rest above the beam', async ({ page }) => {
    await open(page, 'level=2-2&t=-0.3&split=0.62');
    const f = await page.evaluate(() => (window.__RENDER_DEMO__ as Demo).frame());
    const ppm = await page.evaluate(() => (window.__RENDER_DEMO__ as Demo).pxPerM());
    expect(f.windowW).toBeCloseTo(2.0, 2);
    expect(f.sceneBottom - f.floorY).toBeGreaterThan(0.2 * ppm);
    expect(f.sceneBottom - f.floorY).toBeLessThan(0.4 * ppm);
    expect(f.beamTopY).toBeGreaterThan(f.hudTop + 40);
  });

  test('look-ahead: READY shows the start on the left and the way to the goal', async ({ page }) => {
    test.setTimeout(60_000);
    await open(page, 'level=2-2&t=-0.3');
    const r = await page.evaluate(() => {
      const d = window.__RENDER_DEMO__ as Demo;
      const p = d.pose();
      return { trolley: d.toScreen(p.x, 1.25).x, goal: d.toScreen(1.63, 0.3).x, wall: d.toScreen(1.36, 0.5).x, ppm: d.pxPerM() };
    });
    expect(r.trolley).toBeGreaterThan(0.3 * r.ppm); // FOLLOW_MARGIN 0.35 m inside
    expect(r.trolley).toBeLessThan(390 * 0.3);
    expect(r.wall).toBeLessThan(390); // the first wall of the pocket
    expect(r.goal).toBeLessThan(390); // and the goal centre are in view
    // 2-3 escapes to the left: the window leans left of the trolley.
    await open(page, 'level=2-3&t=-0.3');
    const l = await page.evaluate(() => {
      const d = window.__RENDER_DEMO__ as Demo;
      return d.toScreen(d.pose().x, 1.25).x;
    });
    expect(l).toBeGreaterThan(390 * 0.6);
  });

  test('4-2 rail-end slam: trolley and ball stay in the window', async ({ page }) => {
    test.setTimeout(90_000);
    await open(page, 'level=4-2&t=auto&scenario=stop');
    for (let k = 0; k < 8; k++) {
      const r = await page.evaluate(() => {
        const d = window.__RENDER_DEMO__ as Demo;
        d.step(4, 1 / 60);
        const p = d.pose();
        return { t: d.toScreen(p.x, 1.25).x, b: d.toScreen(p.bx, p.by).x };
      });
      for (const x of [r.t, r.b]) {
        expect(x).toBeGreaterThan(0);
        expect(x).toBeLessThan(390);
      }
    }
    // During the run (not frozen): the dash to the end must not leave the trolley behind either.
    for (const t of ['0.6', '1.0', '1.4', '1.8', '2.2']) {
      await show(page, { level: '4-2', t, scenario: 'stop', ghosts: ['ai'] });
      const r = await page.evaluate(() => {
        const d = window.__RENDER_DEMO__ as Demo;
        const p = d.pose();
        return { t: d.toScreen(p.x, 1.25).x, b: d.toScreen(p.bx, p.by).x };
      });
      expect(r.t, `trolley at t=${t}`).toBeGreaterThan(0);
      expect(r.t, `trolley at t=${t}`).toBeLessThan(390);
      expect(r.b, `ball at t=${t}`).toBeGreaterThan(-10);
      expect(r.b, `ball at t=${t}`).toBeLessThan(400);
    }
  });
});

test.describe('renderer behaviour', () => {
  // Every page renders WebGL on the CPU; other agents may be loading the machine too.
  test.describe.configure({ timeout: 90_000 });
  test.use({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 1 });

  test('crash timeline on the real simulation (§9.5)', async ({ page }) => {
    const errors = collectErrors(page);
    await open(page, 'level=2-1&t=auto&scenario=crash');
    const log = await page.evaluate(() => (window.__RENDER_DEMO__ as Demo).eventLog());
    const types = log.map((e) => e.t);
    expect(types[0]).toBe('runStart');
    const crash = log.find((e) => e.t === 'crash');
    if (!crash || crash.t !== 'crash') throw new Error('no crash event');
    expect([1, 2]).toContain(crash.kind);
    expect(crash.wall).toBe(0);
    // 0.12 s after the crash: vignette up, 6 bricks flying, camera shaking.
    let s = await stats(page);
    expect(s.debris).toBe(6);
    expect(s.vignette).toBeGreaterThan(0.5);
    expect(s.shake).toBeGreaterThan(0.005);
    // The whole beat fits in CRASH_BEAT (0.7 s): 0.7 s more and everything is gone.
    await page.evaluate(() => (window.__RENDER_DEMO__ as Demo).step(42, 1 / 60));
    s = await stats(page);
    expect(s.debris).toBe(0);
    expect(s.vignette).toBe(0);
    // Retry: transient effects cleared, draw calls back to the resting count.
    await page.evaluate(() => (window.__RENDER_DEMO__ as Demo).fx({ t: 'retry' }));
    await page.evaluate(() => (window.__RENDER_DEMO__ as Demo).step(2, 1 / 60));
    s = await stats(page);
    expect(s.particles).toBe(0);
    expect(errors).toEqual([]);
  });

  test('Appendix B dash-and-stop: slack then a snap (パシッ)', async ({ page }) => {
    await open(page, 'level=1-1&t=snap&scenario=slack');
    const log = await page.evaluate(() => (window.__RENDER_DEMO__ as Demo).eventLog());
    const iSlack = log.findIndex((e) => e.t === 'slack');
    const iSnap = log.findIndex((e) => e.t === 'snap');
    expect(iSlack).toBeGreaterThanOrEqual(0);
    expect(iSnap).toBeGreaterThan(iSlack);
    const snap = log[iSnap];
    if (!snap || snap.t !== 'snap') throw new Error('no snap');
    expect(snap.J).toBeGreaterThanOrEqual(0.5);
    const s = await stats(page);
    expect(s.snapFlash).toBeGreaterThan(0); // 80 ms white flash along the string
  });

  test('4-2 rail-end stop hits the bumper', async ({ page }) => {
    await open(page, 'level=4-2&t=auto&scenario=stop');
    const log = await page.evaluate(() => (window.__RENDER_DEMO__ as Demo).eventLog());
    const stop = log.find((e) => e.t === 'stop');
    if (!stop || stop.t !== 'stop') throw new Error('no stop');
    expect(stop.side).toBe(1);
    expect(stop.speed).toBeGreaterThan(1);
    const s = await stats(page);
    expect(s.particles).toBeGreaterThan(5); // sparks
  });

  test('reduced motion at init: no shake, no flash', async ({ page }) => {
    const errors = collectErrors(page);
    await open(page, 'level=2-2&t=auto&rm=1');
    const sc = await page.evaluate(() => (window.__RENDER_DEMO__ as Demo).shakeCheck());
    expect(sc.viewDiffPx).toBeLessThan(0.01);
    expect(sc.mapperErrMm).toBeLessThan(0.01);
    await page.evaluate(() => {
      const d = window.__RENDER_DEMO__ as Demo;
      d.fx({ t: 'crash', kind: 1, wall: 0, x: 1.3, y: 0.7, overlapMm: 3 });
      d.fx({ t: 'snap', J: 2, x: 1.2, y: 0.9 });
      d.step(12, 1 / 60);
    });
    const s = await stats(page);
    expect(s.reduced).toBe(true);
    expect(s.shake).toBe(0);
    expect(s.snapFlash).toBe(0);
    expect(s.vignette).toBeLessThanOrEqual(0.56); // a soft tint, not a flash
    expect(errors).toEqual([]);
  });

  test('reduced motion and quality can change at runtime', async ({ page }) => {
    await open(page, 'level=2-2&t=auto&q=high');
    let s = await stats(page);
    expect(s.shadows).toBe(true);
    await page.evaluate(() => {
      const d = window.__RENDER_DEMO__ as Demo;
      d.setOptions({ reducedMotion: true, quality: 'low' });
      d.fx({ t: 'stop', side: 1, speed: 4 });
      d.fx({ t: 'snap', J: 3, x: 1, y: 0.5 });
      d.step(1, 1 / 60);
    });
    s = await stats(page);
    expect(s.shake).toBe(0);
    expect(s.snapFlash).toBe(0);
    expect(s.dpr).toBe(1);
    expect(s.shadows).toBe(false);
    const sc = await page.evaluate(() => (window.__RENDER_DEMO__ as Demo).shakeCheck());
    expect(sc.viewDiffPx).toBeLessThan(0.01);
  });

  test('NaN frames do not poison the renderer', async ({ page }) => {
    const errors = collectErrors(page);
    await open(page, 'level=2-2&t=auto');
    const r = await page.evaluate(() => (window.__RENDER_DEMO__ as Demo).nanCheck());
    expect(r.finite).toBe(true);
    const s = await stats(page);
    expect(s.calls).toBeGreaterThan(8);
    expect(errors).toEqual([]);
  });

  test('tall follow camera recovers from NaN too', async ({ browser }) => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await open(page, 'level=2-2&t=auto');
    const r = await page.evaluate(() => (window.__RENDER_DEMO__ as Demo).nanCheck());
    expect(r.finite).toBe(true);
    await page.close();
  });

  test('board heading: the level id, a human label for daily levels (never "d:16")', async ({ page }) => {
    const errors = collectErrors(page);
    await open(page, 'level=2-2&t=-0.3');
    const board = async (o: Record<string, unknown>): Promise<string> => page.evaluate(async (opts) => {
      const d = window.__RENDER_DEMO__ as Demo;
      await d.load({ t: '-0.3', ghosts: ['ai'], ...opts } as never);
      return d.labels().board;
    }, o);
    expect(await board({ level: '2-2', label: undefined })).toBe('2-2');
    expect(await board({ level: 'd:16', label: undefined })).toBe('今日の5球');
    expect(await board({ level: 'd:16', label: 'd:16' })).toBe('今日の5球');
    expect(await board({ level: 'd:16', label: '#23' })).toBe('今日の5球 #23');
    expect(await board({ level: 'd:16', label: 'ひとっとび × ふつう' })).toBe('ひとっとび × ふつう');
    // A later loadLevel of the same level (core reloads a daily once its ghosts arrive) keeps the label.
    const kept = await page.evaluate(async () => {
      const d = window.__RENDER_DEMO__ as Demo;
      await d.load({ level: 'd:16', label: '#23' } as never);
      d.reload();
      return d.labels().board;
    });
    expect(kept).toBe('今日の5球 #23');
    const s = await stats(page);
    expect(s.calls).toBeLessThanOrEqual(40);
    expect(errors).toEqual([]);
  });

  test('AI margin lines follow the level (D8) and core\'s override', async ({ page }) => {
    await open(page, 'level=2-2&t=-0.3');
    const mm = (o: Record<string, unknown>): Promise<number> => page.evaluate(async (opts) => {
      const d = window.__RENDER_DEMO__ as Demo;
      await d.load({ t: '-0.3', ...opts } as never);
      return d.labels().aiMarginMm;
    }, o);
    expect(await mm({ level: '2-2', marginMm: null })).toBe(20);
    expect(await mm({ level: '2-2', marginMm: 35 })).toBe(35);
    const over = await page.evaluate(() => {
      const d = window.__RENDER_DEMO__ as Demo;
      d.setAiMarginMm(12);
      const a = d.labels().aiMarginMm;
      d.setAiMarginMm(Number.NaN); // bad input: back to the level's own margin
      return [a, d.labels().aiMarginMm];
    });
    expect(over).toEqual([12, 35]);
    expect(await mm({ level: '2-1', marginMm: null })).toBe(20);
  });

  test('no GPU resource leak across level loads', async ({ page }) => {
    test.setTimeout(120_000);
    await open(page, 'level=2-2&t=auto');
    const cycle = (): Promise<void> => page.evaluate(async () => {
      const d = window.__RENDER_DEMO__ as Demo;
      for (const id of d.levels) await d.load({ level: id, t: 'auto' });
      await d.load({ level: '2-2', t: 'auto' });
    });
    await cycle(); // first cycle uploads the long-lived meshes (e.g. the egg on 4-3)
    const before = await stats(page);
    await cycle();
    const after = await stats(page);
    expect(after.geometries).toBeLessThanOrEqual(before.geometries);
    expect(after.textures).toBeLessThanOrEqual(before.textures);
  });

  test('pure modules: quality governor, shake, decals, particle cap', async ({ page }) => {
    await open(page, 'level=1-1&t=-0.3');
    const r = await page.evaluate(() => {
      const { quality, shake, decals, particles, camera } = (window.__RENDER_DEMO__ as Demo).mods;
      // D10 look-ahead: the goal when both fit, else the trolley / ball 0.35 m inside the window.
      const look = [
        camera.lookAheadFocus(0, 0, 1.63, 2.1), camera.lookAheadFocus(1.5, 1.6, 1.63, 2.1),
        camera.lookAheadFocus(1.63, 1.63, 0, 2.1), camera.lookAheadFocus(0, 1.8, 5, 2.1), camera.lookAheadFocus(0, 0, Number.NaN, 2.1),
      ];
      const win = [camera.tallWindowFor(undefined), camera.tallWindowFor(3.0), camera.tallWindowFor(2.6), camera.tallWindowFor(-1)];
      // §9.7: phones start at DPR 1.5 without shadows; > 20 ms frames for 2 s -> DPR 1.0.
      const phone = quality.createQualityGovernor('auto', true, 3);
      const start = { ...phone.state };
      for (let i = 0; i < 60; i++) phone.sample(25); // 1.5 s: not yet
      const at15 = { ...phone.state };
      for (let i = 0; i < 60; i++) phone.sample(25);
      const at3 = { ...phone.state };
      const desk = quality.createQualityGovernor('auto', false, 2);
      const deskStart = { ...desk.state };
      const high = quality.createQualityGovernor('high', true, 3);
      for (let i = 0; i < 300; i++) high.sample(40);
      const low = quality.createQualityGovernor('low', false, 2);
      const hitch = quality.createQualityGovernor('auto', true, 2);
      for (let i = 0; i < 20; i++) hitch.sample(400); // tab switches are not a trend
      // §9.2: offset 0.05 m * trauma^2, decay 1.8 / s, off with reduced motion.
      const sh = shake.createShake(false);
      sh.add(1);
      const full = sh.update(0).offset;
      const half = sh.update(0.25).offset; // trauma 0.55 -> 0.05 * 0.3025
      sh.add(Number.NaN);
      const afterNaN = sh.update(0).offset;
      const rm = shake.createShake(true);
      rm.add(1);
      const rmOff = rm.update(0).offset;
      // §9.5: last 5 crosses per level, kept per level.
      const ds = decals.createDecals();
      for (let i = 0; i < 7; i++) ds.add('1-2', { x: i, y: 0, z: 0, rot: 0, size: 0.1 });
      ds.add('2-1', { x: 9, y: 0, z: 0, rot: 0, size: 0.1 });
      // §9.7: particles pooled, 300 at a time.
      const p = new particles.Particles();
      p.confetti(0, 1, 0.5, 250);
      p.sparks(0, 1, 0, 200, 1, 0, 2);
      p.update(1 / 60);
      return {
        start, at15, at3, deskStart, high: { ...high.state }, low: { ...low.state }, hitch: { ...hitch.state },
        full, half, afterNaN, rmOff,
        d12: ds.list('1-2').map((d) => d.x), d21: ds.list('2-1').length, live: p.active, max: particles.MAX_PARTICLES,
        look, win,
      };
    });
    expect(r.start).toEqual({ dpr: 1.5, shadows: false });
    expect(r.at15).toEqual({ dpr: 1.5, shadows: false });
    expect(r.at3).toEqual({ dpr: 1, shadows: false });
    expect(r.deskStart).toEqual({ dpr: 2, shadows: true });
    expect(r.high).toEqual({ dpr: 2, shadows: true });
    expect(r.low).toEqual({ dpr: 1, shadows: false });
    expect(r.hitch).toEqual({ dpr: 1.5, shadows: false });
    expect(r.full).toBeCloseTo(0.05, 6);
    expect(r.half).toBeCloseTo(0.05 * 0.55 * 0.55, 6);
    expect(Number.isFinite(r.afterNaN)).toBe(true);
    expect(r.rmOff).toBe(0);
    expect(r.d12).toEqual([2, 3, 4, 5, 6]);
    expect(r.d21).toBe(1);
    expect(r.max).toBe(300);
    expect(r.live).toBeLessThanOrEqual(300);
    expect(r.live).toBeGreaterThan(250);
    expect(r.look[0]).toBeCloseTo(0.7, 6);
    expect(r.look[1]).toBeCloseTo(1.63, 6);
    expect(r.look[2]).toBeCloseTo(0.93, 6);
    expect(r.look[3]).toBeCloseTo(0.9, 6); // 1.8 m apart: cannot keep both 0.35 m inside -> midpoint
    expect(r.look[4]).toBeCloseTo(0, 6);
    expect(r.win).toEqual([2.0, 2.3, 2.1, 2.0]);
  });
});
