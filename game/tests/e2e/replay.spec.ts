// The ranking's replays in the built game (GAME_DESIGN.md §7.5 item 6, §7.6, §9.4). Owner: O0.
// Every /api/* request is answered here: boot carries a 1-1 board whose #1 is the bundled bot run (its replay is boot's
// `wr`), /api/board the same three rows, /api/ghost/<key>/2 the second one; the /api/ghost hits are counted.
//   - opening the ranking from the results card asks for no replay;
//   - 「1位のリプレイを見る」 plays #1 from boot (0 requests), re-simulated by the client to the Node reference
//     (score and stateHash), held on the Success frame with the clock on the ranked time; any key returns to the ranking;
//   - a row's ▶ costs one request the first time and none after that;
//   - with reduced motion 勝負 does not pop; 「このゴーストと勝負」 races that run on the next attempt.
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { levelBoardKey } from '../../src/shared/api';
import type { BoardResponse, BootResponse, GhostResponse, SubmitRequest, SubmitResponse } from '../../src/shared/api';
import { levelHash } from '../../src/sim/level';
import { altBot11, bangBang11, bot11, collectErrors, level, playReplay, shot, simulate, state, waitForApp, waitForState } from './helpers';
import type { YpState } from './helpers';

test.use({ viewport: { width: 390, height: 844 } });
test.describe.configure({ timeout: 240_000 });

const K11 = levelBoardKey('1-1', levelHash(level('1-1').physics));
const P1 = 'a000000000000001';
const P2 = 'a000000000000002';
const P3 = 'a000000000000003';

type Replay = NonNullable<YpState['replay']>;
const inViewer = (s: YpState): Replay | null => (s.state === 'DEMO' ? s.replay : null);
/** The viewer holds on the Success frame: the hold (0.5 s) after the ranked time has completed. */
const held = (s: YpState): boolean => !!s.replay && s.replay.t >= (s.replay.t120 + 60) / 120 - 1e-6;

test('ranking replays: #1 from boot, another row with one request, 勝負', async ({ page, context }, info) => {
  const bot = bot11();
  const alt = altBot11();                  // #2: a slower clear of its own
  const third = bangBang11(18, 11);        // #3
  const mine = bangBang11(19, 12);         // my run: the slowest
  expect(bot.score).toBeLessThan(alt.score);
  expect(alt.score).toBeLessThan(third.score);
  expect(third.score).toBeLessThan(mine.score);
  const rows: BootResponse['boards'][string]['top'] = [
    [P1, 11, bot.score, -1, 0, 1790000000000], [P2, 22, alt.score, -1, 0, 1790000000001], [P3, 33, third.score, -1, 0, 1790000000002],
  ];
  const boot: BootResponse = {
    v: 1, sim: 1, now: Date.now(), day: 0, lite: false, readOnly: false,
    boards: { '1-1': { key: K11, n: 3, aiBeaten: 1, par: 400, cutoff: null, top: rows, wr: bot.replay } },
    daily: { key: '', n: 0, cleared: 0, aiBeaten: 0, par: 0, top: [], hist: [], wr: null },
  };
  const board: BoardResponse = { key: K11, n: 3, aiBeaten: 1, par: 400, cutoff: null, top: rows };
  const ghosts: Record<number, GhostResponse> = {
    2: { key: K11, rank: 2, pidh: P2, nameSeed: 22, t120: alt.score, replay: alt.replay },
    3: { key: K11, rank: 3, pidh: P3, nameSeed: 33, t120: third.score, replay: third.replay },
  };
  const ghostHits: string[] = [];
  await context.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/boot') return route.fulfill({ json: boot });
    if (path.startsWith('/api/board/')) return route.fulfill({ json: board });
    if (path.startsWith('/api/ghost/')) {
      ghostHits.push(path);
      const g = ghosts[Number(path.split('/').pop())];
      return g ? route.fulfill({ json: g }) : route.fulfill({ status: 404, json: { error: 'notFound' } });
    }
    if (path === '/api/submit') {
      const req = route.request().postDataJSON() as SubmitRequest;
      const res: SubmitResponse = { ok: true, lite: false, results: req.runs.map((r) => ({ board: r.board, status: 'unranked' })) };
      return route.fulfill({ json: res });
    }
    return route.fulfill({ status: 404, json: { error: 'notFound' } });
  });
  const errors = collectErrors(page);
  await page.goto('/');
  await waitForApp(page);
  await waitForState(page, (s) => !s.offline, 'online (the mocked boot)');

  // My clear, then the ranking from the results card: no replay is asked for.
  expect((await playReplay(page, '1-1', mine.replay)).state).toBe('RESULTS');
  await page.locator('section.res').getByRole('button', { name: /ランキング/ }).click();
  const wrBtn = page.locator('.page-head .board-wr');
  await expect(wrBtn).toBeVisible();
  await expect(wrBtn).toContainText('1位のリプレイを見る');
  await expect(wrBtn).toContainText(`${(bot.score / 120).toFixed(3)}秒`);
  await expect(page.locator('table.board tbody tr[data-rank]')).toHaveCount(3);
  await expect(page.locator('table.board tr[data-rank="2"] .b-play-btn')).toBeVisible();
  await page.waitForTimeout(500);
  expect(ghostHits).toEqual([]);
  await shot(page, info, 'replay-board-390x844');

  // #1: from boot's wr, re-simulated to the Node reference, on the real crane.
  await wrBtn.click();
  const s1 = await waitForState(page, (s) => inViewer(s) !== null, 'the viewer on #1');
  const ref1 = simulate('1-1', bot.replay);
  expect(ref1.stateHash).toBe(bot.stateHash);
  expect(s1.replay).toMatchObject({ key: K11, rank: 1, pidh: P1, t120: bot.score, score: bot.score, stateHash: ref1.stateHash, source: 'boot', kind: 'wr' });
  expect(ghostHits).toEqual([]);
  await expect(page.locator('.demo-title--replay')).toContainText('1位');
  await page.waitForTimeout(800);
  await shot(page, info, 'replay-viewer1-390x844-mid');
  await waitForState(page, held, 'held on the Success frame', 60_000);
  await expect(page.locator('.demo-clock')).toHaveText(`${(bot.score / 120).toFixed(3)}秒`);
  await expect(page.locator('.demo-race')).toHaveClass(/is-done/);
  expect((await state(page)).state).toBe('DEMO');       // it holds: no return on its own
  await shot(page, info, 'replay-viewer1-390x844-end');
  // Landscape: the strip is under the floor's front edge, the clock still there.
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.waitForTimeout(600);
  await expect(page.locator('.demo-panel .demo-clock')).toBeVisible();
  const under = await page.evaluate(() => {
    const ys: number[] = [];
    for (let x = -1.5; x <= 4.5; x += 0.25) {
      const q = window.__YP_TEST__!.toScreen!(x, -0.08);
      if (q && q.x >= 0 && q.x <= window.innerWidth) ys.push(q.y);
    }
    return document.querySelector('.demo-panel')!.getBoundingClientRect().top - Math.max(...ys);
  });
  expect(under).toBeGreaterThanOrEqual(0);
  await shot(page, info, 'replay-viewer1-1280x720-end');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);

  // Any key: back to the ranking, #1's button focused; the results card's run is untouched under it.
  await page.keyboard.press('x');
  await waitForState(page, (s) => s.state === 'RESULTS' && s.replay === null, 'RESULTS + ranking');
  await expect(wrBtn).toBeFocused();
  expect((await state(page)).bestSub).toBe(mine.score);

  // Row 2: one request, the answer re-simulated to the Node reference.
  await page.locator('table.board tr[data-rank="2"] td.b-name').click();
  const s2 = await waitForState(page, (s) => inViewer(s) !== null, 'the viewer on #2');
  expect(ghostHits).toHaveLength(1);
  expect(s2.replay).toMatchObject({ rank: 2, pidh: P2, t120: alt.score, score: alt.score, stateHash: simulate('1-1', alt.replay).stateHash, source: 'net', kind: 'rival' });
  await page.keyboard.press('Escape');
  await waitForState(page, (s) => s.state === 'RESULTS' && s.replay === null, 'RESULTS + ranking again');
  await expect(page.locator('table.board tr[data-rank="2"] .b-play-btn')).toBeFocused();

  // Reduced motion: the same row again (no request), held without the pop of 勝負.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('.yp')).toHaveClass(/yp--reduce/);
  await page.locator('table.board tr[data-rank="2"] .b-play-btn').click();
  await waitForState(page, (s) => inViewer(s) !== null, 'the viewer on #2 again');
  expect(ghostHits).toHaveLength(1);
  await waitForState(page, held, 'held on the Success frame', 60_000);
  const race = page.locator('.demo-race');
  await expect(race).toHaveClass(/is-done/);
  expect(await race.evaluate((b) => getComputedStyle(b).animationName)).toBe('none');
  await shot(page, info, 'replay-viewer2-390x844-end');

  // 「このゴーストと勝負」: READY on 1-1, that run right after the AI.
  await race.click();
  const ready = await waitForState(page, (s) => s.state === 'READY', 'READY with the picked ghost');
  expect(ready.level).toBe('1-1');
  expect(ready.picked).toEqual({ pidh: P2, kind: 'rival' });
  expect(ready.ghosts.slice(0, 2)).toEqual(['ai', 'rival']);
  expect(ghostHits).toHaveLength(1);
  await shot(page, info, 'replay-race-ready');
  expect(errors).toEqual([]);
});

/** The ▶ cells on screen (rank of each). */
async function playRanks(page: Page): Promise<string[]> {
  return page.locator('table.board .b-play-btn').evaluateAll((es) => es.map((e) => (e as HTMLElement).dataset.rank ?? ''));
}

test('low quota: #1 from boot still plays, no ▶ column, no /api/ghost', async ({ page, context }) => {
  const bot = bot11();
  const mine = bangBang11(19, 12);
  const rows: BootResponse['boards'][string]['top'] = [[P1, 11, bot.score, -1, 0, 1790000000000], [P2, 22, altBot11().score, -1, 0, 1790000000001]];
  const boot: BootResponse = {
    v: 1, sim: 1, now: Date.now(), day: 0, lite: true, readOnly: false,
    boards: { '1-1': { key: K11, n: 2, aiBeaten: 1, par: 400, cutoff: null, top: rows, wr: bot.replay } },
    daily: { key: '', n: 0, cleared: 0, aiBeaten: 0, par: 0, top: [], hist: [], wr: null },
  };
  const hits: string[] = [];
  await context.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    hits.push(path);
    if (path === '/api/boot') return route.fulfill({ json: boot });
    return route.fulfill({ status: 503, json: { error: 'internal' } });
  });
  const errors = collectErrors(page, [/\/api\//, /503/]);
  await page.goto('/');
  await waitForApp(page);
  await waitForState(page, (s) => !s.offline, 'online (lite)');
  expect((await playReplay(page, '1-1', mine.replay)).state).toBe('RESULTS');
  await page.locator('section.res').getByRole('button', { name: /ランキング/ }).click();
  await expect(page.locator('.board-wr')).toBeVisible();
  await expect(page.locator('table.board tbody tr[data-rank]')).toHaveCount(2);
  expect(await playRanks(page)).toEqual([]);
  await expect(page.locator('table.board thead th')).toHaveCount(4);
  await page.locator('.board-wr').click();
  const s = await waitForState(page, (x) => inViewer(x) !== null, 'the viewer on #1 (lite)');
  expect(s.replay).toMatchObject({ rank: 1, source: 'boot', score: bot.score, stateHash: bot.stateHash });
  expect(hits.filter((p) => p.startsWith('/api/ghost'))).toEqual([]);
  expect(errors).toEqual([]);
});
