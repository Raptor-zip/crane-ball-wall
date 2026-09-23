// dev/ui-demo.html: renders every UI screen with mock data (O7). ?screen=<id>&lang=ja|en&level=2-2&world=2&still=1
// Extra: &toasts=<n> shows n trick / badge toasts right before the screen opens (results: they must avoid the card).
// Results screens: &beat=<ms> opens the card that long after the 'success' event (core: SUCCESS_BEAT 750 ms), as in the
// game (the crown / PB banner starts during the beat); &defer=1 waits for __UI_DEMO__.start() (tests time the beat).
// The 3D renderer is not used here; a 2D side view stands in for the scene so the overlays have context.
import '../src/ui/tokens.css';
import '../src/ui/styles.css';
import type { Layout } from '../src/render/renderer';
import type { HudState, Screen, UI } from '../src/ui/ui';
import { createUI } from '../src/ui/ui';
import { SideCam, drawSideView, wideRange } from '../src/ui/sideview';
import { TALL_FRAME_K } from '../src/ui/layout';
import { tallWindowFor } from '../src/render/camera';
import { drawShareCard } from '../src/ui/sharecard';
import { factsOf } from '../src/ui/i18n/format';
import { ghostTrack, level, mockContext, mockDaily, mockResults, mockSave, pairs } from './ui-demo-data';
import type { Track } from './ui-demo-data';

const q = new URLSearchParams(location.search);
const screenId = q.get('screen') ?? 'title';
const lang = (q.get('lang') === 'en' ? 'en' : 'ja') as 'ja' | 'en';
const still = q.has('still');
const offline = q.has('offline');
const levelId = q.get('level') ?? (screenId.startsWith('hud-egg') ? '4-3' : screenId === 'hud-1-1' ? '1-1' : '2-2');
const toastCount = Number(q.get('toasts') ?? 0);
const beat = Math.max(0, Number(q.get('beat') ?? 0) || 0);
const defer = q.has('defer');
const world = Number(q.get('world') ?? 1);

const save = mockSave(lang, q.get('save') === 'fresh' ? 'fresh' : 'mid');
if (q.get('ts') === '125') save.settings.textScale = 125;
if (q.get('motion') === 'off') save.settings.motion = 'off';
// results-firstcrown: the first crown on this level (not the first ever: the "why the AI lost" card stays shut).
if (screenId === 'results-crown' || screenId === 'ailost') save.seen.aiLostCard = false;
else save.seen.aiLostCard = true;
const ctx = mockContext(save, { offline });
const ui: UI = createUI(ctx);
const root = document.getElementById('app')!;
let layout: Layout = ui.mount(root);
ui.onLayout((l) => {
  layout = l;
});
if (still) document.querySelector('.yp')?.classList.add('yp--still');

// ---------------------------------------------------------------- mock scene

const lv = level(levelId);
const track: Track | null = ghostTrack(screenId === 'title' ? '2-2' : levelId, 'ai');
const calm: Track | null = ghostTrack(levelId, 'calm');
let camX = lv.physics.startX;

function camFor(bx: number, x: number): SideCam {
  const r = wideRange(lv);
  if (layout.kind === 'wide') {
    return new SideCam({ x: 0, y: layout.hudTop, w: layout.w, h: layout.h - layout.hudTop }, r, 'center');
  }
  // tall (D10): the play area is [hudTop, scene bottom]; the window is sized to fill it (2.0-2.3 m, 4-1 wider).
  const playH = layout.scene.h - layout.hudTop;
  const W = Math.max(tallWindowFor(lv.view?.portraitWindow), Math.min(2.3, Math.max(2.0, (TALL_FRAME_K * layout.scene.w) / Math.max(1, playH))));
  const target = Math.max(r.x0 + W / 2, Math.min(r.x1 - W / 2, (x + bx) / 2));
  camX += (target - camX) * (still ? 1 : 0.15);
  return new SideCam({ x: 0, y: layout.hudTop, w: layout.scene.w, h: playH }, { x0: camX - W / 2, x1: camX + W / 2, y0: -0.05, y1: 1.55 }, 'bottom');
}

function sample(t: Track | null, i: number): { x: number; bx: number; by: number } {
  if (!t) return { x: lv.physics.startX, bx: lv.physics.startX, by: 1.25 - lv.physics.L };
  const k = Math.max(0, Math.min(t.x.length - 1, i));
  return { x: t.x[k]!, bx: t.bx[k]!, by: t.by[k]! };
}

function paintScene(p: { x: number; bx: number; by: number }, ghost: { x: number; bx: number; by: number } | null): SideCam | null {
  const cv = ui.elements().canvas;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = layout.scene.w;
  const hgt = layout.scene.h;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(hgt * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(hgt * dpr);
  }
  const g = cv.getContext('2d');
  if (!g) return null;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const grad = g.createLinearGradient(0, 0, 0, hgt);
  grad.addColorStop(0, '#F3EEE4');
  grad.addColorStop(1, '#E6DCCB');
  g.fillStyle = grad;
  g.fillRect(0, 0, w, hgt);
  const cam = camFor(p.bx, p.x);
  drawSideView(g, lv, cam, { grid: true, trolleyX: p.x, ball: { x: p.bx, y: p.by }, ghost, egg: lv.cargo === 'egg', lineScale: 1.2, aiPath: screenId === 'title' || !track ? null : pairs(track), aiPathStep: 2 });
  return cam;
}

// ---------------------------------------------------------------- scenarios

let frame = 0;
let hudState: HudState | null = null;
const deckOf = (p: { x: number; bx: number }, ghostX: number | null, targetX: number | null): HudState['deck'] => ({
  rail: lv.physics.rail, walls: lv.physics.walls, zones: lv.physics.phases, x: p.x, bx: p.bx, targetX,
  ghostXs: ghostX === null ? [] : [{ kind: 'ai', x: ghostX }, { kind: 'pb', x: ghostX - 0.25 }],
});

function baseHud(): HudState {
  return {
    timeSub: 0, running: false, F: 0, Fmax: lv.physics.Fmax, aiF: null, saturated: false, ampDeg: 0, restDeg: lv.physics.restDeg,
    T: 9.81, Tmax: lv.physics.egg?.Tmax ?? null, nearGapMm: null, offline, mode: 'campaign', hint: null, dailyBalls: null, deck: null,
  };
}

function runFrame(i: number, opts: { running: boolean; ghost: boolean; timeSub?: number }): void {
  const p = sample(track, i);
  const gp = opts.ghost ? sample(track, i + 14) : null;
  const cam = paintScene(p, gp ? { x: gp.x, bx: gp.bx, by: gp.by } : null);
  const hs = baseHud();
  const th = track ? track.th[Math.min(track.th.length - 1, i)]! : 0;
  hs.running = opts.running;
  hs.timeSub = opts.timeSub ?? (opts.running ? i * 2 : 0);
  hs.F = track ? track.f[Math.min(track.f.length - 1, i)]! : 0;
  hs.aiF = opts.ghost && track ? track.f[Math.min(track.f.length - 1, i + 14)]! : null;
  hs.saturated = Math.abs(hs.F) > lv.physics.Fmax * 0.98;
  hs.ampDeg = Math.abs(th) * 57.3 * 1.05;
  const w0 = lv.physics.walls[0];
  if (w0 && opts.running) {
    const d = Math.max(0, Math.hypot(Math.max(w0.x0 - p.bx, 0, p.bx - w0.x1), Math.max(0, p.by - w0.h)) - 0.06) * 1000;
    hs.nearGapMm = d < 250 ? d : null;
  }
  hs.deck = deckOf(p, gp ? gp.x : null, opts.running ? p.x + 0.35 : null);
  if (cam) {
    hs.anchors = {
      pivot: { x: cam.X(p.x), y: cam.Y(1.25) }, ball: { x: cam.X(p.bx), y: cam.Y(p.by) }, pxPerM: cam.s,
      slack: false, holdFrac: 0, reqDeg: w0 && opts.running ? (factsOf(lv).reqDeg[0] ?? null) : null, reqDir: 1,
    };
  }
  hudState = hs;
  ui.hud(hs);
}

function toScreen(x: number, y: number): { x: number; y: number } {
  const p = sample(track, frame);
  const cam = camFor(p.bx, p.x);
  return { x: cam.X(x), y: cam.Y(y) };
}

function loop(fn: (i: number) => void, len: number, stillAt: number): void {
  if (still) {
    fn(stillAt);
    return;
  }
  let t0 = performance.now();
  const tick = (now: number): void => {
    frame = Math.floor(((now - t0) / 1000) * 60);
    if (frame > len + 60) {
      t0 = now;
      frame = 0;
    }
    fn(frame);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

const n = track?.x.length ?? 200;
const par = track?.meta.parSub ?? 300;

function start(): void {
  switch (screenId) {
    case 'title':
      loop((i) => runFrame(i, { running: false, ghost: false, timeSub: 0 }), n, Math.round(n * 0.52));
      ui.show({ id: 'title' });
      break;
    case 'select':
      ui.show({ id: 'select', world });
      break;
    case 'briefing': {
      runFrame(0, { running: false, ghost: false });
      const ai = ctx.briefing!(lv);
      if (ai) ui.show({ id: 'briefing', level: lv, ai });
      break;
    }
    case 'hud':
    case 'hud-1-1': {
      ui.fx({ t: 'levelLoaded', level: lv });
      if (screenId === 'hud-1-1') {
        save.levels['1-1'] = { ...save.levels['1-1']!, cleared: false };
        save.seen.onboarding = false;
      }
      const hint = screenId === 'hud' ? (lv.hints?.[lang]?.[0] ?? null) : null;
      loop(() => {
        runFrame(0, { running: false, ghost: false });
        ui.hud({ ...hudState!, hint });
      }, 1, 0);
      ui.show({ id: 'hud' });
      ui.fx({ t: 'ready' });
      break;
    }
    case 'hud-daily-ready': {
      // Today's daily at READY (§7.5): rack, READY marker, the level's hint.
      ui.fx({ t: 'levelLoaded', level: mockDaily().level });
      loop(() => {
        runFrame(0, { running: false, ghost: false });
        ui.hud({ ...hudState!, mode: 'daily', dailyBalls: ['fail', 'ok', null, null, null], offline: true, hint: lv.hints?.[lang]?.[1] ?? null });
      }, 1, 0);
      ui.show({ id: 'hud' });
      ui.fx({ t: 'ready' });
      break;
    }
    case 'hud-run':
    case 'hud-egg':
    case 'hud-daily': {
      ui.fx({ t: 'levelLoaded', level: screenId === 'hud-daily' ? mockDaily().level : lv });
      ui.show({ id: 'hud' });
      // hud-run: just after the ball crossed the first wall (the near-miss label goes beside it, on the approach side).
      const w0 = lv.physics.walls[0];
      let at = Math.round(par / 2 * 0.62);
      if (screenId === 'hud-run' && track && w0) {
        const k = Array.from(track.bx).findIndex((bx) => bx > w0.x1 + 0.08);
        if (k > 0) at = k;
      }
      loop((i) => {
        runFrame(i, { running: true, ghost: true });
        if (screenId === 'hud-daily') ui.hud({ ...hudState!, mode: 'daily', dailyBalls: ['fail', 'ok', null, null, null], offline: true });
        if (screenId === 'hud-egg') ui.hud({ ...hudState!, T: 12.9 });
      }, n, at);
      frame = at;
      if (screenId === 'hud-run') {
        ui.fx({ t: 'split', index: 0, deltaSub: -28, vs: 'pb' });
        // WallCross fires as the ball passes over the wall's centre line.
        const kc = track && w0 ? Math.max(0, Array.from(track.bx).findIndex((bx) => bx > (w0.x0 + w0.x1) / 2)) : at;
        const b = sample(track, kc);
        ui.fx({ t: 'cross', wall: 0, dir: 1, gapMm: 9, speed: 3.4, px: b.bx, py: b.by }, toScreen(b.bx, b.by));
      }
      break;
    }
    case 'hud-hold':
    case 'hud-success':
    case 'hud-crash':
    case 'hud-practice': {
      ui.fx({ t: 'levelLoaded', level: lv });
      ui.show({ id: 'hud' });
      const at = screenId === 'hud-crash' ? Math.round(par / 2 * 0.62) : n - 1;
      frame = at;
      runFrame(at, { running: screenId === 'hud-hold' || screenId === 'hud-practice', ghost: screenId !== 'hud-success', timeSub: screenId === 'hud-crash' ? at * 2 : par + 40 });
      const hs = hudState!;
      if (screenId === 'hud-success') ui.hud({ ...hs, anchors: { ...hs.anchors!, holdFrac: 1 } });
      if (screenId === 'hud-hold') ui.hud({ ...hs, anchors: { ...hs.anchors!, holdFrac: 0.7 }, nearGapMm: null, ampDeg: 1.8 });
      if (screenId === 'hud-practice') ui.hud({ ...hs, mode: 'practice', running: false, timeSub: 0, nearGapMm: null, hint: lv.hints?.[lang]?.[2] ?? null });
      const b = sample(track, at);
      const pos = toScreen(b.bx, b.by);
      if (screenId === 'hud-success') ui.fx({ t: 'success', score: par + 40, medal: 3, crown: false, firstCrown: false, pb: true, badges: ['pashi'] }, pos);
      if (screenId === 'hud-crash') {
        ui.fx({ t: 'crash', kind: 1, wall: 0, x: b.bx, y: b.by, overlapMm: 4 }, pos);
        ui.toast(lang === 'ja' ? '技「ブレーキ振り出し」を見つけた' : 'Trick found: Brake fling', 'badge');
      }
      break;
    }
    case 'pause':
    case 'pause-practice':
      ui.fx({ t: 'levelLoaded', level: lv });
      runFrame(Math.round(n * 0.4), { running: true, ghost: true });
      // Practice mode (×0.5): the menu adds "rewind 5 s" (§3.5).
      if (screenId === 'pause-practice') ui.hud({ ...hudState!, mode: 'practice' });
      ui.show({ id: 'pause' });
      break;
    case 'results':
    case 'results-fail':
    case 'results-crown':
    case 'results-firstcrown':
    case 'results-practice':
    case 'ailost':
    case 'share': {
      const v = screenId === 'results-fail' ? 'fail' : screenId === 'results-crown' || screenId === 'results-firstcrown' || screenId === 'ailost' ? 'crown' : screenId === 'results-practice' ? 'practice' : 'ok';
      ui.fx({ t: 'levelLoaded', level: lv });
      const data = mockResults(levelId, v);
      runFrame(n - 1, { running: false, ghost: false, timeSub: v === 'fail' ? 7200 : data.score ?? 0 });
      if (v === 'fail') ui.fx({ t: 'timeout', reason: 'swing', value: 5.2 });
      else {
        // The game's own verdict comes with the 'success' event (practice runs keep no PB or medal).
        if (v === 'practice') ui.hud({ ...hudState!, mode: 'practice' });
        ui.fx({ t: 'success', score: data.score!, medal: data.medal, crown: data.crown, firstCrown: screenId === 'results-firstcrown', pb: v !== 'practice', badges: data.badges });
      }
      for (let k = 0; k < toastCount; k++) {
        ui.toast(lang === 'ja' ? ['技「ブレーキ振り出し」を見つけた!', 'バッジ「パシッ」', 'ワールド 3 が開いた!'][k % 3]! : ['Trick found: Brake Fling!', 'Badge: Snap!', 'World 3 unlocked!'][k % 3]!, k === 2 ? 'info' : 'badge');
      }
      const openCard = (): void => {
        ui.show({ id: 'results', data });
        if (screenId === 'share') {
          setTimeout(() => (document.querySelector('.res-row .btn--gold') as HTMLElement | null)?.click(), 50);
        }
      };
      if (beat > 0) setTimeout(openCard, beat);
      else openCard();
      break;
    }
    case 'demo': {
      const cn = calm?.x.length ?? n;
      loop((i) => {
        const k = Math.floor(i / 2);
        const p = sample(calm ?? track, k);
        paintScene(p, null);
        const hs = baseHud();
        hs.mode = 'demo';
        hs.running = true;
        hs.timeSub = k * 2;
        ui.hud(hs);
      }, cn * 2, Math.round(cn * 0.9));
      ui.show({ id: 'demo', level: lv });
      break;
    }
    case 'board':
      ui.show({ id: 'board', key: `L:${levelId}:00000000:s1` });
      break;
    case 'daily':
      ui.show({ id: 'daily', data: mockDaily() });
      break;
    case 'settings':
      ui.show({ id: 'settings' });
      break;
    case 'about':
      ui.show({ id: 'about' });
      break;
    case 'notes':
      ui.show({ id: 'notes', world: Math.max(1, world) });
      break;
    default:
      ui.show({ id: screenId as 'title' } as Screen);
  }
  if (screenId === 'toast') {
    ui.toast(lang === 'ja' ? 'バッジ「紙一重」' : 'Badge: Paper-thin', 'badge');
  }
}

if (!defer) start();
if (toastCount && !screenId.startsWith('results')) {
  for (let k = 0; k < toastCount; k++) ui.toast(lang === 'ja' ? ['ゴースト：AIだけ', 'AIのライン：非表示', 'ミュート'][k % 3]! : ['Ghosts: AI only', 'AI line: off', 'Muted'][k % 3]!, 'info');
}

// Log actions (useful when clicking around).
for (const a of ['retry', 'next', 'demo', 'board', 'share', 'resume', 'practice', 'select', 'openLevel', 'openDaily', 'settingsChanged', 'skip', 'rerollName', 'assistAccept', 'ghostCycle', 'aiLine', 'notes', 'mute', 'reverseHint', 'pause', 'rewind'] as const) {
  ui.on(a, (p) => {
    console.info('[ui-demo] action', a, p ?? '');
    const el = document.getElementById('demo-log');
    if (el) el.textContent = `${a} ${p ? JSON.stringify(p) : ''}`;
    if (a === 'rerollName') save.id.nameSeed = (save.id.nameSeed + 37) % 65536;
    // Behave like core for the key-less toggles (§3.3): offline skips the WR / rival ghost sets.
    if (a === 'ghostCycle') {
      let g = save.settings.ghostSet;
      do g = ((g + 1) % 5) as typeof g; while (offline && (g === 2 || g === 3));
      save.settings.ghostSet = g;
    }
    if (a === 'aiLine') save.settings.aiLine = !(save.settings.aiLine ?? lv.world <= 2);
    if (a === 'mute') save.settings.muted = !save.settings.muted;
    if (a === 'board') ui.show({ id: 'board', key: `L:${levelId}:00000000:s1` });
    if (a === 'notes') ui.show({ id: 'notes', world: (p as { world?: number } | undefined)?.world ?? 1 });
    if (a === 'openDaily') ui.show({ id: 'daily', data: mockDaily() });
  });
}

declare global {
  interface Window {
    __UI_DEMO__?: {
      ready: boolean; ui: UI; screen: string; card(): { w: number; h: number; png: string };
      /** &defer=1: runs the scenario now (returns performance.now() at the start). */
      start(): number;
      /** Screen position of a world point in the current (still) frame's mock camera. */
      toScreen(x: number, y: number): { x: number; y: number };
      layout(): Layout;
    };
  }
}

window.__UI_DEMO__ = {
  ready: false,
  ui,
  screen: screenId,
  card() {
    const cv = drawShareCard(mockResults(levelId, 'ok'), track ? pairs(track) : null);
    return { w: cv.width, h: cv.height, png: cv.toDataURL('image/png') };
  },
  toScreen,
  layout: () => layout,
  start: () => {
    const t0 = performance.now();
    if (defer) start();
    return t0;
  },
};
void (document.fonts?.ready ?? Promise.resolve()).then(() => {
  setTimeout(() => {
    window.__UI_DEMO__!.ready = true;
  }, 120);
});
