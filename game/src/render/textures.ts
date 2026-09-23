// Canvas-generated textures, max 6 of <= 512^2 (GAME_DESIGN.md §9.1). Owner: O5.
//
//   brick  256x128  one brick face: noise + baked bevel ("normal-like" shading); tinted per instance
//   floor  512x512  1 m tile: 10 cm grid, bold 1 m line
//   hazard 128x32   yellow/black stripes for the rail-end bumpers
//   paper  512x512  1 m tile: paper fibres + faint 10 cm grid for the back board
// brick, floor, hazard and paper follow the skin (skinLooks.ts): restyle() / setHazard() repaint the same canvases.
//   atlas  512x512  masks: R = fill, G = halo. Glyphs, ghost tag shapes, X decal, arrow, dynamic labels
//   soft   64x64    radial falloff for blob shadows and glows
import {
  CanvasTexture, ClampToEdgeWrapping, LinearFilter, LinearMipmapLinearFilter, NoColorSpace,
  RepeatWrapping, SRGBColorSpace,
} from 'three';
import { DEFAULT_LOOK } from './skinLooks';
import type { CraneLook, StageLook } from './skinLooks';

export interface UvRect { u0: number; v0: number; u1: number; v1: number; aspect: number /* w/h in px */ }

export interface Atlas {
  readonly texture: CanvasTexture;
  /** A fully opaque texel block (R = G = 1): use for plain geometry. */
  readonly white: UvRect;
  /** Glyph for one character (falls back to '?'). Advance is `aspect` * height. */
  glyph(ch: string): UvRect;
  /** Named shape: 'hex' | 'circle' | 'star' | 'tri' | 'flag' | 'x' | 'arrow' | 'diamond'. */
  shape(name: AtlasShape): UvRect;
  /** A free-text label (any script) in the dynamic slots; cached by text. */
  label(text: string): UvRect;
  /** One large heading (re-rendered when the text changes), e.g. the level id watermark. */
  heading(text: string): UvRect;
  /**
   * Forgets the rendered labels and heading, so the next label() / heading() draws them again (a web font that
   * arrived after they were drawn in the fallback font).
   */
  invalidateText(): void;
  dispose(): void;
}
export type AtlasShape = 'hex' | 'circle' | 'star' | 'tri' | 'flag' | 'x' | 'arrow' | 'diamond';

export interface Textures {
  brick: CanvasTexture; floor: CanvasTexture; hazard: CanvasTexture; paper: CanvasTexture;
  atlas: Atlas; soft: CanvasTexture;
  /** Board skin changed: redraws paper, floor and brick into the same canvases (never new textures). */
  restyle(stage: StageLook): void;
  /** Crane skin changed: redraws the bumper stripes (the texture's repeat stays). */
  setHazard(a: string, b: string): void;
  dispose(): void;
}

/** Deterministic tiny PRNG so textures look the same on every boot. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  if (!g) throw new Error('2d canvas unavailable');
  return [c, g];
}

function tex(c: HTMLCanvasElement, srgb: boolean, repeat: boolean): CanvasTexture {
  const t = new CanvasTexture(c);
  t.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
  t.wrapS = t.wrapT = repeat ? RepeatWrapping : ClampToEdgeWrapping;
  t.minFilter = LinearMipmapLinearFilter;
  t.magFilter = LinearFilter;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

/** Speckle noise over the whole canvas. */
function noise(g: CanvasRenderingContext2D, w: number, h: number, r: () => number, n: number, alpha: number, dark: string, light: string): void {
  for (let i = 0; i < n; i++) {
    const x = r() * w;
    const y = r() * h;
    const s = 0.6 + r() * 1.8;
    g.globalAlpha = alpha * (0.3 + r() * 0.7);
    g.fillStyle = r() < 0.5 ? dark : light;
    g.fillRect(x, y, s, s);
  }
  g.globalAlpha = 1;
}

// ---------------------------------------------------------------------------------------------
// Skinnable canvases (skins spec §2.3, §5.1). Each is drawn by a draw*() into its one canvas, at boot and again by
// restyle() / setHazard() into the SAME canvas (never a new texture). The default look draws exactly today's calls.

/** Brick face styles; the per-instance tint carries the hue, so every base is near-white. */
export function drawBrick(g: CanvasRenderingContext2D, style: StageLook['brickTex']): void {
  const W = 256, H = 128;
  const edge = (x0: number, y0: number, x1: number, y1: number, c: string): void => {
    const grd = g.createLinearGradient(x0, y0, x1, y1);
    grd.addColorStop(0, c);
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0) || W, Math.abs(y1 - y0) || H);
  };
  if (style === 'block') {
    // Concrete / cast block: flat base, fine pores, a crisp narrow bevel; no mottling.
    const r = rng(12);
    g.fillStyle = '#f4f0ec';
    g.fillRect(0, 0, W, H);
    noise(g, W, H, r, 2200, 0.16, '#4a4640', '#ffffff');
    for (let i = 0; i < 60; i++) {
      g.fillStyle = `rgba(50,45,40,${0.14 + r() * 0.16})`;
      g.beginPath();
      g.arc(r() * W, r() * H, 0.6 + r() * 1.1, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = 'rgba(255,255,255,0.5)';
    g.fillRect(0, 0, W, 3);
    g.fillStyle = 'rgba(255,255,255,0.3)';
    g.fillRect(0, 3, 3, H - 3);
    g.fillStyle = 'rgba(30,25,20,0.42)';
    g.fillRect(0, H - 4, W, 4);
    g.fillStyle = 'rgba(30,25,20,0.3)';
    g.fillRect(W - 3, 0, 3, H - 4);
    edge(0, 3, 0, 9, 'rgba(255,255,255,0.18)');
    edge(0, H - 4, 0, H - 11, 'rgba(30,25,20,0.16)');
    return;
  }
  if (style === 'stone') {
    // Dressed granite: salt-and-pepper grains and a rounded look from soft edge shading (light top-left, dark
    // bottom-right, darker corners) plus a few chisel strokes. The box keeps its corners (the rounding is shading only).
    const r = rng(13);
    g.fillStyle = '#f4f0ec';
    g.fillRect(0, 0, W, H);
    for (let i = 0; i < 14; i++) {
      const x = r() * W, y = r() * H, rad = 20 + r() * 30;
      const grd = g.createRadialGradient(x, y, 0, x, y, rad);
      const k = r() < 0.5 ? '0,0,0' : '255,255,255';
      grd.addColorStop(0, `rgba(${k},${0.03 + r() * 0.05})`);
      grd.addColorStop(1, `rgba(${k},0)`);
      g.fillStyle = grd;
      g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }
    noise(g, W, H, r, 3400, 0.24, '#3c3638', '#ffffff');
    edge(0, 0, 0, 18, 'rgba(255,255,255,0.5)');
    edge(0, 0, 26, 0, 'rgba(255,255,255,0.34)');
    edge(0, H, 0, H - 22, 'rgba(40,32,36,0.42)');
    edge(W, 0, W - 30, 0, 'rgba(40,32,36,0.3)');
    const dome = g.createRadialGradient(W * 0.42, H * 0.4, 0, W * 0.42, H * 0.4, W * 0.42);
    dome.addColorStop(0, 'rgba(255,255,255,0.3)');
    dome.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = dome;
    g.fillRect(0, 0, W, H);
    const rim = g.createRadialGradient(W / 2, H / 2, H * 0.46, W / 2, H / 2, Math.hypot(W / 2, H / 2));
    rim.addColorStop(0, 'rgba(40,32,36,0)');
    rim.addColorStop(1, 'rgba(40,32,36,0.28)');
    g.fillStyle = rim;
    g.fillRect(0, 0, W, H);
    const strokes = 3 + Math.floor(r() * 3);
    g.lineCap = 'round';
    for (let i = 0; i < strokes; i++) {
      const x = W * (0.2 + r() * 0.6), y = H * (0.25 + r() * 0.5), a = r() * Math.PI, l = 12 + r() * 18;
      const dx = Math.cos(a) * l, dy = Math.sin(a) * l * 0.5;
      g.lineWidth = 1.4;
      g.strokeStyle = 'rgba(45,38,40,0.26)';
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + dx, y + dy);
      g.stroke();
      g.lineWidth = 1;
      g.strokeStyle = 'rgba(255,255,255,0.32)';
      g.beginPath();
      g.moveTo(x, y + 1.5);
      g.lineTo(x + dx, y + dy + 1.5);
      g.stroke();
    }
    g.lineCap = 'butt';
    return;
  }
  if (style === 'print') {
    // Printed figure: a flat near-white fill with light noise and a soft bevel, outlined in dark ink: the figure's lines
    // are drawn here, not by the mortar, because the mortar core is also the wall's top face (where the ink near-miss
    // dimension lines land) and has to stay light.
    const r = rng(14);
    g.fillStyle = '#f6f5f2';
    g.fillRect(0, 0, W, H);
    noise(g, W, H, r, 1400, 0.08, '#5a5c60', '#ffffff');
    const b = 9;
    edge(0, 0, 0, b, 'rgba(255,255,255,0.3)');
    edge(0, 0, b, 0, 'rgba(255,255,255,0.2)');
    edge(0, H, 0, H - b * 1.4, 'rgba(30,32,40,0.22)');
    edge(W, 0, W - b, 0, 'rgba(30,32,40,0.16)');
    // The outline: about 3 mm on a row face (0.051 m tall, 0.1-0.3 m wide), i.e. 8 texels across and 5 along.
    const ly = 8, lx = 5;
    g.fillStyle = 'rgba(38,42,52,0.9)';
    g.fillRect(0, 0, W, ly);
    g.fillRect(0, H - ly, W, ly);
    g.fillRect(0, ly, lx, H - 2 * ly);
    g.fillRect(W - lx, ly, lx, H - 2 * ly);
    return;
  }
  // 'clay': today's brick.
  const r = rng(11);
  // Near-white base so the per-instance colour carries the hue.
  g.fillStyle = '#f4f0ec';
  g.fillRect(0, 0, W, H);
  // Clay mottling.
  for (let i = 0; i < 70; i++) {
    const x = r() * W, y = r() * H, rad = 8 + r() * 30;
    const grd = g.createRadialGradient(x, y, 0, x, y, rad);
    const k = r() < 0.5 ? '0,0,0' : '255,255,255';
    grd.addColorStop(0, `rgba(${k},${0.05 + r() * 0.07})`);
    grd.addColorStop(1, `rgba(${k},0)`);
    g.fillStyle = grd;
    g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  noise(g, W, H, r, 2600, 0.22, '#5a4a40', '#ffffff');
  // Pores and small chips.
  for (let i = 0; i < 26; i++) {
    g.fillStyle = `rgba(60,40,30,${0.18 + r() * 0.2})`;
    g.beginPath();
    g.arc(r() * W, r() * H, 0.8 + r() * 1.6, 0, Math.PI * 2);
    g.fill();
  }
  // Baked bevel: light top/left, dark bottom/right (reads as a normal map under the key light).
  const b = 9;
  edge(0, 0, 0, b, 'rgba(255,255,255,0.55)');
  edge(0, 0, b, 0, 'rgba(255,255,255,0.35)');
  edge(0, H, 0, H - b * 1.4, 'rgba(40,20,10,0.55)');
  edge(W, 0, W - b, 0, 'rgba(40,20,10,0.4)');
}

/** 1 m floor tile: noise, the 10 cm grid (optional) with a stronger 50 cm line, the bold 1 m edge. */
export function drawFloor(g: CanvasRenderingContext2D, st: Pick<StageLook, 'floor' | 'floorTex'>): void {
  const S = 512;
  const r = rng(23);
  g.fillStyle = st.floor;
  g.fillRect(0, 0, S, S);
  noise(g, S, S, r, 5000, 0.12, st.floorTex.noise, '#ffffff');
  g.fillStyle = st.floorTex.grid;
  if (st.floorTex.minor) {
    for (let i = 1; i < 10; i++) {
      const p = Math.round((i * S) / 10);
      const w = i === 5 ? 3 : 2;
      g.fillRect(p - w / 2, 0, w, S);
      g.fillRect(0, p - w / 2, S, w);
    }
  }
  g.fillStyle = st.floorTex.edge;
  g.fillRect(0, 0, 3, S);
  g.fillRect(S - 3, 0, 3, S);
  g.fillRect(0, 0, S, 3);
  g.fillRect(0, S - 3, S, 3);
}

/** 1 m board tile: paper1 base, fibres (short / kozo / wood grain / none), noise, the graph grid. */
export function drawPaper(g: CanvasRenderingContext2D, st: Pick<StageLook, 'paper1' | 'paperTex'>): void {
  const S = 512;
  const t = st.paperTex;
  const r = rng(37);
  g.fillStyle = st.paper1;
  g.fillRect(0, 0, S, S);
  if (t.fibre === 'short') {
    for (let i = 0; i < 420; i++) {
      const x = r() * S, y = r() * S, a = r() * Math.PI, l = 4 + r() * 16;
      g.strokeStyle = r() < 0.6 ? t.fibreDark : t.fibreLight;
      g.lineWidth = 0.6 + r() * 0.6;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
      g.stroke();
    }
  } else if (t.fibre === 'kozo') {
    // Long, gently bent kozo (mulberry) fibres.
    for (let i = 0; i < 200; i++) {
      const x = r() * S, y = r() * S, a = r() * Math.PI, l = 20 + r() * 40, bend = (r() - 0.5) * 0.5 * l;
      const ex = x + Math.cos(a) * l, ey = y + Math.sin(a) * l;
      g.strokeStyle = r() < 0.6 ? t.fibreDark : t.fibreLight;
      g.lineWidth = 0.9 + r() * 0.9;
      g.beginPath();
      g.moveTo(x, y);
      g.quadraticCurveTo((x + ex) / 2 - Math.sin(a) * bend, (y + ey) / 2 + Math.cos(a) * bend, ex, ey);
      g.stroke();
    }
  } else if (t.fibre === 'grain') {
    // Plywood grain: long, slightly wavy horizontal streaks (wrapped at the tile edge so the tile repeats).
    for (let i = 0; i < 150; i++) {
      const y = r() * S, x0 = r() * S, l = 60 + r() * 220, amp = 0.6 + r() * 2.2, ph = r() * 6.28, lw = 0.8 + r() * 1.6;
      g.strokeStyle = r() < 0.65 ? t.fibreDark : t.fibreLight;
      g.lineWidth = lw;
      for (const shift of x0 + l > S ? [0, -S] : [0]) {
        g.beginPath();
        for (let k = 0; k <= 12; k++) {
          const x = x0 + shift + (l * k) / 12, yy = y + Math.sin(ph + k * 0.7) * amp;
          if (k === 0) g.moveTo(x, yy);
          else g.lineTo(x, yy);
        }
        g.stroke();
      }
    }
  }
  noise(g, S, S, r, 4000, 0.1, t.noiseDark, t.noiseLight);
  // Faint graph-paper grid (10 cm), a little stronger every 50 cm and 1 m.
  const [cr, cg, cb] = t.grid.rgb;
  for (let i = 0; i <= 10; i++) {
    const p = Math.round((i * S) / 10);
    const major = i === 0 || i === 10;
    const alpha = major ? t.grid.alpha[0] : i === 5 ? t.grid.alpha[1] : t.grid.alpha[2];
    if (!(alpha > 0)) continue;
    g.fillStyle = `rgba(${cr},${cg},${cb},${alpha})`;
    const w = major ? 1.5 : 1.2;
    g.fillRect(p - w / 2, 0, w, S);
    g.fillRect(0, p - w / 2, S, w);
  }
}

/** Rail-end bumper stripes: colour a with diagonal stripes of colour b. */
export function drawHazard(g: CanvasRenderingContext2D, a: string, b: string): void {
  const W = 128, H = 32;
  g.fillStyle = a;
  g.fillRect(0, 0, W, H);
  g.fillStyle = b;
  for (let x = -H; x < W + H; x += 32) {
    g.beginPath();
    g.moveTo(x, H);
    g.lineTo(x + 16, H);
    g.lineTo(x + 16 + H, 0);
    g.lineTo(x + H, 0);
    g.closePath();
    g.fill();
  }
}

/** A canvas texture drawn by `draw`; `redraw` repaints the same canvas and flags the texture for upload. */
function drawn(w: number, h: number, srgb: boolean, repeat: boolean, draw: (g: CanvasRenderingContext2D) => void): {
  texture: CanvasTexture; redraw(draw: (g: CanvasRenderingContext2D) => void): void;
} {
  const [c, g] = canvas(w, h);
  draw(g);
  const t = tex(c, srgb, repeat);
  return {
    texture: t,
    redraw(d) {
      // Paint in a fresh canvas and copy it over: a browser may switch a canvas's rasteriser after complex paths, so
      // repainting in place can differ from a first paint by a few levels of antialiasing. A fresh canvas paints
      // exactly like the first time (the default look after a round trip is pixel-identical to a fresh boot).
      const [tc, tg] = canvas(w, h);
      d(tg);
      g.save();
      g.globalCompositeOperation = 'copy';
      g.drawImage(tc, 0, 0);
      g.restore();
      t.needsUpdate = true;
    },
  };
}

function makeSoft(): CanvasTexture {
  const S = 64;
  const [c, g] = canvas(S, S);
  const grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.45, 'rgba(255,255,255,0.55)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, S, S);
  const t = tex(c, false, false);
  return t;
}

// ---------------------------------------------------------------------------------------------
// Atlas (R = fill mask, G = halo mask, drawn additively on black so the channels stay separate).

const ATLAS = 512;
const GLYPHS = '0123456789.,-−+:/%°×mcsNkgMAIPBWRLxv?() FaT=·hrtenpθ';
const CELL_W = 30, CELL_H = 46, GLYPH_FONT = 'bold 38px ui-monospace, "SFMono-Regular", Menlo, Consolas, "DejaVu Sans Mono", monospace';
const LABEL_FONT = '800 34px "M PLUS Rounded 1c", "Hiragino Maru Gothic ProN", "Hiragino Sans", "Noto Sans JP", "Noto Sans CJK JP", system-ui, sans-serif';
const SLOT_W = 250, SLOT_H = 46, SLOT_COLS = 2, SLOT_ROWS = 3;
const GLYPH_ROWS = Math.ceil(GLYPHS.length / 16);
const LABEL_Y = 2 + GLYPH_ROWS * (CELL_H + 2) + 4;
const SHAPE_Y = LABEL_Y + SLOT_ROWS * (SLOT_H + 2) + 4;
const HEAD_Y = SHAPE_Y + 58 + 4, HEAD_H = ATLAS - 18 - HEAD_Y, HEAD_W = 490;
const HEAD_FONT = '800 84px "M PLUS Rounded 1c", "Hiragino Maru Gothic ProN", "Hiragino Sans", "Noto Sans JP", system-ui, sans-serif';

function makeAtlas(): Atlas {
  const [c, g] = canvas(ATLAS, ATLAS);
  g.fillStyle = '#000';
  g.fillRect(0, 0, ATLAS, ATLAS);
  const t = tex(c, false, false);
  const rect = (x: number, y: number, w: number, h: number): UvRect => ({
    u0: x / ATLAS, v0: 1 - (y + h) / ATLAS, u1: (x + w) / ATLAS, v1: 1 - y / ATLAS, aspect: w / h,
  });
  const RED = 'rgb(255,0,0)', GREEN = 'rgb(0,255,0)';

  // White block (both channels) in the corner.
  g.fillStyle = 'rgb(255,255,0)';
  g.fillRect(ATLAS - 16, ATLAS - 16, 16, 16);
  const white = rect(ATLAS - 12, ATLAS - 12, 8, 8);

  // Glyphs: 16 per row.
  const glyphs = new Map<string, UvRect>();
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = GLYPH_FONT;
  g.lineJoin = 'round';
  for (let i = 0; i < GLYPHS.length; i++) {
    const ch = GLYPHS[i] as string;
    const col = i % 16, row = Math.floor(i / 16);
    const x = 2 + col * (CELL_W + 2), y = 2 + row * (CELL_H + 2);
    g.save();
    g.beginPath();
    g.rect(x, y, CELL_W, CELL_H);
    g.clip();
    const cx = x + CELL_W / 2, cy = y + CELL_H / 2 + 2;
    const fit = Math.min(1, (CELL_W - 2) / Math.max(1, g.measureText(ch).width));
    g.translate(cx, cy);
    g.scale(fit, 1);
    g.globalCompositeOperation = 'lighter';
    g.strokeStyle = GREEN;
    g.lineWidth = 9;
    g.strokeText(ch, 0, 0);
    g.fillStyle = RED;
    g.fillText(ch, 0, 0);
    g.restore();
    glyphs.set(ch, rect(x, y, CELL_W, CELL_H));
  }

  // Shapes (64x64 cells) on the row below the glyphs and slots.
  const shapes = new Map<AtlasShape, UvRect>();
  const SY = SHAPE_Y;
  let sx = 2;
  const shape = (name: AtlasShape, draw: (g: CanvasRenderingContext2D) => void): void => {
    const S = 54;
    g.save();
    g.translate(sx + S / 2 + 2, SY + S / 2 + 2);
    g.globalCompositeOperation = 'lighter';
    g.lineJoin = 'round';
    g.lineCap = 'round';
    // Halo: thick stroke + fill in green.
    g.strokeStyle = GREEN;
    g.fillStyle = GREEN;
    g.lineWidth = 7;
    g.beginPath();
    draw(g);
    g.stroke();
    g.fill();
    g.fillStyle = RED;
    g.strokeStyle = RED;
    g.lineWidth = 0.01;
    g.beginPath();
    draw(g);
    g.fill();
    g.restore();
    shapes.set(name, rect(sx, SY, S + 4, S + 4));
    sx += S + 6;
  };
  const poly = (g: CanvasRenderingContext2D, pts: [number, number][]): void => {
    pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.closePath();
  };
  const R = 22;
  shape('hex', (g) => poly(g, Array.from({ length: 6 }, (_, i) => [R * 1.1 * Math.cos((i * Math.PI) / 3), R * 0.95 * Math.sin((i * Math.PI) / 3)] as [number, number])));
  shape('circle', (g) => g.arc(0, 0, R, 0, Math.PI * 2));
  shape('star', (g) => poly(g, Array.from({ length: 10 }, (_, i) => {
    const a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? R * 0.48 : R * 1.12;
    return [rr * Math.cos(a), rr * Math.sin(a) + 2] as [number, number];
  })));
  shape('tri', (g) => poly(g, [[0, -R * 1.05], [R * 1.1, R * 0.8], [-R * 1.1, R * 0.8]]));
  shape('flag', (g) => poly(g, [[-R, -R], [R, -R * 0.55], [-R * 0.55, -R * 0.1], [-R * 0.55, R], [-R, R]]));
  shape('diamond', (g) => poly(g, [[0, -R], [R, 0], [0, R], [-R, 0]]));
  shape('arrow', (g) => poly(g, [[R, 0], [-R * 0.3, -R * 0.9], [-R * 0.3, -R * 0.3], [-R, -R * 0.3], [-R, R * 0.3], [-R * 0.3, R * 0.3], [-R * 0.3, R * 0.9]]));
  // Brush-stroke X: two tapered strokes.
  shape('x', (g) => {
    const s = R * 1.05, w = 6;
    poly(g, [[-s, -s + w], [-s + w, -s], [s, s - w], [s - w, s]]);
    poly(g, [[s - w, -s], [s, -s + w], [-s + w, s], [-s, s - w]]);
  });

  // Dynamic label slots.
  const LY = LABEL_Y;
  const slots: { text: string; rect: UvRect; used: number }[] = [];
  let clock = 0;
  const label = (text: string): UvRect => {
    const hit = slots.find((s) => s.text === text);
    clock++;
    if (hit) {
      hit.used = clock;
      return hit.rect;
    }
    let idx = slots.length;
    if (idx >= SLOT_COLS * SLOT_ROWS) {
      let lru = 0;
      for (let i = 1; i < slots.length; i++) if ((slots[i] as { used: number }).used < (slots[lru] as { used: number }).used) lru = i;
      idx = lru;
    }
    const x = 2 + (idx % SLOT_COLS) * (SLOT_W + 4), y = LY + Math.floor(idx / SLOT_COLS) * (SLOT_H + 2);
    g.save();
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = '#000';
    g.fillRect(x, y, SLOT_W, SLOT_H);
    g.beginPath();
    g.rect(x, y, SLOT_W, SLOT_H);
    g.clip();
    g.font = LABEL_FONT;
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    const tw = Math.min(SLOT_W - 10, g.measureText(text).width);
    const sc = Math.min(1, (SLOT_W - 10) / Math.max(1, g.measureText(text).width));
    g.translate(x + 5, y + SLOT_H / 2 + 2);
    g.scale(sc, 1);
    g.globalCompositeOperation = 'lighter';
    g.lineJoin = 'round';
    g.strokeStyle = GREEN;
    g.lineWidth = 8;
    g.strokeText(text, 0, 0);
    g.fillStyle = RED;
    g.fillText(text, 0, 0);
    g.restore();
    const r = rect(x, y, Math.ceil(tw + 10), SLOT_H);
    const slot = { text, rect: r, used: clock };
    slots[idx] = slot;
    t.needsUpdate = true;
    return r;
  };

  let headText = '';
  let headRect = rect(2, HEAD_Y, 8, HEAD_H);
  const heading = (text: string): UvRect => {
    if (text === headText) return headRect;
    headText = text;
    g.save();
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = '#000';
    g.fillRect(0, HEAD_Y - 2, HEAD_W + 4, HEAD_H + 4);
    g.beginPath();
    g.rect(2, HEAD_Y, HEAD_W, HEAD_H);
    g.clip();
    g.font = HEAD_FONT;
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    const tw = Math.min(HEAD_W - 12, g.measureText(text).width);
    g.fillStyle = RED;
    g.fillText(text, 8, HEAD_Y + HEAD_H / 2 + 4, HEAD_W - 12);
    g.restore();
    headRect = rect(2, HEAD_Y, Math.ceil(tw + 14), HEAD_H);
    t.needsUpdate = true;
    return headRect;
  };

  return {
    texture: t,
    white,
    glyph: (ch) => glyphs.get(ch) ?? (glyphs.get('?') as UvRect),
    shape: (n) => shapes.get(n) as UvRect,
    label,
    heading,
    invalidateText: () => {
      slots.length = 0;
      headText = '';
    },
    dispose: () => t.dispose(),
  };
}

export function createTextures(look: { stage: StageLook; crane: Pick<CraneLook, 'hazard'> } = DEFAULT_LOOK): Textures {
  const st = look.stage;
  const brick = drawn(256, 128, true, false, (g) => drawBrick(g, st.brickTex));
  const floor = drawn(512, 512, true, true, (g) => drawFloor(g, st));
  const hz = look.crane.hazard;
  const hazard = drawn(128, 32, true, true, (g) => drawHazard(g, hz[0], hz[1]));
  const paper = drawn(512, 512, true, true, (g) => drawPaper(g, st));
  const atlas = makeAtlas();
  const soft = makeSoft();
  return {
    brick: brick.texture, floor: floor.texture, hazard: hazard.texture, paper: paper.texture, atlas, soft,
    restyle(stage) {
      paper.redraw((g) => drawPaper(g, stage));
      floor.redraw((g) => drawFloor(g, stage));
      brick.redraw((g) => drawBrick(g, stage.brickTex));
    },
    setHazard(a, b) {
      hazard.redraw((g) => drawHazard(g, a, b));
    },
    dispose() {
      brick.texture.dispose();
      floor.texture.dispose();
      hazard.texture.dispose();
      paper.texture.dispose();
      atlas.dispose();
      soft.dispose();
    },
  };
}
