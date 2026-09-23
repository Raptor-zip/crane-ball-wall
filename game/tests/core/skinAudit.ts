// Readability gate for skins (skins spec §5.8). Test-only helper (not shipped in src/). Owner: O5.
//
// Colour maths: WCAG contrast; CIELAB (D65) with CIEDE2000; Machado 2009 colour-vision-deficiency simulation (protan,
// deutan, tritan at severity 1, on linear RGB), "cvd" = the minimum over normal vision and the three; over() blends
// in encoded sRGB (as GL blends on the canvas), shade() multiplies in linear space.
// The model is analytic: fixed light factors (top faces 1.0, front faces 0.68, ball samples 0.85 / 0.45), board samples
// (HUD band paper2 x 0.99, level centre paper1 x 1.02, contact band paper2 x 0.877) and ghost samples built from the
// ghost styles (a centre sample and a rim sample over the board).
// Gate: need = the target when today's default meets it, else 0.9 x today (1.1 x for max-type checks). BASELINE is a
// literal table (today), so a change to the default palette cannot lower the bar.
import type { SkinLook } from '../../src/render/skinLooks';
import { ballTrailColour, confettiPalette, craneAccent } from '../../src/render/skinLooks';

export type RGB = [number, number, number]; // sRGB 0..1 (encoded)
export type Lab = [number, number, number];

export function hex(h: string): RGB {
  const s = h.replace('#', '');
  return [parseInt(s.slice(0, 2), 16) / 255, parseInt(s.slice(2, 4), 16) / 255, parseInt(s.slice(4, 6), 16) / 255];
}
export const rgb255 = (r: number, g: number, b: number): RGB => [r / 255, g / 255, b / 255];
const lin = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const enc = (v: number): number => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
export const toLin = (c: RGB): RGB => [lin(c[0]), lin(c[1]), lin(c[2])];
export const toSrgb = (c: RGB): RGB => [enc(c[0]), enc(c[1]), enc(c[2])];

/** WCAG 2.x relative luminance and contrast ratio (1..21). */
export function relLum(c: RGB): number {
  const l = toLin(c);
  return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2];
}
export function contrast(a: RGB, b: RGB): number {
  const la = relLum(a), lb = relLum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
/** Alpha "over" in encoded sRGB. */
export function over(fg: RGB, a: number, bg: RGB): RGB {
  return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a)];
}
/** Multiplies the linear colour by k (lighting / vertex shade), back to sRGB. */
export function shade(c: RGB, k: number): RGB {
  const l = toLin(c);
  return toSrgb([Math.min(1, l[0] * k), Math.min(1, l[1] * k), Math.min(1, l[2] * k)]);
}

export function lab(c: RGB): Lab {
  const [r, g, b] = toLin(c);
  const X = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const Y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const Z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIEDE2000 of two CIELAB colours. */
export function de2000(p: Lab, q: Lab): number {
  const [L1, a1, b1] = p, [L2, a2, b2] = q;
  const d = Math.PI / 180;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const h = (x: number, y: number): number => {
    if (x === 0 && y === 0) return 0;
    const v = Math.atan2(y, x) / d;
    return v < 0 ? v + 360 : v;
  };
  const h1p = h(a1p, b1), h2p = h(a2p, b2);
  const dLp = L2 - L1, dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * d);
  const Lbp = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2;
  let hbp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) hbp += h1p + h2p < 360 ? 360 : -360;
    hbp /= 2;
  }
  const T = 1 - 0.17 * Math.cos((hbp - 30) * d) + 0.24 * Math.cos(2 * hbp * d) + 0.32 * Math.cos((3 * hbp + 6) * d) - 0.2 * Math.cos((4 * hbp - 63) * d);
  const dTh = 30 * Math.exp(-(((hbp - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2);
  const Sc = 1 + 0.045 * Cbp, Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(2 * dTh * d) * Rc;
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh));
}
export const dE = (a: RGB, b: RGB): number => de2000(lab(a), lab(b));

/** Machado, Oliveira & Fernandes 2009, severity 1.0, on linear RGB (row-major 3x3). */
export const CVD_MATRICES: Record<'protan' | 'deutan' | 'tritan', readonly number[]> = {
  protan: [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998],
  deutan: [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.01182, 0.04294, 0.968881],
  tritan: [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.3039],
};
export type Cvd = 'normal' | 'protan' | 'deutan' | 'tritan';
export const CVDS: readonly Cvd[] = ['normal', 'protan', 'deutan', 'tritan'];
export function cvd(c: RGB, k: Cvd): RGB {
  if (k === 'normal') return c;
  const m = CVD_MATRICES[k], l = toLin(c);
  const o = [m[0]! * l[0] + m[1]! * l[1] + m[2]! * l[2], m[3]! * l[0] + m[4]! * l[1] + m[5]! * l[2], m[6]! * l[0] + m[7]! * l[1] + m[8]! * l[2]];
  return toSrgb([Math.min(1, Math.max(0, o[0]!)), Math.min(1, Math.max(0, o[1]!)), Math.min(1, Math.max(0, o[2]!))]);
}
/** Smallest CIEDE2000 of a pair over normal vision and the three simulated dichromacies. */
export function dEcvd(a: RGB, b: RGB): { min: number; worst: Cvd } {
  let min = Infinity, worst: Cvd = 'normal';
  for (const k of CVDS) {
    const v = dE(cvd(a, k), cvd(b, k));
    if (v < min) {
      min = v;
      worst = k;
    }
  }
  return { min, worst };
}

/** LCh hue bands reserved for gameplay meaning (chroma >= 20): goal green and AI cyan. */
export const RESERVED = [{ id: 'goal', h0: 135, h1: 185 }, { id: 'ai', h0: 215, h1: 265 }] as const;
export function reservedHit(h: string): string | null {
  const [, a, b] = lab(hex(h));
  const C = Math.hypot(a, b);
  if (C < 20) return null;
  let H = (Math.atan2(b, a) * 180) / Math.PI;
  if (H < 0) H += 360;
  for (const r of RESERVED) if (H >= r.h0 && H <= r.h1) return `${r.id} (h ${H.toFixed(0)}, C ${C.toFixed(0)})`;
  return null;
}
const toHexByte = (v: number): string => Math.round(v).toString(16).padStart(2, '0');
export const rgbHex = (c: readonly [number, number, number]): string => `#${c.map(toHexByte).join('')}`.toUpperCase();

// ------------------------------------------------------------------------------------------------ fixed colours

const INK = hex('#1E2A44'), INK2 = hex('#4B5670'), GOAL = hex('#22B573'), DANGER = hex('#E5484D'), AMBER = hex('#F59E0B');
const WHITE = hex('#FFFFFF'), AI = hex('#19C3FF'), EGG_LINE = hex('#6B5536');
/** Ghost looks (render/ghosts.ts ghostStyle) by kind: colour, alpha, scanlines, outline ring. */
export const GHOST_LOOKS: Readonly<Record<string, { c: string; a: number; scan: number; ring: string | null }>> = {
  ai: { c: '#19C3FF', a: 0.85, scan: 1, ring: null },
  calm: { c: '#19C3FF', a: 0.75, scan: 1, ring: null },
  research_fast: { c: '#6FDAFF', a: 0.7, scan: 1, ring: null },
  research_pump: { c: '#6FDAFF', a: 0.7, scan: 1, ring: null },
  reverse_hint: { c: '#6FDAFF', a: 0.7, scan: 1, ring: null },
  pb: { c: '#FFC23D', a: 0.4, scan: 0, ring: '#C98A00' },
  daily_pb: { c: '#FFC23D', a: 0.4, scan: 0, ring: '#C98A00' },
  wr: { c: '#FF3FA4', a: 0.72, scan: 0, ring: null },
  rival: { c: '#FF8A3D', a: 0.75, scan: 0, ring: null },
  challenge: { c: '#FFFFFF', a: 0.88, scan: 0, ring: '#1E2A44' },
};
const GHOSTS = (() => {
  const seen = new Set<string>();
  const out: { id: string; c: RGB; a: number; scan: number }[] = [];
  for (const [id, g] of Object.entries(GHOST_LOOKS)) {
    const key = `${g.c}/${g.a}/${g.scan}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id, c: hex(g.c), a: g.a, scan: g.scan });
  }
  return out;
})();
/** Ghost tags drawn on the beam face (the tag icon colour): AI, PB, WR, rival. */
const TAGS: readonly { id: string; c: RGB }[] = [
  { id: 'ai', c: hex('#19C3FF') }, { id: 'pb', c: hex('#FFC23D') }, { id: 'wr', c: hex('#FF3FA4') }, { id: 'rival', c: hex('#FF8A3D') },
];

const LIT_TOP = 1.0, LIT_FRONT = 0.68, BALL_LIT = [0.85, 0.45] as const;
/** Today's CIEDE2000 of the 1 m / 0.5 m / 0.1 m grid lines over paper-1 (G1 normalises by these). */
export const GRID_TODAY = [11.0, 7.73, 4.98] as const;

// ------------------------------------------------------------------------------------------------ the audit

export interface Check { id: string; v: number; target: number; max?: boolean; note?: string }

const minOf = (xs: number[]): number => Math.min(...xs);

/** Every readability check of one look combination; `egg` = the 4-3 cargo (the ball and string skins are ignored). */
export function audit(look: SkinLook, egg = false): Check[] {
  const out: Check[] = [];
  const add = (id: string, v: number, target: number, note?: string): void => { out.push({ id, v, target, note }); };
  const addMax = (id: string, v: number, target: number, note?: string): void => { out.push({ id, v, target, max: true, note }); };
  const st = look.stage, cr = look.crane, tr = look.trail, ba = look.ball;
  const p1 = hex(st.paper1), p2 = hex(st.paper2);
  const B = { hud: shade(p2, 1.02 * 0.97), mid: shade(p1, 1.02), low: shade(p2, 0.86 * 1.02) };
  const boards = [B.hud, B.mid, B.low];
  const floor = hex(st.floor);
  const floorTop = shade(floor, 0.97 * LIT_TOP), floorFront = shade(floor, 0.84 * LIT_FRONT);
  const wall: RGB[] = [];
  for (const c of [st.brick1, st.brick2]) for (const k of [0.86 * 0.78, 1.12]) for (const l of [LIT_FRONT, LIT_TOP]) wall.push(shade(hex(c), k * k * l));
  const f1 = shade(hex(st.brick1), LIT_FRONT), f2 = shade(hex(st.brick2), LIT_FRONT);
  const face: RGB = [(f1[0] + f2[0]) / 2, (f1[1] + f2[1]) / 2, (f1[2] + f2[2]) / 2];
  const ghostSamples = (bg: RGB): { id: string; s: RGB[] }[] => GHOSTS.map((g) => {
    const a = g.a * (1 - 0.19 * g.scan);
    return { id: g.id, s: [over(shade(g.c, 0.72), 0.5 * a, bg), over(g.c, a, bg)] };
  });
  /** Smallest ΔE00(cvd) of a colour to every ghost ball sample over every board sample, and which. */
  const ghostMin = (c: RGB): { v: number; who: string } => {
    let v = Infinity, who = '';
    for (const p of boards) for (const g of ghostSamples(p)) for (const s of g.s) {
      const r = dEcvd(c, s);
      if (r.min < v) {
        v = r.min;
        who = `${g.id}/${r.worst}`;
      }
    }
    return { v, who };
  };

  // ---- B: board and walls
  add('B1', contrast(INK, B.hud), 7, 'ink text on the HUD band');
  add('B2', contrast(INK2, B.hud), 4.5, 'ink-2 small text on the HUD band');
  add('B3', contrast(INK, floorFront), 4.5, 'ink ruler on the floor front');
  add('B4', minOf(boards.map((p) => contrast(face, p))), 3, 'wall face vs board');
  const b5 = wall.map((w) => dEcvd(w, GOAL)).sort((x, y) => x.min - y.min)[0]!;
  add('B5', b5.min, 12, `walls vs goal (${b5.worst})`);
  const b6 = dEcvd(over(GOAL, 0.4, floorTop), floorTop);
  add('B6', b6.min, 12, `goal pad vs floor (${b6.worst})`);
  add('B7', minOf(boards.map((p) => dEcvd(over(AI, 0.6, p), p).min)), 12, 'AI line vs board');
  add('B8', minOf(wall.map((w) => contrast(p1, w))), 2, 'paper-1 halo vs bricks');
  add('B9', minOf(wall.map((w) => dE(DANGER, w))), 8, 'danger X vs walls');
  addMax('B10', Math.max(dE(p1, hex('#F3EEE4')), dE(p2, hex('#E6DCCB'))), 10, 'board stays in the CSS paper family');

  // ---- P: the player's ball (not on the egg level)
  if (!egg) {
    const body = hex(ba.body), outline = hex(ba.outline);
    const lit = BALL_LIT.map((k) => shade(body, k));
    add('P1', minOf(boards.map((p) => contrast(outline, p))), 4.5, 'ball outline vs board');
    addMax('P2', lab(outline)[0], 35, 'ball outline L*');
    add('P3', minOf(lit.flatMap((l) => boards.map((p) => dE(l, p)))), 20, 'ball vs board');
    add('P4', minOf(lit.flatMap((l) => wall.map((w) => dE(l, w)))), 6, 'ball vs walls');
    let p5 = Infinity, who = '';
    for (const l of lit) {
      const g = ghostMin(l);
      if (g.v < p5) {
        p5 = g.v;
        who = g.who;
      }
    }
    add('P5', p5, 14, `ball vs ghost balls (${who})`);
    add('P6', minOf(lit.map((l) => dEcvd(l, over(GOAL, 0.45, B.mid)).min)), 14, 'ball vs goal curtain');
    addMax('P7', lab(body)[0], 72, 'ball body L*');
    const beamF = shade(hex(cr.beam), LIT_FRONT);
    add('P8', Math.max(minOf(lit.map((l) => dE(l, beamF))) / 8, contrast(outline, beamF) / 3), 1, 'ball vs beam');
    for (const l of ba.pattern ?? []) {
      const cover = l.kind === 'speckle' ? l.cover : l.width * l.axes.length;
      if (cover <= 0.06) continue;
      const g = ghostMin(shade(hex(l.color), 0.85));
      add(`P9 ${l.color}`, g.v, 14, `pattern vs ghosts (${g.who})`);
    }
    if (ba.mat.metalness > 0.2) add('P10', p5, 20, 'metal ball vs ghosts (reflection margin)');
  }

  // ---- S: string and trail
  const ballC = ballTrailColour(ba, egg);
  if (!egg) {
    for (const [tag, c] of [['', tr.string], [' edge', tr.stringEdge]] as const) {
      const s = hex(c);
      add(`S1${tag}`, minOf(boards.map((p) => contrast(s, p))), 4.5, 'string vs board');
      add(`S2${tag}`, Math.max(contrast(s, face) / 2, dEcvd(s, face).min / 20), 1, 'string vs wall face');
      let sw = Infinity;
      for (const g of GHOSTS) sw = Math.min(sw, dEcvd(s, over(g.c, g.a * 0.85, B.mid)).min);
      add(`S3${tag}`, sw, 20, 'string vs ghost strings');
    }
  }
  const ribbon = hex(tr.ribbon.color === 'ball' ? ballC : tr.ribbon.color);
  const rib = over(ribbon, 0.34, B.mid);
  add('S4', dEcvd(rib, over(AI, 0.6, B.mid)).min, 10, 'trail vs AI dotted line');
  add('S5', dEcvd(rib, over(GOAL, 0.34, B.mid)).min, 8, 'trail vs goal');
  add('S6', dE(rib, B.mid), 8, 'trail on the board');
  if (!egg) {
    const strobe = hex(tr.strobe.color === 'ball' ? ballC : tr.strobe.color);
    const g = ghostMin(shade(strobe, 0.85));
    add('S7', g.v, 14, `strobe copies vs ghosts (${g.who})`);
  }

  // ---- K: crane
  const trolley = hex(cr.body), beam = hex(cr.beam), beamF = shade(beam, LIT_FRONT), trolleyF = shade(trolley, LIT_FRONT);
  add('K1', contrast(hex(cr.hazard[0]), hex(cr.hazard[1])), 4.5, 'hazard stripes');
  add('K2', minOf(boards.map((p) => contrast(trolleyF, p))), 4.5, 'trolley vs board');
  let k3 = Infinity;
  for (const g of GHOSTS) k3 = Math.min(k3, dEcvd(trolleyF, over(g.c, Math.min(1, g.a * 1.15), B.mid)).min);
  add('K3', k3, 20, 'trolley vs ghost trolleys');
  add('K4', Math.min(dE(GOAL, trolley), dE(AMBER, trolley), dE(DANGER, trolley)), 25, 'status lamp vs trolley');
  add('K5', contrast(WHITE, beamF), 1.25, 'white tag halo vs beam');
  add('K6', minOf(boards.map((p) => dE(beamF, p))), 15, 'beam vs board');
  const k7 = dEcvd(beamF, GOAL);
  add('K7', k7.min, 15, `beam vs goal (${k7.worst})`);
  add('K8', dE(trolleyF, beamF), 15, 'trolley vs beam');
  add('K9', minOf(boards.map((p) => contrast(beamF, p))), 1.5, 'beam contrast vs board');
  for (const t of TAGS) {
    const r = dEcvd(t.c, beamF);
    add(`K10 ${t.id}`, r.min, 12, `ghost tag vs beam (${r.worst})`);
  }

  // ---- E: the egg level (4-3 keeps the egg and its tension string; the board, walls and crane still apply)
  if (egg) {
    add('E1', minOf(boards.map((p) => contrast(EGG_LINE, p))), 4.5, 'egg outline vs board');
    add('E3', minOf(boards.flatMap((p) => [dEcvd(AMBER, p).min, dEcvd(DANGER, p).min])), 20, 'tension string amber / red vs board');
    add('E4', minOf(boards.map((p) => contrast(INK, p))), 7, 'string ink edge vs board');
  }

  // ---- R: reserved hues
  const r1: [string, string][] = [
    ['paper1', st.paper1], ['paper2', st.paper2], ['floor', st.floor], ['brick1', st.brick1], ['brick2', st.brick2], ['mortar', st.mortar],
    ['beam', cr.beam], ['trolley', cr.body],
  ];
  if (!egg) r1.push(['string', tr.string], ['ball', ba.body]);
  if (tr.ribbon.color !== 'ball') r1.push(['ribbon', tr.ribbon.color]);
  const hits1 = r1.map(([n, h]) => [n, reservedHit(h)] as const).filter(([, x]) => !!x).map(([n, x]) => `${n}: ${x}`);
  addMax('R1', hits1.length, 0, hits1.join('; '));
  const r2: [string, string][] = [
    ...(ba.pattern ?? []).map((l, i) => [`pattern${i}`, l.color] as [string, string]),
    ...(ba.trail ? [['ball.trail', ba.trail] as [string, string]] : []),
    ['beamDark', cr.beamDark], ['foot', cr.foot], ['bodyTop', cr.bodyTop], ['plate', cr.plate], ['hub', cr.hub], ['steel', cr.steel],
    ['accent', craneAccent(cr, ba)], ['hazardA', cr.hazard[0]], ['hazardB', cr.hazard[1]],
    ...(cr.legs ? [['legs', cr.legs] as [string, string]] : []),
    ...(cr.legCap ? [['legCap', cr.legCap] as [string, string]] : []),
    ...(cr.brace ? [['brace', cr.brace] as [string, string]] : []),
    ...(cr.legBands ? [['bandA', cr.legBands.a], ['bandB', cr.legBands.b]] as [string, string][] : []),
    ['grid', rgbHex(st.paperTex.grid.rgb)], ['floorGrid', st.floorTex.grid], ['floorEdge', st.floorTex.edge], ['blob', st.blob],
    ['stringEdge', tr.stringEdge],
  ];
  if (tr.strobe.color !== 'ball') r2.push(['strobe', tr.strobe.color]);
  const hits2 = r2.map(([n, h]) => [n, reservedHit(h)] as const).filter(([, x]) => !!x).map(([n, x]) => `${n}: ${x}`);
  const conf = tr.confetti.palette === 'auto' ? [] : confettiPalette(look);
  const hitsC = conf.map((h) => [h, reservedHit(h)] as const).filter(([, x]) => !!x && x.startsWith('ai')).map(([h, x]) => `confetti ${h}: ${x}`);
  addMax('R2', hits2.length + hitsC.length, 0, [...hits2, ...hitsC].join('; '));

  // ---- G: graph grid strength over paper-1, relative to today
  st.paperTex.grid.alpha.forEach((a, i) => {
    const g = rgb255(...st.paperTex.grid.rgb);
    const ratio = dE(over(g, a, p1), p1) / GRID_TODAY[i]!;
    add(`G1 ${['1m', '0.5m', '0.1m'][i]}`, ratio, i < 2 ? 0.6 : 0, 'grid line strength vs today');
    addMax(`G1 ${['1m', '0.5m', '0.1m'][i]} max`, ratio, 1.1, 'grid line strength vs today');
  });
  return out.map((c) => ({ ...c, v: Math.round(c.v * 100) / 100 }));
}

/**
 * Today's values (the default look; the checks shared by both cargos have the same value on 4-3). Literal on purpose:
 * a change to the default palette cannot lower the gate. Checks without an entry (P9, P10) use their target.
 */
export const BASELINE: Readonly<Record<string, number>> = {
  B1: 10.42, B2: 5.35, B3: 5.82, B4: 3.81, B5: 10.54, B6: 7.28, B7: 21.19, B8: 2.81,
  B9: 9.95, B10: 0, P1: 6.99, P2: 26.14, P3: 41.75, P4: 8.21, P5: 18.35, P6: 28.93,
  P7: 49.77, P8: 5.03, S1: 9.23, S2: 1.21, S3: 44.8, 'S1 edge': 9.23, 'S2 edge': 1.21, 'S3 edge': 44.8,
  S4: 24.45, S5: 6.1, S6: 22.73, S7: 18.35, K1: 9.17, K2: 8.05, K3: 29.82, K4: 42.4,
  K5: 2.57, K6: 25.32, K7: 12.07, K8: 58.27, K9: 1.67, 'K10 ai': 50.97, 'K10 pb': 9.9, 'K10 wr': 17.17,
  'K10 rival': 3.65, R1: 0, R2: 0, 'G1 1m': 1, 'G1 1m max': 1, 'G1 0.5m': 1, 'G1 0.5m max': 1, 'G1 0.1m': 1,
  'G1 0.1m max': 1, E1: 4.6, E3: 21.91, E4: 9.31,
};

export interface GateResult { id: string; v: number; need: number; ok: boolean; max: boolean; note?: string }

/** The gate: absolute targets, relaxed to 0.9 x today (1.1 x for max checks) where today's default is weaker. */
export function gate(look: SkinLook, egg = false, baseline: Readonly<Record<string, number>> = BASELINE): GateResult[] {
  return audit(look, egg).map((c) => {
    const key = `${c.id}${egg ? '@egg' : ''}`;
    const b = baseline[key] ?? baseline[c.id];
    let need = c.target;
    if (b !== undefined) need = c.max ? (b <= c.target ? c.target : b * 1.1) : (b >= c.target ? c.target : b * 0.9);
    const ok = c.max ? c.v <= need + 1e-9 : c.v >= need - 1e-9;
    return { id: c.id, v: c.v, need: Math.round(need * 100) / 100, ok, max: !!c.max, note: c.note };
  });
}
