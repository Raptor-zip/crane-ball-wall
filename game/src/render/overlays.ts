// In-world overlays: target ring, tether, AI line, 2 cm margin line, dimension lines (GAME_DESIGN.md §3.4, §8.4). Owner: O5.
//
// Everything drawn as "ink" goes through QuadBatch: one dynamic BufferGeometry of camera-facing
// quads in the xy-plane (lines, arcs, discs, atlas glyphs and shapes), i.e. one draw call per batch.
// The atlas stores R = fill and G = halo, so text gets a paper-coloured halo for legibility.
import {
  BufferAttribute, BufferGeometry, Color, DoubleSide, DynamicDrawUsage, Mesh, ShaderMaterial,
} from 'three';
import type { Texture } from 'three';
import type { LevelDef, WallDef } from '../sim/level';
import type { Atlas, AtlasShape, UvRect } from './textures';
import { PAL, Z_BOARD, Z_FLOOR_FRONT, col } from './scene';
import { BEAM_TOP } from './crane';

/** mode 0: atlas mask; 1: disc (uv -1..1); 2: rect with lit edges (uv -1..1). */
export const M_ATLAS = 0, M_DISC = 1, M_RECT = 2;

export class QuadBatch {
  readonly mesh: Mesh;
  readonly geometry: BufferGeometry;
  private readonly pos: Float32Array;
  private readonly colr: Float32Array;
  private readonly uv: Float32Array;
  private readonly mode: Float32Array;
  private readonly extra: Float32Array;
  private n = 0;
  private readonly max: number;

  constructor(maxQuads: number, material: ShaderMaterial, private readonly atlas: Atlas) {
    this.max = maxQuads;
    const v = maxQuads * 4;
    this.pos = new Float32Array(v * 3);
    this.colr = new Float32Array(v * 4);
    this.uv = new Float32Array(v * 2);
    this.mode = new Float32Array(v);
    this.extra = new Float32Array(v);
    const idx = v > 65535 ? new Uint32Array(maxQuads * 6) : new Uint16Array(maxQuads * 6);
    for (let q = 0; q < maxQuads; q++) {
      const b = q * 4, o = q * 6;
      idx[o] = b; idx[o + 1] = b + 1; idx[o + 2] = b + 2;
      idx[o + 3] = b; idx[o + 4] = b + 2; idx[o + 5] = b + 3;
    }
    const g = new BufferGeometry();
    const dyn = (a: BufferAttribute): BufferAttribute => a.setUsage(DynamicDrawUsage);
    g.setAttribute('position', dyn(new BufferAttribute(this.pos, 3)));
    g.setAttribute('aCol', dyn(new BufferAttribute(this.colr, 4)));
    g.setAttribute('aUv', dyn(new BufferAttribute(this.uv, 2)));
    g.setAttribute('aMode', dyn(new BufferAttribute(this.mode, 1)));
    g.setAttribute('aExtra', dyn(new BufferAttribute(this.extra, 1)));
    g.setIndex(new BufferAttribute(idx, 1));
    g.setDrawRange(0, 0);
    this.geometry = g;
    this.mesh = new Mesh(g, material);
    this.mesh.frustumCulled = false;
  }

  get count(): number { return this.n; }

  begin(): void { this.n = 0; }

  /** Width / height of a free-text label in the atlas. */
  atlasLabelAspect(s: string): number { return this.atlas.label(s).aspect; }

  atlasShape(name: AtlasShape): UvRect { return this.atlas.shape(name); }

  atlasHeading(s: string): UvRect { return this.atlas.heading(s); }

  end(): void {
    const g = this.geometry;
    g.setDrawRange(0, this.n * 6);
    for (const k of ['position', 'aCol', 'aUv', 'aMode', 'aExtra']) {
      const a = g.getAttribute(k) as BufferAttribute;
      a.clearUpdateRanges();
      a.addUpdateRange(0, this.n * 4 * a.itemSize);
      a.needsUpdate = true;
    }
  }

  /** Raw quad: corners 0..3 counter-clockwise, uv corners (u0,v0) (u1,v0) (u1,v1) (u0,v1). */
  quad(
    x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, z: number,
    u0: number, v0: number, u1: number, v1: number, c: Color, a: number, mode: number, extra: number,
  ): void {
    if (this.n >= this.max || a <= 0.002) return;
    const q = this.n++;
    const p = q * 12, cc = q * 16, t = q * 8, m = q * 4;
    const P = this.pos;
    P[p] = x0; P[p + 1] = y0; P[p + 2] = z;
    P[p + 3] = x1; P[p + 4] = y1; P[p + 5] = z;
    P[p + 6] = x2; P[p + 7] = y2; P[p + 8] = z;
    P[p + 9] = x3; P[p + 10] = y3; P[p + 11] = z;
    for (let i = 0; i < 4; i++) {
      const k = cc + i * 4;
      this.colr[k] = c.r; this.colr[k + 1] = c.g; this.colr[k + 2] = c.b; this.colr[k + 3] = a;
      this.mode[m + i] = mode;
      this.extra[m + i] = extra;
    }
    const U = this.uv;
    U[t] = u0; U[t + 1] = v0; U[t + 2] = u1; U[t + 3] = v0; U[t + 4] = u1; U[t + 5] = v1; U[t + 6] = u0; U[t + 7] = v1;
  }

  rect(x0: number, y0: number, x1: number, y1: number, z: number, c: Color, a: number, mode = M_ATLAS, extra = 0, r?: UvRect): void {
    if (mode === M_ATLAS) {
      const w = r ?? this.atlas.white;
      this.quad(x0, y0, x1, y0, x1, y1, x0, y1, z, w.u0, w.v0, w.u1, w.v1, c, a, M_ATLAS, extra);
    } else {
      this.quad(x0, y0, x1, y0, x1, y1, x0, y1, z, -1, -1, 1, 1, c, a, mode, extra);
    }
  }

  line(ax: number, ay: number, bx: number, by: number, z: number, w: number, c: Color, a: number, extra = 0): void {
    let dx = bx - ax, dy = by - ay;
    const l = Math.hypot(dx, dy);
    if (l < 1e-7) return;
    dx /= l; dy /= l;
    const nx = (-dy * w) / 2, ny = (dx * w) / 2;
    // Extend by half a width so joints close up.
    const ex = (dx * w) / 2, ey = (dy * w) / 2;
    const r = this.atlas.white;
    this.quad(ax - ex + nx, ay - ey + ny, ax - ex - nx, ay - ey - ny, bx + ex - nx, by + ey - ny, bx + ex + nx, by + ey + ny, z,
      r.u0, r.v0, r.u1, r.v1, c, a, M_ATLAS, extra);
  }

  /**
   * Seamless ribbon through points (no overlapping joints, so translucency stays even).
   * width(i) and alpha(i) give per-point values.
   */
  strip(xs: ArrayLike<number>, ys: ArrayLike<number>, n: number, z: number, c: Color,
    width: (i: number) => number, alpha: (i: number) => number): void {
    if (n < 2) return;
    const r = this.atlas.white;
    let plx = 0, ply = 0, prx = 0, pry = 0, pa = 0;
    for (let i = 0; i < n; i++) {
      const i0 = Math.max(0, i - 1), i1 = Math.min(n - 1, i + 1);
      let tx = (xs[i1] as number) - (xs[i0] as number), ty = (ys[i1] as number) - (ys[i0] as number);
      const tl = Math.hypot(tx, ty);
      if (tl < 1e-9) { tx = 1; ty = 0; } else { tx /= tl; ty /= tl; }
      const hw = width(i) / 2;
      const x = xs[i] as number, y = ys[i] as number;
      const lx = x - ty * hw, ly = y + tx * hw, rx = x + ty * hw, ry = y - tx * hw;
      const a = alpha(i);
      if (i > 0) {
        this.quad(plx, ply, prx, pry, rx, ry, lx, ly, z, r.u0, r.v0, r.u1, r.v1, c, (a + pa) / 2, M_ATLAS, 0);
      }
      plx = lx; ply = ly; prx = rx; pry = ry; pa = a;
    }
  }

  dashed(ax: number, ay: number, bx: number, by: number, z: number, w: number, dash: number, gap: number, c: Color, a: number, phase = 0): void {
    const l = Math.hypot(bx - ax, by - ay);
    if (l < 1e-6) return;
    const ux = (bx - ax) / l, uy = (by - ay) / l;
    const per = dash + gap;
    let s = -(((phase % per) + per) % per);
    for (; s < l; s += per) {
      const s0 = Math.max(0, s), s1 = Math.min(l, s + dash);
      if (s1 > s0) this.line(ax + ux * s0, ay + uy * s0, ax + ux * s1, ay + uy * s1, z, w, c, a);
    }
  }

  arc(cx: number, cy: number, z: number, r: number, w: number, a0: number, a1: number, c: Color, a: number, segs = 32): void {
    const n = Math.max(2, Math.ceil((segs * Math.abs(a1 - a0)) / (Math.PI * 2)));
    const ri = r - w / 2, ro = r + w / 2;
    const white = this.atlas.white;
    for (let i = 0; i < n; i++) {
      const t0 = a0 + ((a1 - a0) * i) / n, t1 = a0 + ((a1 - a0) * (i + 1)) / n;
      const c0 = Math.cos(t0), s0 = Math.sin(t0), c1 = Math.cos(t1), s1 = Math.sin(t1);
      this.quad(cx + c0 * ri, cy + s0 * ri, cx + c0 * ro, cy + s0 * ro, cx + c1 * ro, cy + s1 * ro, cx + c1 * ri, cy + s1 * ri, z,
        white.u0, white.v0, white.u1, white.v1, c, a, M_ATLAS, 0);
    }
  }

  disc(cx: number, cy: number, z: number, r: number, c: Color, a: number, extra = 0): void {
    this.quad(cx - r, cy - r, cx + r, cy - r, cx + r, cy + r, cx - r, cy + r, z, -1, -1, 1, 1, c, a, M_DISC, extra);
  }

  /** Atlas region centred at (cx, cy) with height h (width from the region's aspect). */
  icon(r: UvRect, cx: number, cy: number, z: number, h: number, c: Color, a: number, halo = 0.9, rot = 0): void {
    const w = h * r.aspect;
    if (rot === 0) {
      this.quad(cx - w / 2, cy - h / 2, cx + w / 2, cy - h / 2, cx + w / 2, cy + h / 2, cx - w / 2, cy + h / 2, z, r.u0, r.v0, r.u1, r.v1, c, a, M_ATLAS, halo);
      return;
    }
    const cs = Math.cos(rot), sn = Math.sin(rot);
    const px = (x: number, y: number): number => cx + x * cs - y * sn;
    const py = (x: number, y: number): number => cy + x * sn + y * cs;
    const hw = w / 2, hh = h / 2;
    this.quad(px(-hw, -hh), py(-hw, -hh), px(hw, -hh), py(hw, -hh), px(hw, hh), py(hw, hh), px(-hw, hh), py(-hw, hh), z,
      r.u0, r.v0, r.u1, r.v1, c, a, M_ATLAS, halo);
  }

  /** Monospace glyph text. align: -1 left edge at x, 0 centred, 1 right edge at x. Returns the width. */
  text(s: string, x: number, y: number, z: number, h: number, c: Color, a: number, align = -1, halo = 0.9): number {
    const adv = h * 0.6;
    const width = adv * s.length;
    let px = align < 0 ? x : align > 0 ? x - width : x - width / 2;
    for (const ch of s) {
      if (ch !== ' ') {
        const g = this.atlas.glyph(ch);
        const gw = h * g.aspect;
        const cx = px + adv / 2;
        this.quad(cx - gw / 2, y - h / 2, cx + gw / 2, y - h / 2, cx + gw / 2, y + h / 2, cx - gw / 2, y + h / 2, z,
          g.u0, g.v0, g.u1, g.v1, c, a, M_ATLAS, halo);
      }
      px += adv;
    }
    return width;
  }

  /** Free text (any script) through the atlas label cache. Returns the width. */
  label(s: string, x: number, y: number, z: number, h: number, c: Color, a: number, align = -1, halo = 0.9): number {
    const r = this.atlas.label(s);
    const w = h * r.aspect;
    const x0 = align < 0 ? x : align > 0 ? x - w : x - w / 2;
    this.quad(x0, y - h / 2, x0 + w, y - h / 2, x0 + w, y + h / 2, x0, y + h / 2, z, r.u0, r.v0, r.u1, r.v1, c, a, M_ATLAS, halo);
    return w;
  }

  dispose(): void {
    this.geometry.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Ink material.

const INK_VS = /* glsl */ `
attribute vec4 aCol;
attribute vec2 aUv;
attribute float aMode;
attribute float aExtra;
varying vec4 vCol;
varying vec2 vUv;
varying float vMode;
varying float vExtra;
void main() {
  vCol = aCol; vUv = aUv; vMode = aMode; vExtra = aExtra;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const INK_FS = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uHalo;
varying vec4 vCol;
varying vec2 vUv;
varying float vMode;
varying float vExtra;
void main() {
  vec3 c = vCol.rgb;
  float a;
  if (vMode < 0.5) {
    vec4 t = texture2D(uMap, vUv);
    c = mix(uHalo, vCol.rgb, clamp(t.r * 1.15, 0.0, 1.0));
    a = max(t.r, t.g * vExtra);
  } else if (vMode < 1.5) {
    float r = length(vUv);
    float aa = max(fwidth(r), 1e-3);
    a = 1.0 - smoothstep(1.0 - aa, 1.0, r);
    // vExtra > 0: draw only a ring of that relative thickness.
    if (vExtra > 0.0) a *= smoothstep(1.0 - vExtra - aa, 1.0 - vExtra, r);
  } else {
    vec2 q = abs(vUv);
    float e = max(q.x, q.y);
    float aa = max(fwidth(e), 1e-3);
    a = 1.0 - smoothstep(1.0 - aa, 1.0, e);
  }
  a *= vCol.a;
  if (a < 0.004) discard;
  gl_FragColor = vec4(c, a);
  #include <colorspace_fragment>
}`;

export function createInkMaterial(map: Texture, depthTest: boolean): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: INK_VS,
    fragmentShader: INK_FS,
    uniforms: { uMap: { value: map }, uHalo: { value: col(PAL.paper1) } },
    transparent: true,
    depthWrite: false,
    depthTest,
    side: DoubleSide,
  });
}

// ---------------------------------------------------------------------------------------------
// Static level ink.

const C_INK = col(PAL.ink);
const C_AI = col(PAL.ai);

/** Formats a height in metres like "0.75 m". */
function fmtM(v: number): string {
  return `${v.toFixed(2)} m`;
}

export interface BackInkOpts {
  level: LevelDef;
  /** Screen-aligned y for a world height h at z = 0 when drawn at depth z (camera-ray projection). */
  projY: (h: number, z: number) => number;
  xView: [number, number];
  /**
   * x range in which a ruler number is fully on screen (fixed wide camera), or null when the camera
   * follows (tall: every number can scroll into view).
   */
  rulerLabelX: [number, number] | null;
  pxPerM: number;
  /**
   * Board heading (notebook page title) right-aligned at xRight, just above the gantry beam; null = none.
   * maxPx caps its height (tall: it shares the one tag row between the beam and the HUD).
   */
  heading?: { text: string; xRight: number; maxPx?: number } | null;
}

export const Z_BACKINK = -0.27;

/** A wall height's dashed line from xa to xb [m] at height h, and its "0.75 m" label (th tall, w wide) at its left end. */
export interface HeightLabel { text: string; h: number; xa: number; xb: number; th: number; w: number; wallX: number }

/**
 * The wall-height lines and labels, one per distinct height. The label sits at the line's outer (left) end, clear of
 * the wall top where near-miss dimensions are drawn: 0.85 m before the first wall in wide; tall (`follow`: the
 * camera follows in a window about 2 m wide) 0.6 m, so that it is on screen whenever that wall's top is (the title
 * attract and the demo rest on the goal with the first wall near the left edge: 0.85 m read "5 m").
 */
export function heightLabels(walls: readonly WallDef[], pxPerM: number, follow: boolean): HeightLabel[] {
  const px = 1 / pxPerM;
  const out: HeightLabel[] = [];
  for (const w of walls) {
    if (out.some((l) => Math.abs(l.h - w.h) < 0.005)) continue;
    const ws = walls.filter((v) => Math.abs(v.h - w.h) < 0.005);
    const x0 = Math.min(...ws.map((v) => v.x0));
    const th = Math.max(13 * px, 0.045);
    const text = fmtM(w.h);
    out.push({ text, h: w.h, xa: x0 - (follow ? 0.6 : 0.85), xb: Math.max(...ws.map((v) => v.x1)) + 0.55, th, w: th * 0.6 * text.length, wallX: (ws[0] as WallDef).x0 });
  }
  return out;
}

/** The heading is written on the paper itself. */
const Z_HEADING = Z_BOARD + 0.01;
/** Its baseline sits this high above the beam top (at the ball plane) and it is this tall [m / CSS px]. */
const HEADING_GAP = 0.035, HEADING_H = 0.13, HEADING_MIN_PX = 24;

/**
 * Wall-height dashed lines with "0.75 m" labels (drawn just behind the walls so they line up with
 * the wall tops from the camera), the ruler along the floor front with metre numbers.
 */
export function drawBackInk(b: QuadBatch, o: BackInkOpts): void {
  b.begin();
  const walls = o.level.physics.walls;
  const px = 1 / o.pxPerM;
  const z = Z_BACKINK;
  const lw = Math.max(1.3 * px, 0.004);
  for (const l of heightLabels(walls, o.pxPerM, o.rulerLabelX === null)) {
    const y = o.projY(l.h, z);
    b.dashed(l.xa, y, l.xb, y, z, lw, 0.035, 0.025, C_INK, 0.42);
    // Label at the outer (left) end of the dashed line (heightLabels).
    b.text(l.text, l.xa, y + l.th * 0.62, z, l.th, C_INK, 0.8, -1);
    // Small arrow tick at the wall: a short solid stub.
    b.line(l.wallX - 0.03, y, l.wallX - 0.002, y, z, lw * 1.6, C_INK, 0.7);
  }

  // Ruler on the floor's front face (finger band, §9.2): ticks every 10 cm, numbers every metre.
  const zf = Z_FLOOR_FRONT + 0.001;
  const x0 = Math.ceil((o.xView[0] - 0.4) * 10) / 10, x1 = Math.floor((o.xView[1] + 0.4) * 10) / 10;
  const tw = Math.max(1.2 * px, 0.003);
  const nh = Math.max(18 * px, 0.06);
  let firstLabel = NaN;
  for (let i = Math.round(x0 * 10); i <= Math.round(x1 * 10); i++) {
    const x = i / 10;
    const major = i % 10 === 0, half = i % 5 === 0;
    const len = major ? 0.075 : half ? 0.045 : 0.025;
    b.line(x, -0.001, x, -len, zf, major ? tw * 1.8 : tw, C_INK, major ? 0.85 : 0.55);
    if (major) {
      const s = `${i / 10}`;
      const halfW = (nh * 0.6 * s.length) / 2 + nh * 0.1;
      // Wide: skip a number that would be cut by the screen edge (it reads as a glitch).
      if (o.rulerLabelX && (x - halfW < o.rulerLabelX[0] || x + halfW > o.rulerLabelX[1])) continue;
      b.text(s, x, -0.075 - nh * 0.72, zf, nh, C_INK, 0.9, 0);
      if (!Number.isFinite(firstLabel)) firstLabel = x + halfW;
    }
  }
  // Unit mark next to the first number, and a crisp edge line along the bench top.
  const th = Math.max(13 * px, 0.045);
  if (Number.isFinite(firstLabel)) b.text('m', firstLabel + nh * 0.15, -0.075 - nh * 0.72, zf, th, C_INK, 0.65, -1);
  b.line(o.xView[0] - 1, -0.0015, o.xView[1] + 1, -0.0015, zf, Math.max(1.5 * px, 0.004), C_INK, 0.35);

  // Board heading: faint ink on the paper above the beam's right end (clear of the ghost tags, which ride
  // over their trolleys, and of the HUD corners). Sizes are at the ball plane, then pushed back onto the board.
  if (o.heading && o.heading.text) {
    const r = b.atlasHeading(o.heading.text);
    const cap = o.heading.maxPx !== undefined ? o.heading.maxPx * px : Infinity;
    const h0 = Math.min(cap, Math.max(HEADING_H, HEADING_MIN_PX * px));
    const y0 = o.projY(BEAM_TOP + HEADING_GAP, Z_HEADING), y1 = o.projY(BEAM_TOP + HEADING_GAP + h0, Z_HEADING);
    const hh = y1 - y0;
    const w = hh * r.aspect;
    // (On the board, so it shows a little parallax against the beam when the tall camera follows.)
    b.icon(r, o.heading.xRight - w / 2, (y0 + y1) / 2, Z_HEADING, hh, C_INK, 0.13, 0);
  }
  b.end();
}

/** AI 2 cm margin lines (§8.4-4): cyan dashes offset aiMarginMm outside each wall's top and upper sides. */
export function drawMarginInk(b: QuadBatch, walls: readonly WallDef[], marginMm: number, pxPerM: number): void {
  b.begin();
  const d = marginMm / 1000;
  const w = Math.max(1.6 / pxPerM, 0.004);
  for (const wall of walls) {
    const xa = wall.x0 - d, xb = wall.x1 + d, yt = wall.h + d, yd = Math.max(0.02, wall.h - 0.28);
    b.dashed(xa, yd, xa, yt, 0.001, w, 0.022, 0.014, C_AI, 0.9);
    b.dashed(xa, yt, xb, yt, 0.001, w, 0.022, 0.014, C_AI, 0.9, 0.01);
    b.dashed(xb, yt, xb, yd, 0.001, w, 0.022, 0.014, C_AI, 0.9);
  }
  b.end();
}
