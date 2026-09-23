// Canvas-2D side view of a level in the drafting style (§7.13, §8.4 item 5, §9.1). Owner: O7.
// Used by the share card, the strategy card, the daily hub miniature and the dev demo page.
import type { LevelDef, WallDef } from '../sim/level';

export const RAIL_Y = 1.25;
export const BEAM_Y = 1.3;
export const BALL_R = 0.06;

export const C = {
  paper1: '#F3EEE4', paper2: '#E6DCCB', floor: '#D9D4CB', grid: '#C9C2B6',
  brick1: '#B5553A', brick2: '#C8643F', mortar: '#E8DCC8', gantry: '#F2B705', hazard: '#1E1E1E',
  rail: '#6B7280', ball: '#E0312B', string: '#2B2B2B', egg: '#F4EAD5', eggSpeckle: '#C9B89A',
  ink: '#1E2A44', goal: '#22B573', danger: '#E5484D', ai: '#19C3FF', pb: '#FFC23D', stamp: '#D8342B',
};

export const FONT_STACK = '"M PLUS Rounded 1c", "Hiragino Maru Gothic ProN", "Hiragino Sans", "Noto Sans JP", system-ui, sans-serif';
export const NUM_STACK = 'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace';

export interface Box { x: number; y: number; w: number; h: number }
export interface ViewRange { x0: number; x1: number; y0: number; y1: number }

/** World -> canvas mapping with a uniform scale. `align` places the world range inside the box. */
export class SideCam {
  readonly s: number;
  readonly ox: number;
  readonly oy: number;
  constructor(readonly box: Box, readonly range: ViewRange, align: 'center' | 'bottom' = 'center') {
    const sx = box.w / (range.x1 - range.x0);
    const sy = box.h / (range.y1 - range.y0);
    this.s = Math.min(sx, sy);
    const usedW = (range.x1 - range.x0) * this.s;
    const usedH = (range.y1 - range.y0) * this.s;
    this.ox = box.x + (box.w - usedW) / 2 - range.x0 * this.s;
    const top = align === 'bottom' ? box.y + box.h - usedH : box.y + (box.h - usedH) / 2;
    this.oy = top + range.y1 * this.s;
  }
  X(x: number): number { return this.ox + x * this.s; }
  Y(y: number): number { return this.oy - y * this.s; }
  /** Visible world x range of the whole box (wider than `range` when the box is wider). */
  visibleX(): [number, number] { return [(this.box.x - this.ox) / this.s, (this.box.x + this.box.w - this.ox) / this.s]; }
  visibleY(): [number, number] { return [(this.oy - (this.box.y + this.box.h)) / this.s, (this.oy - this.box.y) / this.s]; }
}

export interface SideOpts {
  grid?: boolean;            // 10 cm grid and 1 m labels
  trolleyX?: number | null;  // draws trolley + string + ball when set together with ball
  ball?: { x: number; y: number } | null;
  ghost?: { x: number; bx: number; by: number } | null; // cyan AI ghost
  strobe?: ArrayLike<number> | null;                     // bx,by pairs (oldest first)
  strobeStep?: number;                                    // use every n-th pair
  aiPath?: ArrayLike<number> | null;                      // bx,by pairs
  aiPathStep?: number;
  dims?: boolean;            // dimension lines (heights, gap) and the required-angle arc
  reqDeg?: number[] | null;
  gapCm?: number | null;
  labels?: { m: (v: string) => string; cm: (v: string) => string; deg: (v: string) => string };
  lineScale?: number;        // stroke width multiplier
  egg?: boolean;
  L?: number;
  /**
   * Body colour of the player's ball (skins): the strobe copies and the final ball, never the egg, the required-angle
   * illustration or the AI ghost. Default C.ball (today); the outline stays ink and the highlight stays white.
   */
  ballFill?: string;
}

/** Default wide x range (§9.2): [rail0 - 0.3, rail1 + 0.3] or level.view.wideX. */
export function wideRange(level: LevelDef): ViewRange {
  const wx = level.view?.wideX ?? [level.physics.rail[0] - 0.3, level.physics.rail[1] + 0.3];
  return { x0: wx[0], x1: wx[1], y0: -0.35, y1: 1.6 };
}

function pairsExtent(a: ArrayLike<number> | null | undefined, lo: number, hi: number): [number, number] {
  if (!a) return [lo, hi];
  for (let i = 0; i + 1 < a.length; i += 2) {
    const v = a[i]!;
    if (Number.isFinite(v)) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  }
  return [lo, hi];
}

/** Tight x range around the action: walls, zones, start and the given paths, at least `minW` wide. */
export function fitRange(level: LevelDef, paths: (ArrayLike<number> | null | undefined)[], minW = 2.4, pad = 0.35): ViewRange {
  const p = level.physics;
  let lo = p.startX;
  let hi = p.startX;
  for (const w of p.walls) { lo = Math.min(lo, w.x0); hi = Math.max(hi, w.x1); }
  for (const z of p.phases) { lo = Math.min(lo, z.xa); hi = Math.max(hi, z.xb); }
  for (const a of paths) [lo, hi] = pairsExtent(a, lo, hi);
  lo -= pad;
  hi += pad;
  if (hi - lo < minW) {
    const c = (lo + hi) / 2;
    lo = c - minW / 2;
    hi = c + minW / 2;
  }
  const wr = wideRange(level);
  lo = Math.max(lo, wr.x0);
  hi = Math.min(hi, wr.x1);
  return { x0: lo, x1: hi, y0: -0.12, y1: 1.5 };
}

function brickWall(g: CanvasRenderingContext2D, cam: SideCam, w: WallDef, idx: number, lw: number): void {
  const x = cam.X(w.x0);
  const y = cam.Y(w.h);
  const ww = (w.x1 - w.x0) * cam.s;
  const hh = w.h * cam.s;
  g.save();
  g.beginPath();
  g.rect(x, y, ww, hh);
  g.clip();
  g.fillStyle = C.mortar;
  g.fillRect(x, y, ww, hh);
  const rowH = Math.max(3, 0.06 * cam.s);
  const brickW = Math.max(6, 0.12 * cam.s);
  let row = 0;
  for (let yy = y + hh; yy > y - rowH; yy -= rowH, row++) {
    const off = row % 2 === 0 ? 0 : brickW / 2;
    for (let xx = x - off; xx < x + ww; xx += brickW) {
      const k = (Math.sin((xx + 13 * row + idx * 7) * 12.9898) * 43758.5453) % 1;
      g.fillStyle = Math.abs(k) > 0.5 ? C.brick1 : C.brick2;
      g.fillRect(xx + 0.8 * lw, yy - rowH + 0.8 * lw, brickW - 1.6 * lw, rowH - 1.6 * lw);
    }
  }
  g.restore();
  g.lineWidth = 2 * lw;
  g.strokeStyle = C.ink;
  g.strokeRect(x, y, ww, hh);
}

function arrowHead(g: CanvasRenderingContext2D, x: number, y: number, ang: number, size: number): void {
  g.beginPath();
  g.moveTo(x, y);
  g.lineTo(x - size * Math.cos(ang - 0.4), y - size * Math.sin(ang - 0.4));
  g.moveTo(x, y);
  g.lineTo(x - size * Math.cos(ang + 0.4), y - size * Math.sin(ang + 0.4));
  g.stroke();
}

function dimLine(g: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, text: string, lw: number, fontPx: number): void {
  g.save();
  g.strokeStyle = C.ink;
  g.fillStyle = C.ink;
  g.lineWidth = 1.2 * lw;
  g.beginPath();
  g.moveTo(x1, y1);
  g.lineTo(x2, y2);
  g.stroke();
  const ang = Math.atan2(y2 - y1, x2 - x1);
  arrowHead(g, x2, y2, ang, 6 * lw);
  arrowHead(g, x1, y1, ang + Math.PI, 6 * lw);
  g.font = `800 ${fontPx}px ${FONT_STACK}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const tw = g.measureText(text).width + 8 * lw;
  g.fillStyle = C.paper1;
  g.fillRect(mx - tw / 2, my - fontPx * 0.7, tw, fontPx * 1.4);
  g.fillStyle = C.ink;
  g.fillText(text, mx, my + 0.5);
  g.restore();
}

function drawBall(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, egg: boolean, alpha = 1, lw = 1, fill: string = C.ball): void {
  g.save();
  g.globalAlpha = alpha;
  if (egg) {
    g.fillStyle = C.egg;
    g.beginPath();
    g.ellipse(cx, cy, r * 0.86, r * 1.08, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = C.eggSpeckle;
    for (let i = 0; i < 4; i++) {
      g.beginPath();
      g.arc(cx + Math.cos(i * 2.1) * r * 0.45, cy + Math.sin(i * 1.7) * r * 0.5, r * 0.09, 0, Math.PI * 2);
      g.fill();
    }
    g.lineWidth = 1.6 * lw;
    g.strokeStyle = C.ink;
    g.beginPath();
    g.ellipse(cx, cy, r * 0.86, r * 1.08, 0, 0, Math.PI * 2);
    g.stroke();
  } else {
    g.fillStyle = fill;
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fill();
    g.lineWidth = 1.6 * lw;
    g.strokeStyle = C.ink;
    g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.75)';
    g.lineWidth = Math.max(1, r * 0.22);
    g.lineCap = 'round';
    g.beginPath();
    g.arc(cx, cy, r * 0.6, Math.PI * 1.1, Math.PI * 1.45);
    g.stroke();
  }
  g.restore();
}

/** Draws the level; returns the camera so callers can add overlays in world coordinates. */
export function drawSideView(g: CanvasRenderingContext2D, level: LevelDef, cam: SideCam, o: SideOpts = {}): SideCam {
  const p = level.physics;
  const lw = o.lineScale ?? 1;
  const [vx0, vx1] = cam.visibleX();
  const [vy0, vy1] = cam.visibleY();
  const box = cam.box;
  g.save();
  g.beginPath();
  g.rect(box.x, box.y, box.w, box.h);
  g.clip();

  // Floor section (below y = 0) and the grid.
  g.fillStyle = C.floor;
  g.fillRect(box.x, cam.Y(0), box.w, box.y + box.h - cam.Y(0));
  if (o.grid !== false) {
    g.lineWidth = 1;
    for (let gx = Math.ceil(vx0 * 10) / 10; gx <= vx1; gx += 0.1) {
      const major = Math.abs(gx - Math.round(gx)) < 1e-6;
      g.strokeStyle = major ? 'rgba(201,194,182,0.95)' : 'rgba(201,194,182,0.45)';
      g.beginPath();
      g.moveTo(Math.round(cam.X(gx)) + 0.5, box.y);
      g.lineTo(Math.round(cam.X(gx)) + 0.5, box.y + box.h);
      g.stroke();
    }
    for (let gy = Math.ceil(vy0 * 10) / 10; gy <= vy1; gy += 0.1) {
      const major = Math.abs(gy - Math.round(gy)) < 1e-6;
      g.strokeStyle = major ? 'rgba(201,194,182,0.95)' : 'rgba(201,194,182,0.45)';
      g.beginPath();
      g.moveTo(box.x, Math.round(cam.Y(gy)) + 0.5);
      g.lineTo(box.x + box.w, Math.round(cam.Y(gy)) + 0.5);
      g.stroke();
    }
    if (cam.s > 60) {
      g.fillStyle = 'rgba(30,42,68,0.55)';
      g.font = `500 ${Math.max(9, Math.min(15, cam.s * 0.07))}px ${NUM_STACK}`;
      g.textAlign = 'left';
      g.textBaseline = 'top';
      for (let m = Math.ceil(vx0); m <= vx1; m++) g.fillText(`${m}`, cam.X(m) + 3, cam.Y(0) + 3);
    }
  }
  // Floor line.
  g.strokeStyle = C.ink;
  g.lineWidth = 2 * lw;
  g.beginPath();
  g.moveTo(box.x, cam.Y(0));
  g.lineTo(box.x + box.w, cam.Y(0));
  g.stroke();

  // Goal zones.
  for (let i = 0; i < p.phases.length; i++) {
    const z = p.phases[i]!;
    const x = cam.X(z.xa);
    const w = (z.xb - z.xa) * cam.s;
    g.fillStyle = 'rgba(34,181,115,0.13)';
    g.fillRect(x, cam.Y(z.kind === 'pocket' ? 0.95 : 0.55), w, cam.Y(0) - cam.Y(z.kind === 'pocket' ? 0.95 : 0.55));
    g.fillStyle = C.goal;
    g.fillRect(x, cam.Y(0.025), w, 0.025 * cam.s + 1);
    g.strokeStyle = C.goal;
    g.setLineDash([4 * lw, 4 * lw]);
    g.lineWidth = 1.4 * lw;
    g.beginPath();
    g.moveTo(x, cam.Y(0));
    g.lineTo(x, cam.Y(0.5));
    g.moveTo(x + w, cam.Y(0));
    g.lineTo(x + w, cam.Y(0.5));
    g.stroke();
    g.setLineDash([]);
  }

  // Gantry: legs at the rail ends, beam, hazard bumpers.
  const r0 = p.rail[0];
  const r1 = p.rail[1];
  g.fillStyle = 'rgba(30,42,68,0.18)';
  for (const lx of [r0 - 0.15, r1 + 0.15]) g.fillRect(cam.X(lx) - 0.03 * cam.s, cam.Y(BEAM_Y), 0.06 * cam.s, BEAM_Y * cam.s);
  g.fillStyle = C.gantry;
  g.fillRect(cam.X(r0 - 0.2), cam.Y(BEAM_Y + 0.1), (r1 - r0 + 0.4) * cam.s, 0.1 * cam.s);
  g.strokeStyle = C.ink;
  g.lineWidth = 2 * lw;
  g.strokeRect(cam.X(r0 - 0.2), cam.Y(BEAM_Y + 0.1), (r1 - r0 + 0.4) * cam.s, 0.1 * cam.s);
  for (const [bx, side] of [[r0, -1], [r1, 1]] as const) {
    const x = cam.X(bx + (side > 0 ? 0.12 : -0.12)) - (side > 0 ? 0 : 0.05 * cam.s);
    const y = cam.Y(BEAM_Y);
    const w = 0.05 * cam.s;
    const h = 0.07 * cam.s;
    g.save();
    g.beginPath();
    g.rect(x, y, w, h);
    g.clip();
    g.fillStyle = C.gantry;
    g.fillRect(x, y, w, h);
    g.strokeStyle = C.hazard;
    g.lineWidth = Math.max(1.5, w * 0.28);
    for (let k = -2; k < 5; k++) {
      g.beginPath();
      g.moveTo(x + k * w * 0.6, y + h);
      g.lineTo(x + k * w * 0.6 + h, y);
      g.stroke();
    }
    g.restore();
    g.strokeStyle = C.ink;
    g.lineWidth = 1.5 * lw;
    g.strokeRect(x, y, w, h);
  }

  // Walls.
  p.walls.forEach((w, i) => brickWall(g, cam, w, i, lw));

  // AI path.
  if (o.aiPath && o.aiPath.length >= 4) {
    const step = Math.max(1, o.aiPathStep ?? 1) * 2;
    g.strokeStyle = C.ai;
    g.lineWidth = 2.2 * lw;
    g.lineJoin = 'round';
    g.beginPath();
    for (let i = 0; i + 1 < o.aiPath.length; i += step) {
      const x = cam.X(o.aiPath[i]!);
      const y = cam.Y(o.aiPath[i + 1]!);
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
  }

  // Dimension lines and the required-angle arc.
  if (o.dims && o.labels) {
    const fontPx = Math.max(10, Math.min(16, cam.s * 0.075));
    p.walls.forEach((w, i) => {
      const x = cam.X(w.x0) - 0.07 * cam.s;
      g.save();
      g.strokeStyle = 'rgba(30,42,68,0.55)';
      g.lineWidth = 1 * lw;
      g.beginPath();
      g.moveTo(cam.X(w.x0) - 0.1 * cam.s, cam.Y(w.h));
      g.lineTo(cam.X(w.x0), cam.Y(w.h));
      g.stroke();
      g.restore();
      if (i === 0 || w.h !== p.walls[i - 1]!.h) dimLine(g, x, cam.Y(0), x, cam.Y(w.h), o.labels!.m(w.h.toFixed(2)), lw, fontPx);
    });
    const pocket = p.phases.find((z) => z.kind === 'pocket');
    if (pocket && o.gapCm) {
      const wallAbove = Math.max(...p.walls.filter((w) => w.x1 <= pocket.xa + 1e-6 || w.x0 >= pocket.xb - 1e-6).map((w) => w.h), 0.4);
      const y = cam.Y(wallAbove + 0.12);
      dimLine(g, cam.X(pocket.xa), y, cam.X(pocket.xb), y, o.labels.cm(String(Math.round(o.gapCm))), lw, fontPx);
    }
    const L = o.L ?? p.L;
    const req = o.reqDeg?.[0];
    const w0 = p.walls[0];
    if (w0 && req !== undefined && Number.isFinite(req) && req > 1) {
      const dir = w0.x0 >= p.startX ? 1 : -1;
      const rad = (req * Math.PI) / 180;
      const cx = (w0.x0 + w0.x1) / 2 - dir * L * Math.sin(rad);
      const px = cam.X(cx);
      const py = cam.Y(RAIL_Y);
      const bx = cam.X(cx + dir * L * Math.sin(rad));
      const by = cam.Y(RAIL_Y - L * Math.cos(rad));
      g.save();
      g.strokeStyle = C.ink;
      g.lineWidth = 1.3 * lw;
      g.setLineDash([5 * lw, 4 * lw]);
      g.beginPath();
      g.moveTo(px, py);
      g.lineTo(px, cam.Y(RAIL_Y - L));
      g.moveTo(px, py);
      g.lineTo(bx, by);
      g.stroke();
      g.setLineDash([]);
      const ar = L * cam.s * 0.42;
      g.lineWidth = 2 * lw;
      g.strokeStyle = C.ball;
      g.beginPath();
      const a0 = Math.PI / 2;
      const a1 = Math.PI / 2 - dir * rad;
      g.arc(px, py, ar, Math.min(a0, a1), Math.max(a0, a1));
      g.stroke();
      g.fillStyle = C.ball;
      g.font = `800 ${fontPx * 1.15}px ${FONT_STACK}`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      const am = Math.PI / 2 - dir * rad * 0.5;
      g.fillText(o.labels.deg(String(Math.round(req))), px + Math.cos(am) * (ar + fontPx * 1.4), py + Math.sin(am) * (ar + fontPx * 1.1));
      drawBall(g, bx, by, BALL_R * cam.s, false, 0.28, lw);
      g.restore();
    }
  }

  // Strobe (oldest faint, newest solid).
  const ballFill = o.ballFill ?? C.ball;
  if (o.strobe && o.strobe.length >= 2) {
    const step = Math.max(1, o.strobeStep ?? 1) * 2;
    const n = Math.floor(o.strobe.length / step);
    let k = 0;
    for (let i = 0; i + 1 < o.strobe.length; i += step, k++) {
      const a = 0.12 + 0.78 * (n <= 1 ? 1 : k / (n - 1));
      drawBall(g, cam.X(o.strobe[i]!), cam.Y(o.strobe[i + 1]!), BALL_R * cam.s, !!o.egg, a, lw * 0.8, ballFill);
    }
  }

  // Ghost (cyan hologram).
  if (o.ghost) {
    const gx = cam.X(o.ghost.x);
    g.save();
    g.globalAlpha = 0.85;
    g.strokeStyle = C.ai;
    g.lineWidth = 1.5 * lw;
    g.beginPath();
    g.moveTo(gx, cam.Y(RAIL_Y));
    g.lineTo(cam.X(o.ghost.bx), cam.Y(o.ghost.by));
    g.stroke();
    g.fillStyle = 'rgba(25,195,255,0.35)';
    g.beginPath();
    g.arc(cam.X(o.ghost.bx), cam.Y(o.ghost.by), BALL_R * cam.s, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    g.fillStyle = 'rgba(25,195,255,0.4)';
    g.fillRect(gx - 0.12 * cam.s, cam.Y(BEAM_Y), 0.24 * cam.s, 0.05 * cam.s);
    g.restore();
  }

  // Trolley, string and ball.
  if (o.trolleyX !== undefined && o.trolleyX !== null) {
    const tx = cam.X(o.trolleyX);
    const ball = o.ball ?? { x: o.trolleyX, y: RAIL_Y - (o.L ?? p.L) };
    g.strokeStyle = C.string;
    g.lineWidth = 1.8 * lw;
    g.beginPath();
    g.moveTo(tx, cam.Y(RAIL_Y));
    g.lineTo(cam.X(ball.x), cam.Y(ball.y));
    g.stroke();
    g.fillStyle = '#39455F';
    const tw = 0.24 * cam.s;
    const th = 0.05 * cam.s;
    g.beginPath();
    g.roundRect(tx - tw / 2, cam.Y(BEAM_Y), tw, th, Math.min(4, th / 2));
    g.fill();
    g.strokeStyle = C.ink;
    g.lineWidth = 1.5 * lw;
    g.stroke();
    g.fillStyle = C.ink;
    for (const dx of [-0.08, 0.08]) {
      g.beginPath();
      g.arc(tx + dx * cam.s, cam.Y(BEAM_Y + 0.02), Math.max(1.5, 0.018 * cam.s), 0, Math.PI * 2);
      g.fill();
    }
    drawBall(g, cam.X(ball.x), cam.Y(ball.y), BALL_R * cam.s, !!o.egg, 1, lw, ballFill);
  } else if (o.ball) {
    drawBall(g, cam.X(o.ball.x), cam.Y(o.ball.y), BALL_R * cam.s, !!o.egg, 1, lw, ballFill);
  }
  g.restore();
  return cam;
}

/** Stamp "ピタッ!" (#D8342B, round frame, §9.1) drawn onto a canvas. */
export function drawStamp(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, text: string, rot = -0.2): void {
  g.save();
  g.translate(cx, cy);
  g.rotate(rot);
  g.strokeStyle = C.stamp;
  g.fillStyle = C.stamp;
  g.lineWidth = r * 0.09;
  g.globalAlpha = 0.92;
  g.beginPath();
  g.arc(0, 0, r, 0, Math.PI * 2);
  g.stroke();
  g.lineWidth = r * 0.035;
  g.beginPath();
  g.arc(0, 0, r * 0.84, 0, Math.PI * 2);
  g.stroke();
  let size = r * 0.62;
  g.font = `800 ${size}px ${FONT_STACK}`;
  while (g.measureText(text).width > r * 1.5 && size > 8) {
    size -= 1;
    g.font = `800 ${size}px ${FONT_STACK}`;
  }
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 0, r * 0.04);
  g.restore();
}
