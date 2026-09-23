// Canvas-generated textures, max 6 of <= 512^2 (GAME_DESIGN.md §9.1). Owner: O5.
//
//   brick  256x128  one brick face: noise + baked bevel ("normal-like" shading); tinted per instance
//   floor  512x512  1 m tile: 10 cm grid, bold 1 m line
//   hazard 128x32   yellow/black stripes for the rail-end bumpers
//   paper  512x512  1 m tile: paper fibres + faint 10 cm grid for the back board
//   atlas  512x512  masks: R = fill, G = halo. Glyphs, ghost tag shapes, X decal, arrow, dynamic labels
//   soft   64x64    radial falloff for blob shadows and glows
import {
  CanvasTexture, ClampToEdgeWrapping, LinearFilter, LinearMipmapLinearFilter, NoColorSpace,
  RepeatWrapping, SRGBColorSpace,
} from 'three';

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

function makeBrick(): CanvasTexture {
  const W = 256, H = 128;
  const [c, g] = canvas(W, H);
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
  const edge = (x0: number, y0: number, x1: number, y1: number, col: string): void => {
    const grd = g.createLinearGradient(x0, y0, x1, y1);
    grd.addColorStop(0, col);
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0) || W, Math.abs(y1 - y0) || H);
  };
  edge(0, 0, 0, b, 'rgba(255,255,255,0.55)');
  edge(0, 0, b, 0, 'rgba(255,255,255,0.35)');
  edge(0, H, 0, H - b * 1.4, 'rgba(40,20,10,0.55)');
  edge(W, 0, W - b, 0, 'rgba(40,20,10,0.4)');
  return tex(c, true, false);
}

function makeFloor(): CanvasTexture {
  const S = 512;
  const [c, g] = canvas(S, S);
  const r = rng(23);
  g.fillStyle = '#d9d4cb';
  g.fillRect(0, 0, S, S);
  noise(g, S, S, r, 5000, 0.12, '#8d8577', '#ffffff');
  g.fillStyle = '#c9c2b6';
  for (let i = 1; i < 10; i++) {
    const p = Math.round((i * S) / 10);
    const w = i === 5 ? 3 : 2;
    g.fillRect(p - w / 2, 0, w, S);
    g.fillRect(0, p - w / 2, S, w);
  }
  g.fillStyle = '#b3aa9b';
  g.fillRect(0, 0, 3, S);
  g.fillRect(S - 3, 0, 3, S);
  g.fillRect(0, 0, S, 3);
  g.fillRect(0, S - 3, S, 3);
  return tex(c, true, true);
}

function makePaper(): CanvasTexture {
  const S = 512;
  const [c, g] = canvas(S, S);
  const r = rng(37);
  g.fillStyle = '#f3eee4';
  g.fillRect(0, 0, S, S);
  // Fibres.
  for (let i = 0; i < 420; i++) {
    const x = r() * S, y = r() * S, a = r() * Math.PI, l = 4 + r() * 16;
    g.strokeStyle = r() < 0.6 ? 'rgba(150,130,100,0.10)' : 'rgba(255,255,255,0.5)';
    g.lineWidth = 0.6 + r() * 0.6;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
    g.stroke();
  }
  noise(g, S, S, r, 4000, 0.1, '#a89878', '#ffffff');
  // Faint graph-paper grid (10 cm), a little stronger every 50 cm and 1 m.
  for (let i = 0; i <= 10; i++) {
    const p = Math.round((i * S) / 10);
    const major = i === 0 || i === 10;
    g.fillStyle = major ? 'rgba(150,170,200,0.42)' : i === 5 ? 'rgba(150,170,200,0.30)' : 'rgba(150,170,200,0.20)';
    const w = major ? 1.5 : 1.2;
    g.fillRect(p - w / 2, 0, w, S);
    g.fillRect(0, p - w / 2, S, w);
  }
  return tex(c, true, true);
}

function makeHazard(): CanvasTexture {
  const W = 128, H = 32;
  const [c, g] = canvas(W, H);
  g.fillStyle = '#f2b705';
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#1e1e1e';
  for (let x = -H; x < W + H; x += 32) {
    g.beginPath();
    g.moveTo(x, H);
    g.lineTo(x + 16, H);
    g.lineTo(x + 16 + H, 0);
    g.lineTo(x + H, 0);
    g.closePath();
    g.fill();
  }
  return tex(c, true, true);
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

export function createTextures(): Textures {
  const brick = makeBrick();
  const floor = makeFloor();
  const hazard = makeHazard();
  const paper = makePaper();
  const atlas = makeAtlas();
  const soft = makeSoft();
  return {
    brick, floor, hazard, paper, atlas, soft,
    dispose() {
      brick.dispose();
      floor.dispose();
      hazard.dispose();
      paper.dispose();
      atlas.dispose();
      soft.dispose();
    },
  };
}
