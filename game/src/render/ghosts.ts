// Ghost trolley + ball meshes (GAME_DESIGN.md §8.4, §9.7). Owner: O5.
//
// All ghosts share ONE dynamic QuadBatch with a hologram shader (well under the "2 meshes per
// ghost" budget): a lit-edge trolley silhouette, the string, a sphere-shaded disc for the ball and
// a tag over the trolley. Ghosts live at z = -0.12, behind the player's plane.
// Tags ride on the beam face; one that would sit on the player's trolley or on another tag moves to
// the row above the beam, where tags are packed side by side and centred over their trolleys (at the
// start pose: [AI][PB] over the start). Row switches glide instead of popping.
// Accessibility (§3.5): colour + shape + label — AI = hexagon, PB = circle, WR = star,
// rival = triangle, challenge = flag.
//
// Decision: the AI ghost uses normal alpha blending with scanlines and a bright rim instead of
// pure additive blending, because additive cyan vanishes on the light paper background (§9.1
// "legible first").
import { Color, DoubleSide, ShaderMaterial } from 'three';
import type { Texture } from 'three';
import type { GhostKind, GhostPose } from './renderer';
import type { AtlasShape } from './textures';
import type { QuadBatch } from './overlays';
import { PAL, Z_GHOST, col } from './scene';
import { BEAM_BOTTOM, BEAM_TOP, HOOK_Y, TROLLEY_HALF_W } from './crane';

const M_SPHERE = 1, M_EDGE = 2, M_RING = 3;

const VS = /* glsl */ `
attribute vec4 aCol;
attribute vec2 aUv;
attribute float aMode;
attribute float aExtra;
varying vec4 vCol;
varying vec2 vUv;
varying float vMode;
varying float vScan;
void main() {
  vCol = aCol; vUv = aUv; vMode = aMode; vScan = aExtra;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const FS = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uHalo;
uniform float uTime;
uniform float uPx;
uniform float uFlicker;
varying vec4 vCol;
varying vec2 vUv;
varying float vMode;
varying float vScan;
void main() {
  vec3 c = vCol.rgb;
  float a = 1.0;
  if (vMode < 0.5) {
    vec4 t = texture2D(uMap, vUv);
    c = mix(uHalo, vCol.rgb, clamp(t.r * 1.2, 0.0, 1.0));
    a = max(t.r, t.g * 0.75);
  } else if (vMode < 1.5) {
    float r = length(vUv);
    float aa = max(fwidth(r), 1e-3);
    float inside = 1.0 - smoothstep(1.0 - aa, 1.0, r);
    float rim = smoothstep(0.45, 1.0, r);
    float hl = exp(-dot(vUv - vec2(-0.38, 0.42), vUv - vec2(-0.38, 0.42)) * 9.0);
    c = vCol.rgb * (0.72 + 0.5 * rim) + vec3(hl * 0.55);
    c = mix(c, vCol.rgb * 0.55, smoothstep(0.84, 0.97, r));
    a = inside * mix(0.5, 1.0, rim);
  } else if (vMode < 2.5) {
    vec2 q = abs(vUv);
    float e = max(q.x, q.y);
    float aa = max(fwidth(e), 1e-3);
    float inside = 1.0 - smoothstep(1.0 - aa, 1.0, e);
    float edge = smoothstep(0.62, 0.95, e);
    c = vCol.rgb * (0.8 + 0.4 * edge);
    a = inside * mix(0.4, 1.0, edge);
  } else {
    float r = length(vUv);
    float aa = max(fwidth(r), 1e-3);
    a = (1.0 - smoothstep(1.0 - aa, 1.0, r)) * smoothstep(0.8 - aa, 0.8, r);
  }
  if (vScan > 0.0) {
    float line = step(0.5, fract(gl_FragCoord.y / (3.0 * uPx)));
    a *= 1.0 - vScan * 0.38 * line;
    a *= mix(1.0, 0.94 + 0.06 * sin(uTime * 37.0 + gl_FragCoord.y * 0.07), uFlicker); // off in reduced motion
  }
  a *= vCol.a;
  if (a < 0.004) discard;
  gl_FragColor = vec4(c, a);
  #include <colorspace_fragment>
}`;

export interface GhostStyle { color: Color; label: Color; alpha: number; scan: number; tag: AtlasShape; outline: Color | null }

const cyan = col(PAL.ai), cyanSoft = col('#6FDAFF'), cyanDeep = col('#0B7FB0');
const gold = col(PAL.pb), goldDeep = col('#A06A00');
const STYLES: Record<GhostKind, GhostStyle> = {
  ai: { color: cyan, label: cyanDeep, alpha: 0.85, scan: 1, tag: 'hex', outline: null },
  calm: { color: cyan, label: cyanDeep, alpha: 0.75, scan: 1, tag: 'hex', outline: null },
  research_fast: { color: cyanSoft, label: cyanDeep, alpha: 0.7, scan: 1, tag: 'hex', outline: null },
  research_pump: { color: cyanSoft, label: cyanDeep, alpha: 0.7, scan: 1, tag: 'hex', outline: null },
  reverse_hint: { color: cyanSoft, label: cyanDeep, alpha: 0.7, scan: 1, tag: 'hex', outline: null },
  // §9.1 palette: PB #FFC23D at 40 %. The darker gold ring keeps it readable on the paper.
  pb: { color: gold, label: goldDeep, alpha: 0.4, scan: 0, tag: 'circle', outline: col('#C98A00') },
  daily_pb: { color: gold, label: goldDeep, alpha: 0.4, scan: 0, tag: 'circle', outline: col('#C98A00') },
  wr: { color: col(PAL.wr), label: col('#B0126A'), alpha: 0.72, scan: 0, tag: 'star', outline: null },
  rival: { color: col(PAL.rival), label: col('#B04F0A'), alpha: 0.75, scan: 0, tag: 'tri', outline: null },
  challenge: { color: col(PAL.challenge), label: col(PAL.ink), alpha: 0.88, scan: 0, tag: 'flag', outline: col(PAL.ink) },
};

export function ghostStyle(k: GhostKind): GhostStyle {
  return STYLES[k];
}

export function createGhostMaterial(map: Texture): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: VS, fragmentShader: FS,
    uniforms: { uMap: { value: map }, uHalo: { value: col('#FFFFFF') }, uTime: { value: 0 }, uPx: { value: 1 }, uFlicker: { value: 1 } },
    transparent: true, depthWrite: false, side: DoubleSide,
  });
}

interface TagSlot { idx: number; gx: number; x0: number; w: number; row: number; group: number; st: GhostStyle; label: string; want: number; off: number }

// Per-frame tag layout, pooled (no allocation while drawing).
const tagPool: TagSlot[] = [];
const tags: TagSlot[] = [];
// By trolley x; ties (every ghost on the start pose) keep the ghost order: AI first.
const byWant = (p: TagSlot, q: TagSlot): number => p.gx - q.gx || p.idx - q.idx;
// Row-1 clusters (tags packed side by side, centred on their trolleys): index range in `row1`, left edge, width.
const row1: TagSlot[] = [];
const clFirst: number[] = [], clX0: number[] = [], clW: number[] = [];
// Per ghost index: in row 1 last frame (hysteresis), the eased row, and the layout it had last frame
// (row, group size, drawn x). A layout change (row switch, groups merging) starts a decaying jump from
// where the tag was drawn, so tags glide instead of popping; continuous motion is never smoothed (no lag).
const wasRow1: boolean[] = [];
const rowPos: number[] = [];
const lastRow: number[] = [];
const lastGroup: number[] = [];
const lastX: number[] = [];
const jumpX: number[] = [];

/** Clearance between the player's trolley and a beam-face tag [m]: enter row 1 below PAD_IN, leave above PAD_OUT. */
const PAD_IN = 0.02, PAD_OUT = 0.06;
const TAG_GAP = 0.03;
/** Time constant of the row / offset easing [s]. */
const TAG_EASE = 0.05;

/** Tag layout (exported for tests): which row each ghost's tag takes and its left edge. */
export interface TagRect { label: string; x0: number; x1: number; y0: number; y1: number; row: number }
const rectPool: TagRect[] = [];
let rectN = 0;
export function lastTagRects(): TagRect[] {
  return rectPool.slice(0, rectN).map((r) => ({ ...r }));
}

/** Forgets the eased tag positions (level load / retry: tags jump to their places). */
export function resetGhostTags(): void {
  wasRow1.length = 0;
  rowPos.length = 0;
  lastRow.length = 0;
  lastGroup.length = 0;
  lastX.length = 0;
  jumpX.length = 0;
}

/**
 * Rebuilds the ghost batch for this frame. pxToM converts CSS px to metres at the ghost plane.
 * playerX: the player's trolley x — tags avoid the beam face right above it (the trolley's side plates
 * would hide them, and at the start pose every ghost sits there). dt: wall-clock step for the easing.
 */
export function drawGhosts(b: QuadBatch, ghosts: readonly GhostPose[], L: number, pxToM: number, time: number, fade: number,
  visX: readonly [number, number] | null = null, playerX = Number.NaN, dt = 0): void {
  b.begin();
  const z = Z_GHOST;
  const tagH = 17 * pxToM;
  tags.length = 0;
  // Draw back to front so the first ghost (usually AI) ends on top.
  for (let i = ghosts.length - 1; i >= 0; i--) {
    const g = ghosts[i] as GhostPose;
    if (!g.visible || !Number.isFinite(g.x + g.bx + g.by)) continue;
    const st = STYLES[g.kind] ?? STYLES.ai;
    const a = st.alpha * fade;
    // Trolley silhouette.
    b.rect(g.x - TROLLEY_HALF_W, HOOK_Y, g.x + TROLLEY_HALF_W, HOOK_Y + 0.05, z, st.color, Math.min(1, a * 1.15), M_EDGE, st.scan);
    // String (straight, or a gentle sag when slack).
    const w = 1.7 * pxToM;
    if (g.slack) {
      const mx = (g.x + g.bx) / 2, my = (HOOK_Y + g.by) / 2 - 0.08;
      let px = g.x, py = HOOK_Y;
      for (let k = 1; k <= 8; k++) {
        const t = k / 8, u = 1 - t;
        const qx = u * u * g.x + 2 * u * t * mx + t * t * g.bx, qy = u * u * HOOK_Y + 2 * u * t * my + t * t * g.by;
        b.line(px, py, qx, qy, z, w, st.color, a * 0.85, st.scan);
        px = qx; py = qy;
      }
    } else {
      b.line(g.x, HOOK_Y, g.bx, g.by, z, w, st.color, a * 0.85, st.scan);
    }
    // Ball.
    const r = 0.06;
    b.quad(g.bx - r, g.by - r, g.bx + r, g.by - r, g.bx + r, g.by + r, g.bx - r, g.by + r, z, -1, -1, 1, 1, st.color, a, M_SPHERE, st.scan);
    if (st.outline) {
      const ro = r + 0.8 * pxToM;
      b.quad(g.bx - ro, g.by - ro, g.bx + ro, g.by - ro, g.bx + ro, g.by + ro, g.bx - ro, g.by + ro, z + 0.0005, -1, -1, 1, 1, st.outline, 0.9 * fade, M_RING, 0);
    }
    const width = tagH * 1.25 + tagH * 0.95 * b.atlasLabelAspect(g.label);
    let t = tagPool[tags.length];
    if (!t) {
      t = { idx: 0, gx: 0, x0: 0, w: 0, row: 0, group: 0, st, label: '', want: 0, off: 0 };
      tagPool.push(t);
    }
    t.idx = i;
    t.gx = g.x;
    t.group = 0;
    t.x0 = t.want = g.x - width / 2;
    t.w = width;
    t.row = 0;
    t.off = 0;
    t.st = st;
    t.label = g.label;
    tags.push(t);
  }

  // Tags ride on the beam face above their trolley ([shape] label). A tag that would sit over the
  // player's trolley or on another tag goes to the row above the beam instead, where overlapping tags
  // are packed side by side and centred as a group over their trolleys (e.g. [AI][PB] at the start).
  const lo = visX ? visX[0] + 0.05 : -Infinity, hi = visX ? visX[1] - 0.05 : Infinity;
  const clampX = (x: number, w: number): number => Math.min(hi - w, Math.max(lo, x));
  tags.sort(byWant);
  const hasPlayer = Number.isFinite(playerX);
  let edge0 = -Infinity;
  row1.length = 0;
  for (const t of tags) {
    const pad = wasRow1[t.idx] ? PAD_OUT : PAD_IN;
    const x0 = clampX(t.want, t.w);
    const overPlayer = hasPlayer && x0 < playerX + TROLLEY_HALF_W + pad && x0 + t.w > playerX - TROLLEY_HALF_W - pad;
    if (overPlayer || x0 < edge0 + 0.02) {
      t.row = 1;
      row1.push(t);
    } else {
      t.x0 = x0;
      edge0 = x0 + t.w;
    }
  }
  // Row 1: greedy cluster merge (1-D label placement): each cluster sits at the mean of its members'
  // wanted positions, merging with the previous one while they overlap.
  let nc = 0;
  for (let k = 0; k < row1.length; k++) {
    const t = row1[k] as TagSlot;
    t.off = 0;
    clFirst[nc] = k;
    clX0[nc] = clampX(t.want, t.w);
    clW[nc] = t.w;
    nc++;
    while (nc >= 2 && (clX0[nc - 2] as number) + (clW[nc - 2] as number) + TAG_GAP > (clX0[nc - 1] as number)) {
      const a = nc - 2, c = nc - 1;
      const shift = (clW[a] as number) + TAG_GAP;
      for (let j = clFirst[c] as number; j <= k; j++) (row1[j] as TagSlot).off += shift;
      clW[a] = shift + (clW[c] as number);
      let sum = 0;
      for (let j = clFirst[a] as number; j <= k; j++) sum += (row1[j] as TagSlot).want - (row1[j] as TagSlot).off;
      clX0[a] = clampX(sum / (k - (clFirst[a] as number) + 1), clW[a] as number);
      nc--;
    }
  }
  for (let c = 0; c < nc; c++) {
    const end = c + 1 < nc ? (clFirst[c + 1] as number) : row1.length;
    for (let j = clFirst[c] as number; j < end; j++) {
      const t = row1[j] as TagSlot;
      t.x0 = (clX0[c] as number) + t.off;
      t.group = end - (clFirst[c] as number);
    }
  }

  rectN = 0;
  const k = dt > 0 ? 1 - Math.exp(-dt / TAG_EASE) : 1;
  for (const t of tags) {
    const i = t.idx;
    wasRow1[i] = t.row === 1;
    const prevRow = rowPos[i];
    const rp = prevRow === undefined ? t.row : prevRow + (t.row - prevRow) * k;
    rowPos[i] = rp;
    let j = jumpX[i] ?? 0;
    const px0 = lastX[i];
    if (px0 !== undefined && (lastRow[i] !== t.row || lastGroup[i] !== t.group)) {
      j = px0 - t.x0;
      if (Math.abs(j) > 1.5) j = 0; // a new run / far jump: no glide across the screen
    }
    j *= 1 - k;
    if (Math.abs(j) < 1e-4) j = 0;
    jumpX[i] = j;
    lastRow[i] = t.row;
    lastGroup[i] = t.group;
    const x0 = t.x0 + j;
    lastX[i] = x0;
    // Row 1 clears row 0 by at least 3 px whatever the scale (landscape phones are the tightest).
    const y0 = (BEAM_BOTTOM + BEAM_TOP) / 2, y1 = Math.max(BEAM_TOP + 0.012 + tagH * 0.55, y0 + tagH * 1.05 + 3 * pxToM);
    const ty = y0 + (y1 - y0) * rp;
    const tz = 0.1;
    b.icon(b.atlasShape(t.st.tag), x0 + tagH * 0.5, ty, tz, tagH * 1.05, t.st.color, Math.min(1, t.st.alpha * fade + 0.25), 0.9);
    b.label(t.label, x0 + tagH * 1.1, ty, tz, tagH * 0.95, t.st.label, fade, -1, 0.9);
    let rr = rectPool[rectN];
    if (!rr) {
      rr = { label: '', x0: 0, x1: 0, y0: 0, y1: 0, row: 0 };
      rectPool.push(rr);
    }
    rectN++;
    rr.label = t.label;
    rr.x0 = x0;
    rr.x1 = x0 + t.w;
    rr.y0 = ty - tagH * 0.525;
    rr.y1 = ty + tagH * 0.525;
    rr.row = t.row;
  }
  void time;
  void L;
  b.end();
}
