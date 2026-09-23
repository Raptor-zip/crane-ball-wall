// Input demo (GAME_DESIGN.md §3, milestone M3): the real InputManager + servo driving the real
// simulation (src/sim) in a small side view. Touch (deck clutch + fine band on tall screens, absolute
// on wide), mouse press-drag and keyboard all move the target ring. Owner: O4.
// R10: key taps (a press under 150 ms steps the hold point 5 cm, Shift/Z 1 cm; the panel shows "tap"), keyboard
// fine 0.5 m/s, and the fragile-cargo caps on egg levels (4-3: 2.0 / 0.5 m/s; the panel shows T against Tmax).
// Practice (button ×½ or ?practice=1): ×0.5 speed and a 5 s rewind ring like src/core/session.ts;
// hold R ≥ 0.3 s to rewind (D3), a short R press retries on key-up.
// Dev only: served by `npm run dev` at /dev/input-demo.html (never part of the production build).
import levelsJson from '../src/data/levels.json';
import { createInputManager } from '../src/input/manager';
import { KEY_RAMP } from '../src/input/keyboard';
import { servoQ, speedCap } from '../src/input/servo';
import type { Command, InputFrame, RailMapper } from '../src/input/types';
import type { Layout } from '../src/render/renderer';
import { tallWindowFor } from '../src/render/camera';
import type { LevelDef, LevelPhysics, LevelsFile } from '../src/sim/level';
import { copyState, createRun, newSimState, resetRun, restoreState, stepTick, type Run, type SimState } from '../src/sim/run';
import { SimEvents } from '../src/sim/events';

const RAIL_Y = 1.25, BALL_R = 0.06, BEAM_Y = 1.3;
// Status / Mode / CrashKind / Ev values of src/sim (§10.4).
const ST_SUCCESS = 2, ST_CRASH = 3, ST_TIMEOUT = 4, MODE_SLACK = 1;
const EV_SNAP = 1, EV_STOP = 3;
const CRASH_TEXT = ['', 'ゴツン!', '紐が引っかかった', 'レールに激突', '床に激突', 'たまごが割れた'];
const HUD = 56;
const DEVICE = ['不明 Unknown', 'タッチ Touch', 'マウス Mouse', 'キーボード Keyboard', 'パッド Gamepad', '混在 Mixed'];
const COLORS = {
  paper1: '#F3EEE4', paper2: '#E6DCCB', floor: '#D9D4CB', grid: '#C9C2B6', brick: '#B5553A', mortar: '#E8DCC8',
  gantry: '#F2B705', hazard: '#1E1E1E', rail: '#6B7280', ball: '#E0312B', string: '#2B2B2B', ink: '#1E2A44',
  goal: '#22B573', danger: '#E5484D', ai: '#19C3FF', stamp: '#D8342B',
};

const levels = (levelsJson as unknown as LevelsFile).levels;
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const sceneEl = $('scene'), deckEl = $('deck'), view = $<HTMLCanvasElement>('view'), deckView = $<HTMLCanvasElement>('deckView');
const readout = $('readout'), cmdBox = $('cmds'), clock = $('clock'), nameEl = $('name'), levelSel = $<HTMLSelectElement>('level');
const kbBtn = $('kbmode'), assistBtn = $('assist'), latchBtn = $('latch'), practiceBtn = $('practice');

// ---------------------------------------------------------------- state
let level: LevelDef = levels[0];
let phys: LevelPhysics = level.physics;
let run: Run = createRun(phys);
const ev = new SimEvents();
let status: 'ready' | 'running' | 'crash' | 'success' | 'timeout' = 'ready';
let crashT = 0, crashWhy = '', flash = 0;
let assist = false, keyboardForce = false;
let frame: InputFrame | null = null;
let lastQ = 0, satTicks = 0, trauma = 0, ringPulse = 0, stampT = 0;
let camX = 0, camV = 0;
let layout: Layout = computeLayout();
const finger = { on: false, x: 0, y: 0, fine: false };

// The stop latch (D1) is what the game uses; ?latch=0 or the L button switch to the non-default literal
// §3.3 hold (the stop tick's x) for comparison only.
const params = new URLSearchParams(location.search);
let stopLatch = params.get('latch') !== '0';
let input = createInputManager({ stopLatch });

// Practice (§3.5): ×0.5 and a 5 s rewind ring of SimStates (the game's session does the same).
const REWIND_TICKS = 300, PRACTICE_SPEED = 0.5;
const ring: SimState[] = Array.from({ length: REWIND_TICKS }, () => newSimState());
const ringTick = new Int32Array(REWIND_TICKS).fill(-1);
let runTicks = 0, rewindFx = 0, rewinds = 0;
let practice = params.get('practice') === '1';
input.setPractice(practice);

function record(): void {
  const i = runTicks % REWIND_TICKS;
  copyState(run.s, ring[i]);
  ringTick[i] = runTicks;
}

/** Back by up to `sec` seconds (also out of a crash, which the demo allows). */
function rewind(sec: number): boolean {
  if (!practice || !(status === 'running' || status === 'crash' || status === 'timeout')) return false;
  let target = Math.max(0, runTicks - Math.round(sec * 60));
  while (target < runTicks && ringTick[target % REWIND_TICKS] !== target) target++;
  if (target >= runTicks) return false;
  restoreState(run, ring[target % REWIND_TICKS]);
  runTicks = target;
  status = 'running';
  crashT = 0;
  rewindFx = 1;
  rewinds++;
  return true; // the InputManager notices the older substep and re-anchors its hold point
}

// ---------------------------------------------------------------- simulation (src/sim)
function tick(): void {
  if (status === 'crash' || status === 'timeout') {
    crashT -= 1 / 60;
    if (crashT <= 0) reset();
    return;
  }
  const s = run.s;
  frame = input.sample(s);
  const q = servoQ(frame, s, phys, assist);
  lastQ = q;
  satTicks = Math.abs(q) === 127 ? satTicks + 1 : 0;
  if (status === 'success') return; // frozen on the result
  if (status === 'ready') {
    if (q === 0) return; // READY: the world waits for the first non-zero q (tick 0, §4.7)
    status = 'running';
    ringPulse = 1;
    runTicks = 0; // the ring holds post-step (RUNNING) states only: the oldest rewind target is tick 1
  }
  const st = stepTick(run, q, ev);
  runTicks++;
  record();
  for (let i = 0; i < ev.n; i++) {
    if (ev.kind[i] === EV_SNAP) {
      trauma = Math.min(1, trauma + 0.15 + 0.1 * ev.a[i]);
      flash = 1;
    } else if (ev.kind[i] === EV_STOP) {
      trauma = Math.min(1, trauma + 0.4 * Math.min(1, ev.b[i] / 4));
    }
  }
  if (st === ST_CRASH) {
    status = 'crash';
    crashWhy = CRASH_TEXT[s.crash?.kind ?? 1] ?? 'ゴツン!';
    crashT = 0.7;
    trauma = 1;
  } else if (st === ST_SUCCESS) {
    status = 'success';
    stampT = 0;
  } else if (st === ST_TIMEOUT) {
    status = 'timeout';
    crashWhy = 'タイムアップ';
    crashT = 1.2;
  }
}

function reset(): void {
  resetRun(run);
  runTicks = 0;
  ringTick.fill(-1);
  status = 'ready';
  satTicks = lastQ = 0;
  input.resetForRun(phys.startX);
}

function loadLevel(i: number): void {
  level = levels[i];
  phys = level.physics;
  run = createRun(phys);
  input.setLevel(phys);
  nameEl.textContent = `${level.id} ${level.name.ja}`;
  reset();
  camX = phys.startX;
  camV = 0;
}

// ---------------------------------------------------------------- layout, camera and mapper
function computeLayout(): Layout {
  const w = window.innerWidth, h = window.innerHeight, dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (h / w >= 1.25) {
    const sh = Math.round(h * 0.62);
    return { kind: 'tall', w, h, dpr, scene: { x: 0, y: 0, w, h: sh }, deck: { x: 0, y: sh, w, h: h - sh }, hudTop: HUD };
  }
  return { kind: 'wide', w, h, dpr, scene: { x: 0, y: 0, w, h }, deck: null, hudTop: HUD };
}

function wideRange(): [number, number] {
  return level.view?.wideX ?? [phys.rail[0] - 0.3, phys.rail[1] + 0.3];
}

interface Xf { sx: number; ox: number; oy: number }
/** The unshaken world -> CSS px transform (the reference camera of §3.3). */
function baseXf(): Xf {
  const { w, h } = layout.scene;
  if (layout.kind === 'wide') {
    const [x0, x1] = wideRange(), y0 = -0.35, y1 = 1.6;
    const sx = Math.min((w - 24) / (x1 - x0), (h - HUD - 16) / (y1 - y0));
    const ox = (w - sx * (x1 - x0)) / 2 - x0 * sx;
    const top = HUD + (h - HUD - sx * (y1 - y0)) / 2;
    return { sx, ox, oy: top + y1 * sx };
  }
  const W = tallWindowFor(level.view?.portraitWindow);
  const sx = w / W;
  return { sx, ox: w / 2 - camX * sx, oy: h - 10 - 0.05 * sx };
}

const mapper: RailMapper = {
  screenToRailX(cx: number, cy: number): number | null {
    if (layout.kind !== 'wide' || cy < HUD) return null;
    const t = baseXf();
    return (cx - t.ox) / t.sx;
  },
};

function applyLayout(): void {
  layout = computeLayout();
  const tall = layout.kind === 'tall';
  document.body.classList.toggle('tall', tall);
  Object.assign(sceneEl.style, { width: `${layout.scene.w}px`, height: `${layout.scene.h}px` });
  const hud = $('hud');
  hud.style.width = `${layout.scene.w}px`;
  deckEl.style.display = tall ? 'block' : 'none';
  if (layout.deck) Object.assign(deckEl.style, { width: `${layout.deck.w}px`, height: `${layout.deck.h}px` });
  for (const [c, r] of [[view, layout.scene], [deckView, layout.deck]] as const) {
    if (!r) continue;
    c.width = Math.round(r.w * layout.dpr);
    c.height = Math.round(r.h * layout.dpr);
  }
  input.attach(sceneEl, tall ? deckEl : null, mapper, layout); // re-attach resets the clutch
}

// ---------------------------------------------------------------- drawing
function drawScene(dt: number): void {
  const ctx = view.getContext('2d');
  if (!ctx) return;
  const s = run.s;
  const { w, h } = layout.scene;
  ctx.setTransform(layout.dpr, 0, 0, layout.dpr, 0, 0);
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, COLORS.paper1);
  g.addColorStop(1, COLORS.paper2);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  // Follow camera for tall (critically damped spring, 0.25 s) - the deck does not care about it.
  if (layout.kind === 'tall') {
    const W = tallWindowFor(level.view?.portraitWindow);
    const [X0, X1] = wideRange();
    const want = Math.min(Math.max((s.x + s.bx) / 2 + 0.3 * s.v, X0 + W / 2), X1 - W / 2);
    const om = 8;
    camV += ((want - camX) * om * om - 2 * om * camV) * dt;
    camX += camV * dt;
  }
  const t = baseXf();
  trauma = Math.max(0, trauma - 1.8 * dt);
  const t2 = trauma * trauma, now = performance.now() / 1000;
  const shx = Math.sin(now * 53) * 0.05 * t2 * t.sx, shy = Math.cos(now * 41) * 0.05 * t2 * t.sx;
  ctx.save();
  ctx.translate(shx, shy); // drawing shakes, the mapper keeps using the base transform
  ctx.translate(w / 2, h / 2);
  ctx.rotate(((1.2 * Math.PI) / 180) * t2 * Math.sin(now * 37));
  ctx.translate(-w / 2, -h / 2);
  const X = (x: number): number => t.ox + x * t.sx;
  const Y = (y: number): number => t.oy - y * t.sx;
  const M = (m: number): number => m * t.sx;

  // floor, finger band and 10 cm grid
  ctx.fillStyle = COLORS.floor;
  ctx.fillRect(-50, Y(0), w + 100, h);
  ctx.lineWidth = 1;
  const xa = Math.floor((0 - t.ox) / t.sx * 10) / 10, xb = (w - t.ox) / t.sx;
  for (let x = xa; x <= xb; x += 0.1) {
    const major = Math.abs(x - Math.round(x)) < 1e-6;
    ctx.strokeStyle = major ? 'rgba(30,42,68,0.28)' : 'rgba(201,194,182,0.9)';
    ctx.beginPath();
    ctx.moveTo(X(x), Y(0));
    ctx.lineTo(X(x), h);
    ctx.stroke();
    if (major) {
      ctx.fillStyle = 'rgba(30,42,68,0.55)';
      ctx.font = '600 11px ui-monospace, monospace';
      ctx.fillText(`${Math.round(x)}m`, X(x) + 3, Y(0) + 13);
    }
  }
  for (let y = -0.1; y > -0.36; y -= 0.1) {
    ctx.strokeStyle = 'rgba(201,194,182,0.9)';
    ctx.beginPath();
    ctx.moveTo(0, Y(y));
    ctx.lineTo(w, Y(y));
    ctx.stroke();
  }
  ctx.strokeStyle = COLORS.ink;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-50, Y(0));
  ctx.lineTo(w + 50, Y(0));
  ctx.stroke();

  // goal zones
  phys.phases.forEach((z, i) => {
    const on = i === s.phase;
    ctx.fillStyle = on ? 'rgba(34,181,115,0.20)' : 'rgba(34,181,115,0.07)';
    ctx.fillRect(X(z.xa), Y(0.9), M(z.xb - z.xa), M(0.9));
    ctx.fillStyle = COLORS.goal;
    ctx.fillRect(X(z.xa), Y(0.015), M(z.xb - z.xa), M(0.015) + 3);
  });

  // walls (bricks)
  for (const wl of phys.walls) {
    ctx.fillStyle = COLORS.brick;
    ctx.fillRect(X(wl.x0), Y(wl.h), M(wl.x1 - wl.x0), M(wl.h));
    ctx.strokeStyle = COLORS.mortar;
    ctx.lineWidth = 1;
    for (let y = 0.06; y < wl.h; y += 0.06) {
      ctx.beginPath();
      ctx.moveTo(X(wl.x0), Y(y));
      ctx.lineTo(X(wl.x1), Y(y));
      ctx.stroke();
    }
    ctx.strokeStyle = COLORS.ink;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(X(wl.x0), Y(wl.h), M(wl.x1 - wl.x0), M(wl.h));
  }

  // gantry beam and bumpers
  const [r0, r1] = phys.rail;
  ctx.fillStyle = COLORS.gantry;
  ctx.fillRect(X(r0 - 0.2), Y(BEAM_Y + 0.1), M(r1 - r0 + 0.4), M(0.1));
  ctx.strokeStyle = COLORS.ink;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(X(r0 - 0.2), Y(BEAM_Y + 0.1), M(r1 - r0 + 0.4), M(0.1));
  for (const [bx, dir] of [[r0 - 0.12, -1], [r1 + 0.12, 1]] as const) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(X(bx - 0.04), Y(BEAM_Y), M(0.08), M(0.07));
    ctx.clip();
    ctx.fillStyle = COLORS.gantry;
    ctx.fillRect(X(bx - 0.04), Y(BEAM_Y), M(0.08), M(0.07));
    ctx.strokeStyle = COLORS.hazard;
    ctx.lineWidth = M(0.015);
    for (let k = -4; k < 6; k++) {
      ctx.beginPath();
      ctx.moveTo(X(bx - 0.06 + k * 0.03), Y(BEAM_Y - 0.08));
      ctx.lineTo(X(bx - 0.06 + k * 0.03 + 0.06 * dir), Y(BEAM_Y + 0.02));
      ctx.stroke();
    }
    ctx.restore();
  }

  // target ring + tether (§3.4)
  const tx = frame?.targetX ?? null;
  const Fn = Math.min(1, Math.abs(lastQ) / 127);
  const saturated = satTicks >= 3;
  if (tx !== null) {
    ringPulse = Math.max(0, ringPulse - dt * 2.5);
    ctx.setLineDash([4, 5]);
    ctx.strokeStyle = 'rgba(30,42,68,0.45)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(X(tx), Y(RAIL_Y - 0.07));
    ctx.lineTo(X(tx), Y(0));
    ctx.stroke();
    ctx.setLineDash([]);
    // tether: a zigzag spring between the ring and the hook
    const x0 = X(tx), x1 = X(s.x), yy = Y(RAIL_Y);
    const n = 10, amp = saturated ? 5 + 2 * Math.sin(now * 40) : 4;
    ctx.strokeStyle = saturated ? COLORS.danger : `rgba(30,42,68,${0.2 + 0.8 * Fn})`;
    ctx.lineWidth = saturated ? 2.5 : 1.5 + Fn;
    ctx.beginPath();
    ctx.moveTo(x0, yy);
    for (let i = 1; i < n; i++) ctx.lineTo(x0 + ((x1 - x0) * i) / n, yy + (i % 2 ? -amp : amp));
    ctx.lineTo(x1, yy);
    ctx.stroke();
    const rr = M(0.075) * (1 + 0.5 * ringPulse);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = frame?.fine ? COLORS.goal : COLORS.ink;
    ctx.beginPath();
    ctx.arc(X(tx), Y(RAIL_Y), rr, 0, Math.PI * 2);
    ctx.stroke();
  }

  // trolley, string, ball
  ctx.fillStyle = COLORS.ink;
  ctx.beginPath();
  ctx.roundRect(X(s.x - 0.12), Y(BEAM_Y), M(0.24), M(0.05), 3);
  ctx.fill();
  ctx.fillStyle = COLORS.rail;
  for (const dx of [-0.08, 0.08]) {
    ctx.beginPath();
    ctx.arc(X(s.x + dx), Y(BEAM_Y + 0.02), M(0.022), 0, Math.PI * 2);
    ctx.fill();
  }
  flash = Math.max(0, flash - dt / 0.08);
  ctx.strokeStyle = flash > 0 ? '#ffffff' : COLORS.string;
  ctx.lineWidth = flash > 0 ? 3 : 1.6;
  ctx.beginPath();
  ctx.moveTo(X(s.x), Y(RAIL_Y));
  if (s.mode === MODE_SLACK) {
    // Slack: sag a quadratic curve by how much shorter than L the chord is (§9.5).
    const chord = Math.hypot(s.bx - s.x, s.by - RAIL_Y);
    const sag = Math.max(0, phys.L - chord) * 0.7;
    ctx.quadraticCurveTo(X((s.x + s.bx) / 2), Y((RAIL_Y + s.by) / 2 - sag), X(s.bx), Y(s.by));
  } else {
    ctx.lineTo(X(s.bx), Y(s.by));
  }
  ctx.stroke();
  ctx.fillStyle = COLORS.ball;
  ctx.beginPath();
  ctx.arc(X(s.bx), Y(s.by), M(BALL_R), 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.beginPath();
  ctx.arc(X(s.bx) - M(0.02), Y(s.by) - M(0.022), M(0.018), 0, Math.PI * 2);
  ctx.fill();
  const hold = s.hold;
  if (hold > 0 && status === 'running') {
    ctx.strokeStyle = COLORS.goal;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(X(s.bx), Y(s.by), M(BALL_R) + 6, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * hold) / 60);
    ctx.stroke();
  }
  ctx.restore();

  // force bar (wide: bottom centre; tall: on the deck)
  if (layout.kind === 'wide') drawForceBar(ctx, w / 2 - Math.min(220, w * 0.2), h - 22, Math.min(440, w * 0.4), 10, saturated);

  // stamps
  if (status === 'crash' || status === 'timeout') {
    ctx.fillStyle = `rgba(229,72,77,${0.18 * Math.min(1, crashT / 0.7)})`;
    ctx.fillRect(0, 0, w, h);
    stamp(ctx, w / 2, h * 0.42, crashWhy, COLORS.danger, 1);
  } else if (status === 'success') {
    stampT = Math.min(1, stampT + dt / 0.12);
    const k = stampT < 1 ? 1.6 - 0.75 * stampT : 1;
    stamp(ctx, w / 2, h * 0.42, 'ピタッ!', COLORS.stamp, k);
    ctx.fillStyle = COLORS.ink;
    ctx.font = '700 16px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`${(s.score / 120).toFixed(3)} s  ·  R / Enter`, w / 2, h * 0.42 + 54);
    ctx.textAlign = 'start';
  }
  if (rewindFx > 0) {
    rewindFx = Math.max(0, rewindFx - dt / 0.6);
    ctx.fillStyle = `rgba(25,195,255,${0.16 * rewindFx})`;
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = Math.min(1, rewindFx * 2);
    stamp(ctx, w / 2, h * 0.3, '⏪ −5 s', COLORS.ai, 0.8);
    ctx.globalAlpha = 1;
  }
}

function stamp(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, color: string, k: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(k, k);
  ctx.rotate(-0.08);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 4;
  ctx.font = '800 34px "M PLUS Rounded 1c", "Hiragino Maru Gothic ProN", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const tw = ctx.measureText(text).width;
  ctx.beginPath();
  ctx.roundRect(-tw / 2 - 18, -30, tw + 36, 60, 30);
  ctx.stroke();
  ctx.fillText(text, 0, 2);
  ctx.restore();
}

function drawForceBar(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, sat: boolean): void {
  const f = lastQ / 127;
  ctx.fillStyle = 'rgba(30,42,68,0.12)';
  ctx.fillRect(x, y, w, h);
  const blink = sat && Math.floor(performance.now() / 90) % 2 === 0;
  ctx.fillStyle = sat ? (blink ? COLORS.danger : '#f4a3a5') : COLORS.ink;
  const cx = x + w / 2;
  ctx.fillRect(Math.min(cx, cx + (f * w) / 2), y, Math.abs((f * w) / 2), h);
  ctx.fillStyle = COLORS.ink;
  ctx.fillRect(cx - 1, y - 2, 2, h + 4);
}

function drawDeck(): void {
  if (layout.kind !== 'tall' || !layout.deck) return;
  const ctx = deckView.getContext('2d');
  if (!ctx) return;
  const s = run.s;
  const { w, h } = layout.deck;
  ctx.setTransform(layout.dpr, 0, 0, layout.dpr, 0, 0);
  ctx.fillStyle = '#ECE5D8';
  ctx.fillRect(0, 0, w, h);
  drawForceBar(ctx, 0, 0, w, 8, satTicks >= 3);

  // mini rail (72 px): the whole rail, like the deck mapping
  const [r0, r1] = phys.rail;
  const pad = 14, mx = (x: number): number => pad + ((x - r0) / (r1 - r0)) * (w - 2 * pad);
  const base = 8 + 60;
  ctx.strokeStyle = 'rgba(30,42,68,0.35)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(mx(r0), base);
  ctx.lineTo(mx(r1), base);
  ctx.stroke();
  for (const z of phys.phases) {
    ctx.fillStyle = 'rgba(34,181,115,0.35)';
    ctx.fillRect(mx(z.xa), base - 4, mx(z.xb) - mx(z.xa), 4);
  }
  for (const wl of phys.walls) {
    ctx.fillStyle = COLORS.brick;
    const hh = wl.h * 34;
    ctx.fillRect(mx(wl.x0), base - hh, Math.max(3, mx(wl.x1) - mx(wl.x0)), hh);
  }
  ctx.fillStyle = COLORS.ink;
  ctx.fillRect(mx(s.x) - 6, 14, 12, 5);
  ctx.strokeStyle = COLORS.string;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(mx(s.x), 19);
  ctx.lineTo(mx(s.bx), 19 + (RAIL_Y - s.by) * 34);
  ctx.stroke();
  ctx.fillStyle = COLORS.ball;
  ctx.beginPath();
  ctx.arc(mx(s.bx), 19 + (RAIL_Y - s.by) * 34, 4, 0, Math.PI * 2);
  ctx.fill();
  const tx = frame?.targetX ?? null;
  if (tx !== null) {
    ctx.strokeStyle = frame?.fine ? COLORS.goal : COLORS.ink;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(mx(tx), 16, 6, 0, Math.PI * 2);
    ctx.stroke();
  }

  // control surface + fine band (bottom third, ×1/3)
  const top = 80, sh = h - 80, bandTop = top + sh * (2 / 3);
  ctx.strokeStyle = 'rgba(30,42,68,0.12)';
  ctx.beginPath();
  ctx.moveTo(0, top + 0.5);
  ctx.lineTo(w, top + 0.5);
  ctx.stroke();
  for (let gx = 12; gx < w; gx += 24) {
    for (let gy = top + 12; gy < bandTop; gy += 24) {
      ctx.fillStyle = 'rgba(30,42,68,0.10)';
      ctx.fillRect(gx, gy, 2, 2);
    }
  }
  ctx.fillStyle = 'rgba(34,181,115,0.10)';
  ctx.fillRect(0, bandTop, w, h - bandTop);
  ctx.setLineDash([5, 5]);
  ctx.strokeStyle = 'rgba(34,181,115,0.55)';
  ctx.beginPath();
  ctx.moveTo(0, bandTop + 0.5);
  ctx.lineTo(w, bandTop + 0.5);
  ctx.stroke();
  ctx.setLineDash([]);
  for (let gx = 4; gx < w; gx += 8) {
    ctx.fillStyle = 'rgba(34,181,115,0.22)';
    ctx.fillRect(gx, bandTop + 10, 1, 6);
  }
  ctx.fillStyle = 'rgba(21,120,76,0.9)';
  ctx.font = '800 13px ui-monospace, monospace';
  ctx.textAlign = 'right';
  ctx.fillText('×1/3', w - 10, bandTop + 18);
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(30,42,68,0.35)';
  ctx.font = '600 12px "M PLUS Rounded 1c", system-ui, sans-serif';
  ctx.fillText('← どこでもドラッグ →', w / 2, top + (bandTop - top) / 2 + 4);
  ctx.textAlign = 'start';

  if (finger.on) {
    const y = finger.y - layout.deck.y;
    ctx.fillStyle = finger.fine ? 'rgba(34,181,115,0.25)' : 'rgba(30,42,68,0.15)';
    ctx.strokeStyle = finger.fine ? COLORS.goal : COLORS.ink;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(finger.x, y, 22, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}

function drawPanel(): void {
  const f = frame;
  const it = f?.intent;
  const intent = !it ? '-' : it.kind === 'target' ? `target ${it.x.toFixed(3)}` : it.kind === 'velocity' ? `velocity ${it.v.toFixed(1)}`
    : it.kind === 'force' ? `force ${it.f.toFixed(1)} N` : 'idle';
  const d = input.debug();
  // The fine cap of the device in control: the keyboard ramp stops at 0.5 m/s (R10), the servo caps the rest.
  const fineCap = d.active === 'keyboard' ? Math.min(KEY_RAMP.capFine / KEY_RAMP.perMps, speedCap(phys, true)) : speedCap(phys, true);
  const fineText = !f?.fine ? 'off' : `on (${fineCap.toFixed(1)} m/s${d.drag?.fine ? ', ×1/3' : ''})`;
  const tension = phys.egg ? `${run.s.T.toFixed(1)} / ${phys.egg.Tmax} N` : '—';
  readout.innerHTML = [
    `<b>${status === 'ready' ? 'READY — 動かすとスタート' : status.toUpperCase()}</b>`,
    `<span class="k">device</span>${DEVICE[f?.device ?? 0]}`,
    `<span class="k">intent</span>${intent}`,
    `<span class="k">targetX</span>${f?.targetX === null || !f ? '—' : f.targetX.toFixed(3) + ' m'}`,
    `<span class="k">q / F</span>${lastQ} / ${((lastQ * phys.Fmax) / 127).toFixed(1)} N`,
    `<span class="k">fine</span>${fineText}${d.latching ? ' · latch' : ''}${d.tapHold ? ' · tap' : ''}`,
    `<span class="k">cap</span>${speedCap(phys, false).toFixed(1)} m/s${phys.egg ? '（たまご / egg）' : ''}`,
    `<span class="k">T</span>${tension}`,
    `<span class="k">drag</span>${d.drag ? `${d.drag.mode} k=${d.drag.k.toFixed(2)}` : '—'}`,
    `<span class="k">keys</span>${d.keyboardMode === 'force' ? '直接押す force' : '速度 speed'}${assist ? ' · assist' : ''}`,
    `<span class="k">stop</span>${stopLatch ? 'latch（既定）' : 'literal（比較用）'}`,
    `<span class="k">practice</span>${practice ? `×0.5 · ⏪ ${rewinds}` : 'off'}`,
  ].join('<br>');
  const t = (status === 'success' ? run.s.score : run.s.substep) / 120;
  clock.textContent = ` ${t.toFixed(status === 'running' ? 2 : 3)}`;
}

// ---------------------------------------------------------------- commands and UI
function onCommand(c: Command): void {
  if (c !== 'any') {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = c;
    chip.addEventListener('animationend', (e) => {
      if (e.animationName === 'fade') chip.remove();
    });
    cmdBox.appendChild(chip);
    while (cmdBox.childElementCount > 6) cmdBox.firstElementChild?.remove();
  }
  if (c === 'rewind') rewind(5);
  else if (c === 'retry') reset();
  else if (c === 'confirm' && status === 'success') reset();
  else if (c === 'next') levelSel.value = String((levels.indexOf(level) + 1) % levels.length), loadLevel(Number(levelSel.value));
  else if (c === 'any' && (status === 'crash' || status === 'timeout')) reset();
}
input.onCommand(onCommand);

levels.forEach((l, i) => {
  const o = document.createElement('option');
  o.value = String(i);
  o.textContent = l.id;
  levelSel.appendChild(o);
});
levelSel.addEventListener('change', () => {
  loadLevel(Number(levelSel.value));
  levelSel.blur();
});
$('retry').addEventListener('click', () => reset());
kbBtn.addEventListener('click', () => {
  keyboardForce = !keyboardForce;
  input.setKeyboardMode(keyboardForce ? 'force' : 'speed');
  kbBtn.setAttribute('aria-pressed', String(keyboardForce));
  kbBtn.blur();
});
latchBtn.setAttribute('aria-pressed', String(stopLatch));
latchBtn.addEventListener('click', () => {
  // Rebuild the manager with the other stop rule (the demo only; the game uses the default).
  stopLatch = !stopLatch;
  input.dispose();
  input = createInputManager({ stopLatch });
  input.onCommand(onCommand);
  input.setKeyboardMode(keyboardForce ? 'force' : 'speed');
  input.setPractice(practice);
  input.setLevel(phys);
  applyLayout();
  reset();
  latchBtn.setAttribute('aria-pressed', String(stopLatch));
  latchBtn.blur();
});
function setPractice(on: boolean): void {
  practice = on;
  input.setPractice(on);
  practiceBtn.setAttribute('aria-pressed', String(on));
  reset();
}
practiceBtn.setAttribute('aria-pressed', String(practice));
practiceBtn.addEventListener('click', () => {
  setPractice(!practice);
  practiceBtn.blur();
});
assistBtn.addEventListener('click', () => {
  assist = !assist;
  assistBtn.setAttribute('aria-pressed', String(assist));
  assistBtn.blur();
});
$('shake').addEventListener('click', (e) => {
  trauma = 1;
  (e.currentTarget as HTMLElement).blur();
});

// Finger feedback on the deck (display only; the InputManager does the real work).
deckEl.addEventListener('pointerdown', (e) => {
  const surfTop = layout.deck ? layout.deck.y + 80 : 0, surfH = layout.deck ? layout.deck.h - 80 : 0;
  Object.assign(finger, { on: true, x: e.clientX, y: e.clientY, fine: e.clientY >= surfTop + (surfH * 2) / 3 });
});
window.addEventListener('pointermove', (e) => {
  if (finger.on) Object.assign(finger, { x: e.clientX, y: e.clientY });
});
window.addEventListener('pointerup', () => (finger.on = false));
window.addEventListener('pointercancel', () => (finger.on = false));
window.addEventListener('resize', applyLayout);

// ---------------------------------------------------------------- loop (§4.8: fixed 60 Hz ticks, max 4 per frame)
let acc = 0, last = performance.now();
function frameLoop(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  acc += dt * (practice ? PRACTICE_SPEED : 1);
  let n = 0;
  while (acc >= 1 / 60 && n < 4) {
    tick();
    acc -= 1 / 60;
    n++;
  }
  if (n === 4) acc = 0;
  drawScene(dt);
  drawDeck();
  drawPanel();
  requestAnimationFrame(frameLoop);
}

applyLayout();
loadLevel(0);
requestAnimationFrame(frameLoop);

// For automated checks (Playwright) only.
(window as unknown as { __inputDemo: unknown }).__inputDemo = {
  state: () => ({
    status, x: run.s.x, v: run.s.v, substep: run.s.substep, frame, q: lastQ, layout: layout.kind, debug: input.debug(), stopLatch,
    practice, rewinds,
  }),
  practice: (on: boolean) => setPractice(on),
  load: (id: string) => {
    const i = levels.findIndex((l) => l.id === id);
    if (i >= 0) {
      levelSel.value = String(i);
      loadLevel(i);
    }
  },
};
