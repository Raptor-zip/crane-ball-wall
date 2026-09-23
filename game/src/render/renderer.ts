// Renderer contract (GAME_DESIGN.md §10.4 "描画"). Owner: O5.
//
// "Workbench diorama x lab notebook" (§9.1): warm paper board, brick walls, yellow gantry, glossy
// red ball, ink annotations. Draw calls (§9.7 budget 40): board, floor, mortar, bricks, debris,
// gantry, trolley, bumpers, ball, string, goal, blob shadows, AI path, back ink, margin ink,
// ghosts (all in one), trail + particles (one), world ink, top ink, the crash vignette (only while
// a crash is on screen) — plus a few shadow-pass calls on high quality. Measured max: 27.
// Numbers that O7 shows as DOM popups ("ギリ 7mm", "−4mm") are not drawn in-world (no duplicates).
// The back board carries a faint page heading above the beam's right end: the level id, or for daily
// levels core's levelLoaded.label (「今日の5球 #N」, another day's daily name), never the raw "d:16".
// Cosmetic skins (skins spec §5.4): setSkin() takes one resolved look (skinLooks.ts); the default look draws exactly
// today's frame. Skins change colours, material scalars and canvas pixels only: never sizes, the camera or the ghosts.
import {
  BackSide, Color, LatheGeometry, Mesh, MeshBasicMaterial, MeshPhysicalMaterial, PMREMGenerator, SphereGeometry, Vector2, Vector3,
  NoToneMapping, PCFShadowMap, SRGBColorSpace, WebGLRenderer,
} from 'three';
import type { Texture } from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { LevelDef, WallDef } from '../sim/level';
import type { PoseSnap, Status } from '../sim/run';
import type { GameEvent } from '../core/bus';
import type { RailMapper } from '../input/types';
import { createTextures } from './textures';
import type { Textures } from './textures';
import { PAL, Z_FLOOR_FRONT, Z_WALL_HALF, col, createBlobs, createGoal, createScene, createVignette } from './scene';
import type { Blobs, Goal, Stage, Vignette } from './scene';
import { FOLLOW_LEAD_MAX, FOLLOW_TAU, createCamera, lookAheadFocus, tallWindowFor } from './camera';
import type { CameraRig } from './camera';
import { createCrane, HOOK_Y, TROLLEY_HALF_W, BEAM_TOP } from './crane';
import type { Crane } from './crane';
import { createBricks } from './bricks';
import type { Bricks } from './bricks';
import { createString } from './string';
import type { StringLine } from './string';
import { createGhostMaterial, drawGhosts, lastTagRects, resetGhostTags } from './ghosts';
import { QuadBatch, createInkMaterial, drawBackInk, drawMarginInk } from './overlays';
import { Particles, PointsBatch, S_DISC, S_EMBER, S_RECT, S_RING } from './particles';
import { Trail } from './trail';
import { DEFAULT_LOOK, SKIN_PARTS, ballTrailColour, confettiPalette, craneAccent, patternAt } from './skinLooks';
import type { BallLook, SkinLook, SkinPart } from './skinLooks';
import { createDecals } from './decals';
import type { Decal, DecalStore } from './decals';
import { createShake } from './shake';
import type { Shake } from './shake';
import { createQualityGovernor } from './quality';
import type { QualityGovernor } from './quality';
import { createRailMapper } from './mapper';

export interface Rect { x: number; y: number; w: number; h: number }
export interface Layout {
  kind: 'wide' | 'tall'; w: number; h: number; dpr: number; scene: Rect; deck: Rect | null; hudTop: number;
  /** tall: the bench band at the bottom of the scene in CSS px (O7); the play area is [hudTop, scene bottom - bench]. */
  bench?: number;
}
export type GhostKind = 'ai' | 'calm' | 'research_fast' | 'research_pump' | 'reverse_hint' | 'pb' | 'wr' | 'rival' | 'challenge' | 'daily_pb';
export interface GhostPose { kind: GhostKind; label: string; x: number; bx: number; by: number; slack: boolean; visible: boolean }
export interface RenderFrame {
  alpha: number; prev: PoseSnap; cur: PoseSnap; L: number;
  ghosts: GhostPose[]; targetX: number | null; F: number; Fmax: number; saturated: boolean;
  near: { wall: number; gapMm: number; px: number; py: number } | null;
  holdFrac: number; ampDeg: number; reqDeg: number | null; nextWall: number | null;
  timeScale: number; status: Status; showAiLine: boolean; showMargin: boolean;
}
export interface Renderer {
  init(canvas: HTMLCanvasElement, opts: { quality: 'auto' | 'high' | 'low'; reducedMotion: boolean }): void;
  setLayout(l: Layout): void;
  loadLevel(level: LevelDef, aiPath: Float32Array | null /* bx,by pairs */, eggCargo: boolean): void;
  draw(f: RenderFrame, dtReal: number): void;
  fx(e: GameEvent): void;
  worldToScreen(x: number, y: number): { x: number; y: number };
  readonly mapper: RailMapper;
  resetFx(): void;   // on retry (red crosses stay)
  dispose(): void;
}

/**
 * Optional, non-contract setters for core (O3). Renderer.init takes the settings once; these let the
 * settings screen change them without re-creating the WebGL context. Call them duck-typed:
 * `(renderer as Partial<RendererExtras>).setOptions?.({ reducedMotion })`.
 */
export interface RendererExtras {
  /** Settings changed: quality ('auto' | 'high' | 'low') and/or reduced motion (§3.5). */
  setOptions(o: { quality?: 'auto' | 'high' | 'low'; reducedMotion?: boolean }): void;
  /** AI margin of the current level (ghosts_summary.json `aiMarginMm`, default 20) for the cyan lines (§8.4-4). */
  setAiMarginMm(mm: number): void;
  /**
   * Cosmetic skin (skins spec §5.4): one resolved look (src/core/skins.ts skinLook()). Before init it is kept and init
   * builds everything from it (textures painted once); after init only the parts whose id changed are applied, in
   * place (colours, uniforms, material scalars, canvas redraws: no new textures or materials). Call it outside a run
   * only (menus, title, results, READY). Physics, hitboxes, the camera and the ghosts never change.
   */
  setSkin(look: SkinLook): void;
}

/** Extra, non-contract hooks for dev pages and tests. */
export interface RendererDebug {
  stats(): {
    calls: number; triangles: number; points: number; lines: number; textures: number; geometries: number; particles: number;
    dpr: number; shadows: boolean; debris: number; vignette: number; snapFlash: number; shake: number; reduced: boolean;
  };
  /** Base (unshaken) camera px per metre at the ball plane. */
  pxPerM(): number;
  /** worldToScreen through the unshaken base camera. */
  worldToScreenBase(x: number, y: number): { x: number; y: number };
  /** When true, draw() advances everything but skips the GPU render (fast-forwarding demos). */
  skipRender: boolean;
  /** Renders the current state and reads back the sRGB colour at viewport CSS px (tests), or null. */
  probe(x: number, y: number): [number, number, number] | null;
  /** Ghost tags of the last frame as viewport CSS px rects (row 0 = beam face, 1 = above the beam). */
  ghostTags(): { label: string; x0: number; x1: number; y0: number; y1: number; row: number }[];
  /** Board heading text and the AI margin [mm] of the cyan lines. */
  labels(): { board: string; aiMarginMm: number };
  /** Ids of the skin looks in use (the pending look before init). */
  skin(): Record<SkinPart, string>;
  /**
   * Framing in viewport CSS px through the base camera at the current focus: the far top edge of the
   * beam, the floor's front edge, the lower edge of the bench band that is still on screen.
   */
  frame(): { beamTopY: number; floorY: number; sceneTop: number; sceneBottom: number; hudTop: number; windowW: number };
}

// Values mirrored from src/sim/constants.ts (render must not depend on sim internals beyond types).
const RAIL_Y = 1.25;
const BALL_R = 0.06;
const MODE_SLACK = 1;
const ST_READY = 0, ST_RUNNING = 1, ST_SUCCESS = 2, ST_CRASH = 3;
const CK_BALL = 1, CK_STRING = 2, CK_BEAM = 3, CK_FLOOR = 4, CK_EGG = 5;

interface DimNote { wall: number; gapMm: number; px: number; py: number; t: number; dir: number }
interface Pulse { x: number; y: number; t: number; r0: number; r1: number; life: number; c: Color }
interface CrashNote { kind: number; wall: number; x: number; y: number; t: number }

const C_INK = col(PAL.ink), C_GOAL = col(PAL.goal), C_DANGER = col(PAL.danger), C_AMBER = col(PAL.amber);
const C_WHITE = col('#FFFFFF'), C_AI = col(PAL.ai);
const C_TETHER_LO = col('#7C8699'), C_TETHER_HI = col('#E89A00');
const TIER_COLORS = [col('#1E2A44'), col('#E0A800'), col('#FF7A1A'), col(PAL.danger)];

const Y_UP = new Vector3(0, 1, 0);
/**
 * RoomEnvironment rotation for the ball's reflections: puts the key reflection above-left of the
 * centre (reads as a glossy sphere at 18-30 px) instead of a dead-centre "flash" spot.
 */
const ENV_ROT_X = -0.3, ENV_ROT_Y = -0.7;

/** AI wall margin of a level (D8: `ai.marginMm`, default 20 mm). */
function levelMarginMm(lv: LevelDef): number {
  const mm = (lv.ai as { marginMm?: unknown } | undefined)?.marginMm;
  return typeof mm === 'number' && Number.isFinite(mm) && mm > 0 ? mm : 20;
}

function uiLangEn(): boolean {
  try {
    return typeof document !== 'undefined' && document.documentElement.lang.toLowerCase().startsWith('en');
  } catch {
    return false;
  }
}

/**
 * Board heading (the notebook page title on the back board): the level id for campaign levels. Daily
 * levels never show their raw id ("d:16"): core's levelLoaded.label (「#N」 for today's daily, the daily's
 * name for another day's), else 「今日の5球」.
 */
export function boardLabelFor(lv: LevelDef, label: string | undefined, en = uiLangEn()): string {
  const given = typeof label === 'string' ? label.trim() : '';
  if (lv.world !== 0) return given || lv.id;
  const daily = en ? 'Daily 5' : '今日の5球';
  if (!given || given === lv.id || /^d:\d+$/.test(given)) return daily;
  return given.startsWith('#') ? `${daily} ${given}` : given;
}

function tierOf(gapMm: number): number {
  return gapMm < 2 ? 4 : gapMm < 5 ? 3 : gapMm < 10 ? 2 : gapMm < 20 ? 1 : 0;
}

function eggGeometry(): LatheGeometry {
  const pts: Vector2[] = [];
  const N = 24;
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * Math.PI;
    const y = -0.066 * Math.cos(t);
    const r = 0.056 * Math.sin(t) * (1 + 0.1 * Math.cos(t));
    pts.push(new Vector2(Math.max(r, 1e-4), y));
  }
  const g = new LatheGeometry(pts, 36);
  // Speckles as vertex colours.
  const pos = g.getAttribute('position');
  const cols = new Float32Array(pos.count * 3);
  const base = col(PAL.egg), spk = col(PAL.eggSpeckle), c = new Color();
  let s = 99;
  const rnd = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let i = 0; i < pos.count; i++) {
    c.copy(base);
    const r = rnd();
    if (r < 0.14) c.lerp(spk, 0.55 + rnd() * 0.45);
    else if (r < 0.3) c.lerp(spk, 0.2);
    cols[i * 3] = c.r; cols[i * 3 + 1] = c.g; cols[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new (pos.constructor as typeof import('three').Float32BufferAttribute)(cols, 3));
  return g;
}

/** Writes a patterned ball look into a sphere's colour attribute (linear colours, lerped like the egg's speckles). */
function paintBallPattern(geo: SphereGeometry, look: BallLook): void {
  const pos = geo.getAttribute('position');
  const colAttr = geo.getAttribute('color');
  const arr = colAttr.array as Float32Array;
  const base = col(look.body), c = new Color();
  const layers = (look.pattern ?? []).map((l) => col(l.color));
  for (let i = 0; i < pos.count; i++) {
    c.copy(base);
    const [li, t] = look.pattern ? patternAt(look.pattern, pos.getX(i), pos.getY(i), pos.getZ(i), BALL_R) : [-1, 0];
    if (li >= 0) c.lerp(layers[li] as Color, t);
    arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b;
  }
  colAttr.needsUpdate = true;
}

const isPatterned = (b: BallLook): boolean => !!b.pattern && b.pattern.length > 0;

/**
 * MeshPhysicalMaterial parameters of the plain ball for a ball look (today: #E0312B, .34 / 0 / 1 / .26 / .70).
 * Clearcoat stays > 0 for every look, so the shader program never changes (three switches programs at 0).
 */
export function ballMaterialParams(b: BallLook): {
  color: string; roughness: number; metalness: number; clearcoat: number; clearcoatRoughness: number; envMapIntensity: number;
  transparent: true; opacity: 1;
} {
  return {
    color: b.body, roughness: b.mat.roughness, metalness: b.mat.metalness, clearcoat: Math.max(0.02, b.mat.clearcoat),
    clearcoatRoughness: b.mat.clearcoatRoughness, envMapIntensity: b.mat.envMapIntensity, transparent: true, opacity: 1,
  };
}

/** Copies a look's material scalars (and, for the plain ball, its colour) into a ball material. */
function setBallMaterial(m: MeshPhysicalMaterial, b: BallLook, withColor: boolean): void {
  const p = ballMaterialParams(b);
  if (withColor) m.color.set(p.color);
  m.roughness = p.roughness;
  m.metalness = p.metalness;
  m.clearcoat = p.clearcoat;
  m.clearcoatRoughness = p.clearcoatRoughness;
  m.envMapIntensity = p.envMapIntensity;
}

/**
 * Crash beat (§9.5, 0.7 s CRASH_BEAT): t = 0 contact (red circle, O7's popup), 80 ms hit-stop, then
 * shake 1.0 + red vignette (rise, hold, gone by 0.68 s), and the red cross stamps on the wall at 0.3 s.
 */
const CRASH_HITSTOP = 0.08;
const CRASH_STAMP = 0.3;
/** Vignette envelope; t is measured from the end of the hit-stop. */
function vignetteAt(t: number, reduced: boolean): number {
  if (t < 0) return 0;
  const rise = reduced ? 0.2 : 0.06; // reduced motion: no flash-like snap in
  if (t < rise) return t / rise;
  if (t < 0.25) return 1;
  return Math.max(0, 1 - (t - 0.25) / 0.35);
}

export function createRenderer(): Renderer & RendererDebug & RendererExtras {
  let gl: WebGLRenderer | null = null;
  let tex: Textures | null = null;
  let stage: Stage | null = null;
  let rig: CameraRig | null = null;
  let env: Texture | null = null;
  let crane: Crane | null = null;
  let bricks: Bricks | null = null;
  let goal: Goal | null = null;
  let blobs: Blobs | null = null;
  let str: StringLine | null = null;
  let ball: Mesh | null = null;
  let egg: Mesh | null = null;
  let ballLine: Mesh | null = null;
  let eggLine: Mesh | null = null;
  /** Patterned balls (skins): a second, vertex-coloured sphere, hidden unless such a ball is equipped (§5.4). */
  let patBall: Mesh | null = null;
  let patLine: Mesh | null = null;
  /** The skin look: pending before init, then the applied one (`applied` = ids built into the scene). */
  let look: SkinLook = DEFAULT_LOOK;
  let applied: Record<SkinPart, string> | null = null;
  let patterned = false;
  const strC = col(PAL.string), strEdge = col(PAL.string);
  let confettiPal: readonly string[] = confettiPalette(DEFAULT_LOOK);
  let confettiShape = S_RECT;
  let dustTint: string = PAL.mortar, sparkTint: string = PAL.brick2, floorDustTint: string = PAL.floor;
  let ghostBatch: QuadBatch | null = null;
  let inkWorld: QuadBatch | null = null;
  let inkTop: QuadBatch | null = null;
  let backInk: QuadBatch | null = null;
  let marginInk: QuadBatch | null = null;
  let vignette: Vignette | null = null;
  let vigT = -1;
  /** Crash beat clock (wall clock since the crash event, -1 when idle) and its pending steps. */
  let crashT = -1;
  let crashShakePending = false;
  let pendingDecal: { level: string; d: Decal } | null = null;
  let vigLevel = 0;
  let aiMarginMm = 20;
  /** Board heading text and the last label core gave per level id (levelLoaded.label). */
  let boardLabel = '';
  const boardLabels = new Map<string, string>();
  let pts: PointsBatch | null = null;
  let aiPts: PointsBatch | null = null;
  const particles = new Particles();
  const trail = new Trail();
  const decals: DecalStore = createDecals();
  let shake: Shake = createShake(false);
  let quality: QualityGovernor = createQualityGovernor('auto');
  let reduced = false;
  let shadowsOn = false;
  let dprApplied = 0;

  let layout: Layout | null = null;
  let level: LevelDef | null = null;
  let isEgg = false;
  let aiPathData: Float32Array | null = null;
  let time = 0;
  /**
   * Shader warm-up: the first draw starts compiling every program of the scene in parallel
   * (WebGLRenderer.compileAsync, KHR_parallel_shader_compile) and skips gl.render until they are ready or
   * WARM_MAX_S of drawing passed. Without it the first gl.render blocks the main thread for the whole compile
   * (~0.1 s on a desktop GPU, ~0.9 s on SwiftShader, more on a slow phone), which also holds back the first paint of
   * the DOM title / HUD. The canvas shows the paper clear colour meanwhile (one frame, then the compile).
   */
  let warm: 'no' | 'pending' | 'done' = 'no';
  let warmT = 0;
  let warmFrames = 0;
  let lastStatus = -1;
  let activePhase = 0;
  let snapFlash = 0;
  let goalFlash = 0;
  let targetPulse = -1;
  let holdWobble = 0;
  let crash: CrashNote | null = null;
  const dims: DimNote[] = [];
  const pulses: Pulse[] = [];
  let lastX = 0, lastBx = 0, lastBy = 0;
  let camSnap = true;
  let ballAlive = true;
  let trailFade = 1;

  const v3 = new Vector3();
  const cTmp = new Color(), cTmp2 = new Color();

  const scene = (): Stage => {
    if (!stage) throw new Error('renderer not initialised');
    return stage;
  };

  // ---- skins (§5.4) ------------------------------------------------------------------------------

  const cargoVisibility = (): void => {
    if (ball) ball.visible = !isEgg && !patterned;
    if (patBall) patBall.visible = !isEgg && patterned;
    if (egg) egg.visible = isEgg;
  };

  const applyBall = (b: BallLook): void => {
    patterned = isPatterned(b);
    if (patterned && patBall && patLine) {
      paintBallPattern(patBall.geometry as SphereGeometry, b);
      setBallMaterial(patBall.material as MeshPhysicalMaterial, b, false);
      (patLine.material as MeshBasicMaterial).color.set(b.outline);
    } else if (!patterned && ball && ballLine) {
      setBallMaterial(ball.material as MeshPhysicalMaterial, b, true);
      (ballLine.material as MeshBasicMaterial).color.set(b.outline);
    }
    cargoVisibility();
  };

  /** Ribbon / strobe colours ('ball' follows the ball; the egg level uses today's red) and the string colours. */
  const applyTrail = (): void => {
    const t = look.trail;
    const ballC = ballTrailColour(look.ball, isEgg);
    trail.setLook({
      ribbon: cTmp.set(t.ribbon.color === 'ball' ? ballC : t.ribbon.color),
      width: t.ribbon.width,
      strobe: cTmp2.set(t.strobe.color === 'ball' ? ballC : t.strobe.color),
      shape: t.strobe.shape === 'disc' ? S_DISC : S_RING,
    });
    strC.set(t.string);
    strEdge.set(t.stringEdge);
    confettiShape = t.confetti.shape === 'disc' ? S_DISC : t.confetti.shape === 'spark' ? S_EMBER : S_RECT;
    confettiPal = confettiPalette(look);
  };

  /** Board skin, the parts init builds from the look itself: canvases, board / floor, clear colour, bricks, blobs. */
  const repaintStage = (): void => {
    const st = look.stage;
    tex?.restyle(st);
    stage?.setLook(st);
    gl?.setClearColor(col(st.paper1), 1);
    if (bricks && level && bricks.rowH !== st.rowH) {
      stage?.scene.remove(bricks.group);
      bricks.dispose();
      bricks = createBricks(level.physics.walls, (tex as Textures).brick, st);
      stage?.scene.add(bricks.group);
    } else {
      bricks?.recolor(st);
    }
    blobs?.setColor(st.blob);
  };

  /** Board skin, the rest: the ink halos (paper-1, like today) and the crash dust / spark tints. */
  const applyStage = (): void => {
    const st = look.stage;
    for (const q of [inkWorld, inkTop, backInk, marginInk]) {
      const u = (q?.mesh.material as import('three').ShaderMaterial | undefined)?.uniforms.uHalo as { value: Color } | undefined;
      u?.value.set(st.paper1);
    }
    dustTint = st.dust ?? st.mortar;
    sparkTint = st.spark ?? st.brick2;
    floorDustTint = st.floorDust ?? st.floor;
  };

  /** Applies the parts of `look` whose ids differ from what the scene shows (all of them on the first call). */
  const applySkin = (): void => {
    const prev = applied;
    const changed = (p: SkinPart): boolean => !prev || prev[p] !== look[p].id;
    const ballC = changed('ball'), craneC = changed('crane'), trailC = changed('trail'), stageC = changed('stage');
    if (ballC) applyBall(look.ball);
    if (ballC || craneC) {
      crane?.setLook(look.crane, craneAccent(look.crane, look.ball));
      if (craneC && prev) tex?.setHazard(look.crane.hazard[0], look.crane.hazard[1]);
    }
    if (stageC) {
      if (prev) repaintStage();
      applyStage();
    }
    if (ballC || trailC || stageC || craneC) applyTrail();
    applied = { ball: look.ball.id, crane: look.crane.id, trail: look.trail.id, stage: look.stage.id };
  };

  const applyQuality = (): void => {
    if (!gl || !layout || !stage) return;
    const q = quality.state;
    if (q.dpr !== dprApplied) {
      dprApplied = q.dpr;
      gl.setPixelRatio(q.dpr);
      gl.setSize(layout.scene.w, layout.scene.h, true);
      if (pts) pts.pixelRatio = q.dpr;
      if (aiPts) aiPts.pixelRatio = q.dpr;
    }
    if (q.shadows !== shadowsOn) {
      shadowsOn = q.shadows;
      gl.shadowMap.enabled = shadowsOn;
      stage.setShadows(shadowsOn);
      stage.scene.traverse((o) => {
        const m = (o as Mesh).material;
        if (Array.isArray(m)) m.forEach((x) => (x.needsUpdate = true));
        else if (m) m.needsUpdate = true;
      });
    }
    if (blobs) blobs.mesh.visible = !shadowsOn;
  };

  const rebuildStaticInk = (): void => {
    if (!level || !rig || !backInk || !marginInk) return;
    const r = rig;
    const xr = xRange(level);
    // Ruler numbers sit at y ~ -0.12 on the floor's front face.
    const rulerLabelX = r.kind === 'wide' ? r.visibleXAt(-0.12, Z_FLOOR_FRONT) : null;
    drawBackInk(backInk, {
      level, projY: (h, z) => r.projectY(h, z), xView: xr, rulerLabelX, pxPerM: r.pxPerM(),
      heading: boardLabel ? { text: boardLabel, xRight: level.physics.rail[1] + 0.12, maxPx: r.kind === 'tall' ? 17 : undefined } : null,
    });
    drawMarginInk(marginInk, level.physics.walls, aiMarginMm, r.pxPerM());
  };

  const xRange = (l: LevelDef): [number, number] =>
    l.view?.wideX ? [l.view.wideX[0], l.view.wideX[1]] : [l.physics.rail[0] - 0.3, l.physics.rail[1] + 0.3];

  const rebuildAiPath = (): void => {
    if (!aiPts) return;
    aiPts.begin();
    const p = aiPathData;
    if (p && p.length >= 4) {
      const step = 0.032;
      let acc = step;
      let px = p[0] as number, py = p[1] as number;
      for (let i = 2; i + 1 < p.length; i += 2) {
        const x = p[i] as number, y = p[i + 1] as number;
        let seg = Math.hypot(x - px, y - py);
        let sx = px, sy = py;
        while (acc <= seg && seg > 0) {
          const t = acc / seg;
          const qx = sx + (x - sx) * t, qy = sy + (y - sy) * t;
          aiPts.add(qx, qy, 0.0, 2.7, C_AI, 0.6, S_DISC);
          sx = qx; sy = qy;
          seg -= acc;
          acc = step;
        }
        acc -= seg;
        px = x; py = y;
      }
    }
    aiPts.end();
  };

  const resetFx = (): void => {
    particles.clear();
    trail.reset();
    bricks?.reset();
    crane?.reset();
    dims.length = 0;
    pulses.length = 0;
    resetGhostTags();
    crash = null;
    snapFlash = 0;
    goalFlash = 0;
    targetPulse = -1;
    holdWobble = 0;
    shake.reset();
    activePhase = 0;
    ballAlive = true;
    camSnap = true;
    vigT = -1;
    vigLevel = 0;
    vignette?.set(0);
    // A retry inside the crash beat still leaves its cross on the wall (§9.5: kept for the session).
    if (pendingDecal) decals.add(pendingDecal.level, pendingDecal.d);
    pendingDecal = null;
    crashT = -1;
    crashShakePending = false;
  };

  const pulse = (x: number, y: number, r0: number, r1: number, life: number, c: Color): void => {
    if (pulses.length > 12) pulses.shift();
    pulses.push({ x, y, t: 0, r0, r1, life, c });
  };

  const worldToScreen = (x: number, y: number): { x: number; y: number } => {
    if (!rig || !layout) return { x: 0, y: 0 };
    v3.set(x, y, 0).project(rig.view);
    return { x: layout.scene.x + (v3.x + 1) * 0.5 * layout.scene.w, y: layout.scene.y + (1 - v3.y) * 0.5 * layout.scene.h };
  };

  const mapper = createRailMapper(() => (rig ? rig.base : null), () => (layout ? layout.scene : null));

  // ---- per-frame ink ----------------------------------------------------------------------

  const drawWorldInk = (f: RenderFrame, x: number, bx: number, by: number, L: number, px: number): void => {
    const b = inkWorld;
    if (!b || !level) return;
    b.begin();
    const walls = level.physics.walls;
    // Plumb line under the target ring.
    if (f.targetX !== null && f.status !== ST_CRASH) {
      b.dashed(f.targetX, HOOK_Y - 0.03, f.targetX, 0.0, 0.0, 1.2 * px, 0.03, 0.03, C_INK, 0.22);
    }
    // Goal silhouette (READY): a dashed ball hanging where the run should end.
    if (f.status === ST_READY) {
      const xg = level.ai.xGoal[Math.min(activePhase, level.ai.xGoal.length - 1)];
      if (xg !== undefined) {
        const yb = RAIL_Y - L;
        const pulseA = 0.45 + 0.15 * Math.sin(time * 3);
        b.dashed(xg, RAIL_Y, xg, yb + BALL_R, 0.0, 1.3 * px, 0.025, 0.02, C_INK, 0.28);
        const segs = 20;
        for (let i = 0; i < segs; i += 2) {
          b.arc(xg, yb, 0.0, BALL_R, 1.6 * px, (i / segs) * Math.PI * 2, ((i + 1) / segs) * Math.PI * 2, C_GOAL, pulseA, 4);
        }
      }
    }
    // Next wall: highlight its top edge (green once the swing is big enough).
    if (f.nextWall !== null && f.status === ST_RUNNING) {
      const w = walls[f.nextWall];
      if (w) {
        const ok = f.reqDeg !== null && f.ampDeg >= f.reqDeg;
        const c = ok ? C_GOAL : C_INK;
        b.line(w.x0, w.h, w.x1, w.h, Z_WALL_HALF + 0.003, 2.4 * px, c, ok ? 0.9 : 0.45);
        b.line(w.x0, w.h, w.x0, w.h - 0.05, Z_WALL_HALF + 0.003, 2.4 * px, c, ok ? 0.9 : 0.45);
        b.line(w.x1, w.h, w.x1, w.h - 0.05, Z_WALL_HALF + 0.003, 2.4 * px, c, ok ? 0.9 : 0.45);
      }
    }
    // Status lamp on the trolley front: green idle, amber working, blinking red when saturated.
    {
      const load = f.Fmax > 0 ? Math.min(1, Math.abs(f.F) / f.Fmax) : 0;
      const lampC = f.saturated ? C_DANGER : load > 0.08 ? C_AMBER : C_GOAL;
      const on = !f.saturated || Math.sin(time * 28) > -0.2;
      const lx = x + TROLLEY_HALF_W - 0.03, ly = 1.284;
      b.disc(lx, ly, 0.104, Math.max(0.0075, 2.6 * px), C_INK, 0.9);
      if (on) b.disc(lx, ly, 0.105, Math.max(0.006, 2.0 * px), lampC, 1);
    }
    // Motion streak behind the ball (fades once the run is over).
    trailFade = f.status === ST_RUNNING ? 1 : Math.max(0, trailFade - 1 / 18);
    if (trailFade > 0) trail.ribbon(b, 2 * BALL_R * 0.8, bx, by, trailFade);
    // Red crosses (last 5 of this level).
    const ds = decals.list(level.id);
    const age = decals.newestAge(level.id);
    const xr = b.atlasShape('x');
    for (let i = 0; i < ds.length; i++) {
      const d = ds[i] as Decal;
      const newest = i === ds.length - 1;
      const pop = newest && age < 0.14 && !reduced ? 1 + 0.6 * (1 - age / 0.14) : 1;
      const size = Math.max(d.size, 16 * px) * pop;
      b.icon(xr, d.x, d.y, d.z, size, C_DANGER, newest ? 0.95 : 0.7, 0.35, d.rot);
    }
    b.end();
  };

  const drawTopInk = (f: RenderFrame, x: number, bx: number, by: number, px: number, dt: number): void => {
    const b = inkTop;
    if (!b || !level || !rig || !layout) return;
    b.begin();
    const z = 0.14;
    // Target ring + tether (load spring, §3.4).
    if (f.targetX !== null && f.status !== ST_CRASH) {
      const tx = f.targetX;
      const load = f.Fmax > 0 ? Math.min(1, Math.abs(f.F) / f.Fmax) : 0;
      const sat = f.saturated;
      const r = Math.max(0.02, 7 * px);
      let rr = r;
      if (targetPulse >= 0) {
        const k = targetPulse / 0.35;
        rr = r * (1 + 0.8 * Math.sin(Math.min(1, k) * Math.PI));
      }
      b.arc(tx, HOOK_Y, z, rr, 2.2 * px, 0, Math.PI * 2, C_INK, 0.9, 28);
      b.line(tx, HOOK_Y + r + 2 * px, tx, HOOK_Y + r + 9 * px, z, 2 * px, C_INK, 0.9);
      b.line(tx, HOOK_Y - r - 2 * px, tx, HOOK_Y - r - 9 * px, z, 2 * px, C_INK, 0.9);
      b.disc(tx, HOOK_Y, z, 1.8 * px, C_INK, 0.9);
      const dx = tx - x;
      if (Math.abs(dx) > r * 1.2) {
        const x0 = x + Math.sign(dx) * 0.01, x1 = tx - Math.sign(dx) * r;
        const len = Math.abs(x1 - x0);
        const zigs = Math.max(4, Math.round(len / 0.03));
        const amp0 = Math.max(0.01, 4 * px);
        const wob = sat ? 1 + 0.45 * Math.sin(time * 34) : 1;
        const c = sat ? C_DANGER : cTmp.copy(C_TETHER_LO).lerp(C_TETHER_HI, load);
        const a = sat ? 1 : 0.35 + 0.6 * load;
        const w = (1.3 + 1.4 * load + (sat ? 0.8 : 0)) * px;
        let ppx = x0, ppy = HOOK_Y;
        for (let i = 1; i <= zigs * 2; i++) {
          const t = i / (zigs * 2);
          const qx = x0 + (x1 - x0) * t;
          const qy = HOOK_Y + (i === zigs * 2 ? 0 : (i % 2 ? 1 : -1) * amp0 * wob);
          b.line(ppx, ppy, qx, qy, z, w, c, a);
          ppx = qx; ppy = qy;
        }
      }
    }
    // Pulses (apex pivot pulse, target pulse, snaps).
    for (let i = pulses.length - 1; i >= 0; i--) {
      const p = pulses[i] as Pulse;
      p.t += dt;
      if (p.t >= p.life) {
        pulses.splice(i, 1);
        continue;
      }
      const k = p.t / p.life;
      const e = 1 - (1 - k) * (1 - k);
      b.arc(p.x, p.y, z, p.r0 + (p.r1 - p.r0) * e, 2 * px, 0, Math.PI * 2, p.c, 0.85 * (1 - k), 28);
    }
    // Near-wall leader (gap < 25 cm): ink dashes from the nearest wall point to the ball surface.
    if (f.near && f.status === ST_RUNNING && f.near.gapMm < 250 && f.near.gapMm > 0) {
      const n = f.near;
      let ux = bx - n.px, uy = by - n.py;
      const d = Math.hypot(ux, uy) || 1;
      ux /= d; uy /= d;
      const sx = bx - ux * BALL_R, sy = by - uy * BALL_R;
      const k = 1 - n.gapMm / 250;
      const danger = n.gapMm < 20;
      const c = danger ? C_DANGER : C_INK;
      if (Math.hypot(sx - n.px, sy - n.py) > 4 * px) b.dashed(n.px, n.py, sx, sy, z, 1.3 * px, 4 * px, 3 * px, c, 0.25 + 0.5 * k);
      b.disc(n.px, n.py, z, 2.2 * px, c, 0.35 + 0.5 * k);
    }
    // Near-miss dimension lines (§9.5): extension lines and outside arrows in the tier colour. The
    // "ギリ 7mm" + tier word is O7's DOM popup at the same spot (worldToScreen(px, py)).
    for (let i = dims.length - 1; i >= 0; i--) {
      const d = dims[i] as DimNote;
      d.t += dt;
      if (d.t > 1.9) {
        dims.splice(i, 1);
        continue;
      }
      drawDimension(b, d, level.physics.walls, px);
    }
    // Crash marker: red circle at the contact (§9.5). The "−4 mm" + cause text is O7's DOM popup.
    if (crash) {
      crash.t += dt;
      const k = Math.min(1, crash.t / 0.12);
      const pop = reduced ? 1 : 1 + 0.7 * (1 - k) * (1 - k);
      const r = Math.max(0.07, 16 * px) * pop;
      b.arc(crash.x, crash.y, z + 0.01, r, 3.2 * px, 0, Math.PI * 2, C_DANGER, 0.95, 40);
      b.disc(crash.x, crash.y, z + 0.01, 2.6 * px, C_DANGER, 0.95);
    }
    const vis = rig.visibleX();
    // Off-screen ball: arrow at the screen edge at the ball's height + distance (§9.2).
    if (ballAlive && f.status !== ST_READY) {
      v3.set(bx, by, 0).project(rig.view);
      if (Math.abs(v3.x) > 1.0) {
        const side = Math.sign(v3.x);
        const edgeX = side > 0 ? vis[1] : vis[0];
        const ax = edgeX - side * Math.max(0.05, 14 * px);
        const ay = Math.min(1.45, Math.max(0.1, by));
        const h = Math.max(0.05, 16 * px);
        b.icon(b.atlasShape('arrow'), ax, ay, z + 0.02, h, C_DANGER, 0.95, 0.9, side > 0 ? 0 : Math.PI);
        const dist = Math.abs(bx - edgeX);
        if (dist >= 0.05) b.text(`${dist.toFixed(1)} m`, ax - side * h * 0.7, ay, z + 0.02, h * 0.8, C_DANGER, 1, side > 0 ? 1 : -1, 1);
      }
    }
    // Tall follow view: when the active goal zone is out of the window, a green arrow at the edge
    // (floor level) says which way it is — the phone player cannot see the pad from the start.
    if (f.status === ST_READY || f.status === ST_RUNNING) {
      const zn = level.physics.phases[Math.min(activePhase, level.physics.phases.length - 1)];
      if (zn && (zn.xa > vis[1] || zn.xb < vis[0])) {
        const side = zn.xa > vis[1] ? 1 : -1;
        const h = Math.max(0.05, 15 * px);
        const ax = (side > 0 ? vis[1] : vis[0]) - side * Math.max(0.05, 13 * px);
        const bob = reduced ? 0 : Math.sin(time * 5) * 2.5 * px * side;
        b.icon(b.atlasShape('arrow'), ax + bob, 0.16, z + 0.02, h, C_GOAL, 0.95, 0.9, side > 0 ? 0 : Math.PI);
      }
    }
    b.end();
  };

  const drawDimension = (b: QuadBatch, d: DimNote, walls: readonly WallDef[], px: number): void => {
    const w = walls[d.wall];
    if (!w) return;
    // Anchor: nearest point of the slab boundary to (px, py).
    const ax = Math.min(w.x1, Math.max(w.x0, d.px));
    const onTop = d.py >= w.h - 1e-4;
    const ay = onTop ? w.h : Math.min(w.h, Math.max(0, d.py));
    const gap = d.gapMm / 1000;
    const tier = tierOf(d.gapMm);
    const tc = tier === 4 ? cTmp2.setHSL((time * 0.8) % 1, 0.85, 0.5) : (TIER_COLORS[tier] as Color);
    const grow = Math.min(1, d.t / 0.16);
    const fade = d.t < 1.4 ? 1 : Math.max(0, 1 - (d.t - 1.4) / 0.5);
    const lw = 1.4 * px;
    const zz = Z_WALL_HALF + 0.02;
    if (onTop) {
      // Horizontal extension lines at the wall top and at the ball bottom, out to the side the
      // ball came from (usually open space).
      const side = d.dir > 0 ? -1 : 1;
      const ext = 0.2 * grow;
      const ex = (side < 0 ? w.x0 : w.x1) + side * ext;
      const y0 = ay, y1 = ay + gap;
      b.line(ax, y0, ex, y0, zz, lw, C_INK, 0.9 * fade);
      b.line(ax, y1, ex, y1, zz, lw, C_INK, 0.9 * fade);
      const dx = (side < 0 ? w.x0 : w.x1) + side * 0.15;
      if (grow >= 1) {
        const al = Math.max(0.035, 10 * px);
        // Outside arrows pointing at each other (the gap is tiny).
        b.line(dx, y1 + al, dx, y1, zz, lw, tc, fade);
        b.line(dx, y0 - al, dx, y0, zz, lw, tc, fade);
        const ah = Math.max(0.012, 4 * px);
        b.line(dx - ah * 0.7, y1 + ah, dx, y1, zz, lw, tc, fade);
        b.line(dx + ah * 0.7, y1 + ah, dx, y1, zz, lw, tc, fade);
        b.line(dx - ah * 0.7, y0 - ah, dx, y0, zz, lw, tc, fade);
        b.line(dx + ah * 0.7, y0 - ah, dx, y0, zz, lw, tc, fade);
      }
    } else {
      // Side contact: vertical extension lines, arrows along x.
      const side = d.px < (w.x0 + w.x1) / 2 ? -1 : 1;
      const x0 = side < 0 ? w.x0 : w.x1, x1 = x0 + side * gap;
      const ext = 0.16 * grow;
      b.line(x0, ay, x0, ay + ext, zz, lw, C_INK, 0.9 * fade);
      b.line(x1, ay, x1, ay + ext, zz, lw, C_INK, 0.9 * fade);
      if (grow >= 1) {
        const yy = ay + 0.12, al = Math.max(0.035, 10 * px);
        b.line(x1 + side * al, yy, x1, yy, zz, lw, tc, fade);
        b.line(x0 - side * al, yy, x0, yy, zz, lw, tc, fade);
      }
    }
  };

  // ---- Renderer --------------------------------------------------------------------------

  let canvasEl: HTMLCanvasElement | null = null;
  let onContextLost: ((ev: Event) => void) | null = null;
  let onFontsLoaded: (() => void) | null = null;
  const fontSet = (): FontFaceSet | null => {
    try {
      return typeof document !== 'undefined' ? document.fonts ?? null : null;
    } catch {
      return null;
    }
  };

  const WARM_MAX_S = 3;
  function warmedUp(r: WebGLRenderer, sc: Stage['scene'], cam: CameraRig['view'], dt: number): boolean {
    if (warm === 'done') return true;
    if (warm === 'no') {
      // Start on the second draw: the browser paints the DOM once before the (partly synchronous) compile.
      warmFrames++;
      if (warmFrames < 2) return false;
      // Without the extension compileAsync only compiles synchronously (and three warns): draw as before.
      let parallel = false;
      try {
        parallel = r.extensions.has('KHR_parallel_shader_compile');
      } catch {
        parallel = false;
      }
      if (!parallel) {
        warm = 'done';
        return true;
      }
      warm = 'pending';
      warmT = 0;
      try {
        r.compileAsync(sc, cam).then(() => { warm = 'done'; }, () => { warm = 'done'; });
      } catch {
        warm = 'done';
        return true;
      }
    }
    warmT += dt;
    if (warmT > WARM_MAX_S) warm = 'done';
    return warm === 'done';
  }

  const api: Renderer & RendererDebug & RendererExtras = {
    init(canvas, opts) {
      reduced = opts.reducedMotion;
      shake = createShake(reduced);
      const r = new WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance', stencil: false });
      // Shader info logs force a synchronous compile + link query per program; production builds skip them.
      r.debug.checkShaderErrors = import.meta.env.DEV;
      r.outputColorSpace = SRGBColorSpace;
      r.toneMapping = NoToneMapping;
      r.shadowMap.type = PCFShadowMap;
      r.shadowMap.enabled = false;
      gl = r;
      r.setClearColor(col(look.stage.paper1), 1);
      r.clear();
      // Allow the browser to restore the context; three.js re-uploads everything on restore.
      onContextLost = (ev: Event): void => ev.preventDefault();
      canvasEl = canvas;
      canvas.addEventListener('webglcontextlost', onContextLost);
      quality = createQualityGovernor(opts.quality, undefined, typeof devicePixelRatio === 'number' ? devicePixelRatio : 1);
      tex = createTextures({ stage: look.stage, crane: look.crane });
      // Labels and the board heading are drawn into the atlas once: when the rounded web font arrives later
      // (Google Fonts, display=swap), draw them again instead of keeping the fallback font.
      onFontsLoaded = (): void => {
        tex?.atlas.invalidateText();
        rebuildStaticInk();
      };
      const fonts = fontSet();
      if (fonts) {
        fonts.addEventListener('loadingdone', onFontsLoaded);
        void fonts.ready.then(() => onFontsLoaded?.(), () => undefined);
      }
      stage = createScene(tex, look.stage);
      const pm = new PMREMGenerator(r);
      const room = new RoomEnvironment();
      env = pm.fromScene(room, 0.04).texture;
      room.dispose();
      pm.dispose();
      rig = createCamera();

      crane = createCrane(tex.hazard, env, look.crane, craneAccent(look.crane, look.ball));
      stage.scene.add(crane.group);
      goal = createGoal();
      stage.scene.add(goal.mesh);
      blobs = createBlobs(tex.soft, look.stage.blob);
      stage.scene.add(blobs.mesh);

      // The plain ball (today's mesh, material and program). A patterned look leaves it hidden with the default values.
      const plain = isPatterned(look.ball) ? DEFAULT_LOOK.ball : look.ball;
      const bp = ballMaterialParams(plain);
      const ballMat = new MeshPhysicalMaterial({ ...bp, color: col(bp.color), envMap: env });
      ballMat.envMapRotation.set(ENV_ROT_X, ENV_ROT_Y, 0);
      ball = new Mesh(new SphereGeometry(BALL_R, 48, 32), ballMat);
      ball.castShadow = true;
      ball.renderOrder = 8;
      stage.scene.add(ball);
      // Ink outline (inverted hull): keeps the cargo legible on the pale paper.
      ballLine = new Mesh(ball.geometry, new MeshBasicMaterial({ color: col(plain.outline), side: BackSide, transparent: true, opacity: 1 }));
      ballLine.renderOrder = 7.9;
      ball.add(ballLine);
      const eggMat = new MeshPhysicalMaterial({
        vertexColors: true, roughness: 0.6, clearcoat: 0.25, clearcoatRoughness: 0.4, envMap: env, envMapIntensity: 0.6,
        transparent: true, opacity: 1,
      });
      egg = new Mesh(eggGeometry(), eggMat);
      egg.castShadow = true;
      egg.renderOrder = 8;
      egg.visible = false;
      stage.scene.add(egg);
      eggLine = new Mesh(egg.geometry, new MeshBasicMaterial({ color: col('#6B5536'), side: BackSide, transparent: true, opacity: 1 }));
      eggLine.renderOrder = 7.9;
      egg.add(eggLine);
      // Patterned ball skins: same sphere as the ball, vertex colours, the egg material's program flags (§5.4 D4).
      const patGeo = new SphereGeometry(BALL_R, 48, 32);
      patGeo.setAttribute('color', new (patGeo.getAttribute('position').constructor as typeof import('three').Float32BufferAttribute)(
        new Float32Array(patGeo.getAttribute('position').count * 3), 3));
      const patMat = new MeshPhysicalMaterial({
        vertexColors: true, roughness: 0.6, clearcoat: 0.25, clearcoatRoughness: 0.4, envMap: env, envMapIntensity: 0.6,
        transparent: true, opacity: 1,
      });
      patMat.envMapRotation.set(ENV_ROT_X, ENV_ROT_Y, 0);
      patBall = new Mesh(patGeo, patMat);
      patBall.castShadow = true;
      patBall.renderOrder = 8;
      patBall.visible = false;
      stage.scene.add(patBall);
      patLine = new Mesh(patGeo, new MeshBasicMaterial({ color: col('#000000'), side: BackSide, transparent: true, opacity: 1 }));
      patLine.renderOrder = 7.9;
      patBall.add(patLine);

      str = createString();
      stage.scene.add(str.mesh);

      ghostBatch = new QuadBatch(900, createGhostMaterial(tex.atlas.texture), tex.atlas);
      ghostBatch.mesh.renderOrder = 6;
      inkWorld = new QuadBatch(900, createInkMaterial(tex.atlas.texture, true), tex.atlas);
      inkWorld.mesh.renderOrder = 10;
      inkTop = new QuadBatch(1600, createInkMaterial(tex.atlas.texture, false), tex.atlas);
      inkTop.mesh.renderOrder = 11;
      backInk = new QuadBatch(900, createInkMaterial(tex.atlas.texture, true), tex.atlas);
      backInk.mesh.renderOrder = 2;
      marginInk = new QuadBatch(400, createInkMaterial(tex.atlas.texture, false), tex.atlas);
      marginInk.mesh.renderOrder = 4;
      vignette = createVignette();
      pts = new PointsBatch(1100);
      pts.points.renderOrder = 9;
      aiPts = new PointsBatch(1600);
      aiPts.points.renderOrder = 2;
      stage.scene.add(ghostBatch.mesh, inkWorld.mesh, inkTop.mesh, backInk.mesh, marginInk.mesh, pts.points, aiPts.points,
        vignette.mesh);
      // The pending skin: textures, board, crane and blobs were built from it above; ball, trail, halos now.
      applied = null;
      applySkin();
    },

    setLayout(l) {
      layout = { ...l, scene: { ...l.scene }, deck: l.deck ? { ...l.deck } : null };
      if (!gl || !rig) return;
      quality.setDeviceDpr(l.dpr);
      dprApplied = 0;
      applyQuality();
      gl.setSize(l.scene.w, l.scene.h, true);
      rig.setViewport(layout);
      camSnap = true;
      rebuildStaticInk();
    },

    loadLevel(lv, aiPath, eggCargo) {
      const st = scene();
      level = lv;
      const eggChanged = isEgg !== eggCargo;
      isEgg = eggCargo;
      aiPathData = aiPath;
      const ph = lv.physics;
      if (bricks) {
        st.scene.remove(bricks.group);
        bricks.dispose();
      }
      bricks = createBricks(ph.walls, (tex as Textures).brick, look.stage);
      st.scene.add(bricks.group);
      crane?.setRail(ph.rail);
      goal?.set(ph.phases, ph.L);
      const xr = xRange(lv);
      st.fitShadow(xr[0], xr[1]);
      aiMarginMm = levelMarginMm(lv);
      boardLabel = boardLabels.get(lv.id) ?? boardLabelFor(lv, undefined);
      rig?.setLevel(xr, tallWindowFor(lv.view?.portraitWindow));
      // Egg level (§1.4 of the skins spec): the ball and string skins are ignored, a 'ball' ribbon / strobe uses red.
      cargoVisibility();
      if (eggChanged) applyTrail();
      rebuildAiPath();
      rebuildStaticInk();
      resetFx();
      lastStatus = -1;
      lastX = ph.startX;
      lastBx = ph.startX;
      lastBy = RAIL_Y - ph.L;
    },

    draw(f, dtReal) {
      if (!gl || !stage || !rig || !level || !layout || !str || !ball || !egg || !crane || !patBall) return;
      // NaN-safe clamps: a single bad frame must not poison the clock, the camera spring or the trail.
      const dt = dtReal > 0 ? Math.min(0.1, dtReal) : 0;
      time += dt;
      decals.tick(dt);
      quality.sample(dtReal * 1000);
      applyQuality();

      // Interpolated pose.
      const a = f.alpha > 0 ? (f.alpha < 1 ? f.alpha : 1) : 0;
      const L = f.L > 0 ? f.L : level.physics.L;
      let x = f.prev.x + (f.cur.x - f.prev.x) * a;
      let bx = f.prev.bx + (f.cur.bx - f.prev.bx) * a;
      let by = f.prev.by + (f.cur.by - f.prev.by) * a;
      if (!Number.isFinite(x) || !Number.isFinite(bx) || !Number.isFinite(by)) {
        x = lastX;
        bx = lastBx;
        by = lastBy;
      }
      const slack = f.cur.mode === MODE_SLACK || f.prev.mode === MODE_SLACK;
      if (!slack) {
        // Keep the taut string exactly L long between ticks.
        const dx = bx - x, dy = by - HOOK_Y;
        const d = Math.hypot(dx, dy);
        if (d > 1e-6) {
          bx = x + (dx / d) * L;
          by = HOOK_Y + (dy / d) * L;
        }
      }
      const T = f.prev.T + (f.cur.T - f.prev.T) * a;
      const px = 1 / Math.max(1, rig.pxPerM());

      // Status transitions.
      if (f.status !== lastStatus) {
        if (f.status === ST_READY) {
          trail.reset();
          activePhase = 0;
          ballAlive = true;
          camSnap = true;
        }
        if (f.status === ST_SUCCESS && !trail.frozen) trail.freeze();
        lastStatus = f.status;
      }
      if (f.status === ST_RUNNING) trail.push(bx, by, dt * Math.max(0, f.timeScale));

      // Crane, ball, string.
      crane.setTrolleyX(x);
      crane.update(dt);
      const cargo = isEgg ? egg : patterned ? patBall : ball;
      cargo.position.set(bx, by, 0);
      const outline = 1 + (1.15 * px) / BALL_R;
      ballLine?.scale.setScalar(outline);
      eggLine?.scale.setScalar(outline);
      patLine?.scale.setScalar(outline);
      if (isEgg || patterned) {
        // The egg and a patterned ball turn with the string (local +Y towards the hook); the plain ball never rotates.
        v3.set(x - bx, HOOK_Y - by, 0).normalize();
        cargo.quaternion.setFromUnitVectors(Y_UP, v3);
      }
      if (isEgg) egg.visible = ballAlive;
      str.update(x, HOOK_Y, bx, by, L, slack, Math.max(0.006, 2.4 * px), time);
      if (isEgg && level.physics.egg) {
        const Tm = level.physics.egg.Tmax;
        const sc = T >= 0.9 * Tm ? C_DANGER : T >= 0.75 * Tm ? C_AMBER : C_WHITE;
        str.setColor(sc, C_INK);
      } else {
        str.setColor(strC, strEdge);
      }
      snapFlash = Math.max(0, snapFlash - dt / 0.08);
      str.setFlash(reduced ? 0 : snapFlash);
      str.mesh.visible = ballAlive || !isEgg;

      // Camera: follow (tall, D10: look ahead toward the active goal) and shake.
      const zone = level.physics.phases[Math.min(activePhase, level.physics.phases.length - 1)];
      const goalX = zone ? (zone.xa + zone.xb) / 2 : x;
      // Aim where the trolley will be one spring lag (2 tau) from now, in real time (slow motion too).
      const vx = (f.cur.x - f.prev.x) * 60 * (f.timeScale > 0 ? Math.min(1, f.timeScale) : 0);
      const lead = Number.isFinite(vx) ? Math.max(-FOLLOW_LEAD_MAX, Math.min(FOLLOW_LEAD_MAX, 2 * FOLLOW_TAU * vx)) : 0;
      rig.follow(lookAheadFocus(x + lead, bx + lead, goalX, rig.windowW), dt, camSnap, Math.min(x, bx), Math.max(x, bx));
      camSnap = false;
      const sh = shake.update(dt);
      rig.applyShake(sh.ox, sh.oy, sh.rollDeg);

      // Ghosts.
      if (ghostBatch) {
        const gm = ghostBatch.mesh.material as import('three').ShaderMaterial;
        (gm.uniforms.uTime as { value: number }).value = time;
        (gm.uniforms.uPx as { value: number }).value = quality.state.dpr;
        (gm.uniforms.uFlicker as { value: number }).value = reduced ? 0 : 1;
        drawGhosts(ghostBatch, f.ghosts, L, px, time, 1, rig.visibleX(), x, dt);
      }

      // Trail + particles.
      if (pts) {
        const simDt = dt * (f.timeScale > 0 ? Math.min(1, f.timeScale) : 0);
        particles.update(simDt);
        pts.begin();
        trail.write(pts, dt, 2 * BALL_R / px);
        particles.write(pts);
        pts.end();
      }
      bricks?.update(dt);

      // Goal.
      targetPulse = targetPulse >= 0 ? targetPulse + dt : -1;
      if (targetPulse > 0.35) targetPulse = -1;
      goalFlash = Math.max(0, goalFlash - dt / 0.5);
      holdWobble = Math.max(0, holdWobble - dt);
      const hold = f.status === ST_SUCCESS ? 1 : f.holdFrac;
      // Reduced motion (§3.5): no flashes, no shiver; the curtain still fills with the hold.
      goal?.update(activePhase, hold, time, reduced ? 0 : goalFlash, f.status === ST_READY, reduced ? 0 : holdWobble * 1.5);

      // Blob shadows.
      if (blobs && blobs.mesh.visible) {
        const show = ballAlive ? 1 : 0;
        const hFloor = Math.max(0, by);
        blobs.set(0, bx, 0, 0.15 + 0.12 * Math.min(1, hFloor / 1.2), show * 0.6 * (1 - Math.min(0.75, hFloor / 1.6)));
        const walls = level.physics.walls;
        let w: WallDef | undefined;
        for (let i = 0; i < walls.length; i++) {
          const wi = walls[i] as WallDef;
          if (bx >= wi.x0 - 0.02 && bx <= wi.x1 + 0.02 && by > wi.h) w = wi;
        }
        if (w) {
          const hh = by - w.h;
          blobs.set(1, Math.min(w.x1 - 0.02, Math.max(w.x0 + 0.02, bx)), w.h, Math.min(w.x1 - w.x0, 0.1 + 0.1 * hh), show * 0.75 * (1 - Math.min(0.8, hh / 0.8)));
        } else {
          blobs.set(1, 0, 0, 0, 0);
        }
        blobs.set(2, x, 0, 0, 0);
      }

      // Overlays.
      if (aiPts) aiPts.points.visible = f.showAiLine;
      if (marginInk) marginInk.mesh.visible = f.showMargin && level.physics.walls.length > 0;
      drawWorldInk(f, x, bx, by, L, px);
      drawTopInk(f, x, bx, by, px, dt);

      // Crash beat steps (wall clock, §9.5).
      if (crashT >= 0) {
        crashT += dt;
        if (crashShakePending && crashT >= CRASH_HITSTOP) {
          crashShakePending = false;
          shake.add(1.0);
          vigT = crashT - CRASH_HITSTOP;
        }
        if (pendingDecal && crashT >= CRASH_STAMP) {
          decals.add(pendingDecal.level, pendingDecal.d);
          pendingDecal = null;
        }
        if (!crashShakePending && !pendingDecal) crashT = -1;
      }
      // Crash vignette. Reduced motion: a softer, slower tint.
      if (vigT >= 0) {
        vigT += dt;
        vigLevel = vignetteAt(vigT, reduced) * (reduced ? 0.55 : 1);
        if (vigT > 0.65) vigT = -1;
      } else {
        vigLevel = 0;
      }
      vignette?.set(vigLevel);

      lastX = x;
      lastBx = bx;
      lastBy = by;
      if (!api.skipRender && warmedUp(gl, stage.scene, rig.view, dt)) gl.render(stage.scene, rig.view);
    },

    fx(e) {
      if (!level) return;
      const ph = level.physics;
      switch (e.t) {
        case 'levelLoaded': {
          if (e.level !== level && e.level.id !== level.id) break;
          const next = boardLabelFor(level, e.label);
          boardLabels.set(level.id, next);
          if (next !== boardLabel) {
            boardLabel = next;
            rebuildStaticInk();
          }
          break;
        }
        case 'ready':
          trail.reset();
          activePhase = 0;
          ballAlive = true;
          break;
        case 'runStart':
          trail.reset();
          targetPulse = 0;
          break;
        case 'retry':
          resetFx();
          break;
        case 'rewind':
          // Practice rewind (D3): core already called resetFx() (trail, debris, camera snap); the goal
          // highlight and the look-ahead go back to the phase the run is in again (5-4).
          if (Number.isFinite(e.phase)) activePhase = Math.max(0, Math.min(ph.phases.length - 1, Math.floor(e.phase)));
          camSnap = true;
          break;
        case 'apex':
          pulse(lastX, HOOK_Y, 0.012, 0.055, 0.3, e.reached ? C_GOAL : C_INK);
          if (e.reached) particles.sparkle(e.x, e.y, 0.1, 6, PAL.goal);
          break;
        case 'snap': {
          snapFlash = 1;
          shake.add(Math.min(0.6, 0.15 + 0.1 * e.J));
          particles.dust(e.x, e.y, -0.04, Math.min(8, 2 + Math.round((e.J > 0 ? e.J : 0) * 3)), '#FFFFFF', 0.4); // behind the ball: it stays readable
          if (e.J >= 0.5) pulse(e.x, e.y, BALL_R, BALL_R + 0.06, 0.25, C_WHITE);
          break;
        }
        case 'stop': {
          // D5: core only emits stops of >= 0.1 m/s; this only keeps a bad value out of the effects.
          if (!(e.speed > 0) || !Number.isFinite(e.speed)) break;
          const s = Math.min(1, e.speed / 4);
          crane?.hit(e.side, 0.1 + 0.9 * s);
          shake.add(0.4 * s);
          const xs = e.side > 0 ? ph.rail[1] + TROLLEY_HALF_W : ph.rail[0] - TROLLEY_HALF_W;
          const n = Math.round(24 * s);
          if (n > 0) particles.sparks(xs, 1.275, 0.12, n, -e.side, 0.6, 1.2 + 2.5 * s);
          break;
        }
        case 'cross': {
          if (e.speed >= 3) particles.streaks(lastBx, lastBy, 0.05, e.dir, 5);
          if (e.gapMm < 40) {
            if (dims.length >= 3) dims.shift();
            dims.push({ wall: e.wall, gapMm: e.gapMm, px: e.px, py: e.py, t: 0, dir: e.dir });
            const w = ph.walls[e.wall];
            if (w) {
              const tier = tierOf(e.gapMm);
              const cx = Math.abs(e.px - w.x0) < Math.abs(e.px - w.x1) ? w.x0 : w.x1;
              particles.sparks(cx, w.h, Z_WALL_HALF - 0.02, 5 + tier * 5, e.dir, 1, 1 + tier * 0.5);
            }
          }
          break;
        }
        case 'holdStart':
          if (!reduced) goalFlash = Math.max(goalFlash, 0.25);
          break;
        case 'holdReset':
          if (e.frac >= 0.3) holdWobble = 0.4;
          break;
        case 'phase': {
          activePhase = Math.min(e.index + 1, ph.phases.length - 1);
          const z = ph.phases[e.index];
          if (z) particles.sparkle((z.xa + z.xb) / 2, RAIL_Y - ph.L, 0.1, 10, PAL.goal, 0.2);
          goalFlash = 0.6;
          break;
        }
        case 'success': {
          trail.freeze();
          const z = ph.phases[Math.min(activePhase, ph.phases.length - 1)] ?? ph.phases[0];
          if (z) {
            particles.confetti(z.xa - 0.15, z.xb + 0.15, Math.max(0.25, lastBy), 90, confettiPal, confettiShape);
            particles.sparkle(lastBx, lastBy, 0.1, 10, PAL.goal, 0.12);
          }
          goalFlash = 1;
          break;
        }
        case 'crash': {
          if (pendingDecal) decals.add(pendingDecal.level, pendingDecal.d);
          pendingDecal = null;
          crashT = 0;
          crashShakePending = true;
          if (!Number.isFinite(e.x) || !Number.isFinite(e.y)) break; // no marker / decal at NaN
          crash = { kind: e.kind, wall: e.wall, x: e.x, y: e.y, t: 0 };
          const w = e.wall >= 0 ? ph.walls[e.wall] : undefined;
          if ((e.kind === CK_BALL || e.kind === CK_STRING) && w) {
            bricks?.burst(e.wall, e.x, e.y, 6);
            particles.dust(e.x, e.y, -0.04, 12, dustTint, 0.9); // behind the ball plane so the ball stays readable
            particles.sparks(e.x, e.y, 0.2, 10, e.x < (w.x0 + w.x1) / 2 ? -1 : 1, 0.8, 1.5, sparkTint);
            const dxw = Math.min(w.x1, Math.max(w.x0, e.x));
            pendingDecal = { level: level.id, d: { x: dxw, y: Math.min(w.h - 0.03, Math.max(0.04, e.y)), z: Z_WALL_HALF + 0.004, rot: (particles.rand() - 0.5) * 0.5, size: Math.min(0.1, (w.x1 - w.x0) * 0.9) } };
          } else if (e.kind === CK_BEAM) {
            particles.sparks(e.x, BEAM_TOP - 0.1, 0.12, 22, 0, -1, 2.2);
            pendingDecal = { level: level.id, d: { x: e.x, y: 1.35, z: 0.1, rot: 0.1, size: 0.08 } };
          } else if (e.kind === CK_FLOOR) {
            particles.dust(e.x, 0.02, 0.1, 16, floorDustTint, 0.8);
            pendingDecal = { level: level.id, d: { x: e.x, y: -0.08, z: Z_FLOOR_FRONT + 0.004, rot: -0.1, size: 0.09 } };
          } else if (e.kind === CK_EGG) {
            particles.yolk(lastBx, lastBy, 0.05);
            ballAlive = false;
          }
          break;
        }
        default:
          break;
      }
    },

    worldToScreen,
    mapper,
    resetFx,

    dispose() {
      bricks?.dispose();
      crane?.dispose();
      goal?.dispose();
      blobs?.dispose();
      str?.dispose();
      vignette?.dispose();
      vignette = null;
      for (const q of [ghostBatch, inkWorld, inkTop, backInk, marginInk]) {
        if (q) {
          q.dispose();
          (q.mesh.material as import('three').Material).dispose();
        }
      }
      pts?.dispose();
      aiPts?.dispose();
      if (ball) {
        ball.geometry.dispose();
        (ball.material as import('three').Material).dispose();
      }
      if (egg) {
        egg.geometry.dispose();
        (egg.material as import('three').Material).dispose();
      }
      (ballLine?.material as import('three').Material | undefined)?.dispose();
      (eggLine?.material as import('three').Material | undefined)?.dispose();
      if (patBall) {
        patBall.geometry.dispose();
        (patBall.material as import('three').Material).dispose();
      }
      (patLine?.material as import('three').Material | undefined)?.dispose();
      stage?.dispose();
      tex?.dispose();
      env?.dispose();
      if (canvasEl && onContextLost) canvasEl.removeEventListener('webglcontextlost', onContextLost);
      if (onFontsLoaded) fontSet()?.removeEventListener('loadingdone', onFontsLoaded);
      onFontsLoaded = null;
      canvasEl = null;
      onContextLost = null;
      gl?.dispose();
      gl = null;
      stage = null;
      level = null;
      rig = null;
      tex = null;
      env = null;
      crane = null;
      bricks = null;
      goal = null;
      blobs = null;
      str = null;
      ball = egg = ballLine = eggLine = patBall = patLine = null;
      applied = null;
      ghostBatch = inkWorld = inkTop = backInk = marginInk = null;
      pts = aiPts = null;
      dprApplied = 0;
      shadowsOn = false;
    },

    setOptions(o) {
      if (o.reducedMotion !== undefined) {
        reduced = o.reducedMotion;
        shake.reducedMotion = reduced;
        if (reduced) shake.reset();
      }
      if (o.quality !== undefined) {
        quality = createQualityGovernor(o.quality, undefined, layout?.dpr ?? (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1));
        dprApplied = 0;
        applyQuality();
      }
    },

    setSkin(next) {
      if (!next || !next.ball || !next.crane || !next.trail || !next.stage) return;
      look = next;
      // Before init: kept as pending; init builds from it. After init: only the changed parts.
      if (gl && applied) applySkin();
    },

    skin() {
      const out = {} as Record<SkinPart, string>;
      for (const p of SKIN_PARTS) out[p] = applied ? applied[p] : look[p].id;
      return out;
    },

    setAiMarginMm(mm) {
      const v = Number.isFinite(mm) && mm > 0 ? mm : level ? levelMarginMm(level) : 20;
      if (v === aiMarginMm) return;
      aiMarginMm = v;
      rebuildStaticInk();
    },

    stats() {
      const info = gl?.info;
      return {
        calls: info?.render.calls ?? 0,
        triangles: info?.render.triangles ?? 0,
        points: info?.render.points ?? 0,
        lines: info?.render.lines ?? 0,
        textures: info?.memory.textures ?? 0,
        geometries: info?.memory.geometries ?? 0,
        particles: particles.active,
        dpr: quality.state.dpr,
        shadows: shadowsOn,
        debris: bricks ? bricks.debris.count : 0,
        vignette: vigLevel,
        snapFlash: reduced ? 0 : snapFlash,
        shake: shake.update(0).offset,
        reduced,
      };
    },
    pxPerM: () => (rig ? rig.pxPerM() : 0),
    worldToScreenBase(x, y) {
      if (!rig || !layout) return { x: 0, y: 0 };
      v3.set(x, y, 0).project(rig.base);
      return { x: layout.scene.x + (v3.x + 1) * 0.5 * layout.scene.w, y: layout.scene.y + (1 - v3.y) * 0.5 * layout.scene.h };
    },
    skipRender: false,
    ghostTags() {
      if (!rig || !layout) return [];
      const L0 = layout;
      const toScreen = (x: number, y: number): { x: number; y: number } => {
        v3.set(x, y, 0.1).project((rig as CameraRig).view);
        return { x: L0.scene.x + (v3.x + 1) * 0.5 * L0.scene.w, y: L0.scene.y + (1 - v3.y) * 0.5 * L0.scene.h };
      };
      return lastTagRects().map((r) => {
        const a = toScreen(r.x0, r.y1), b = toScreen(r.x1, r.y0);
        return { label: r.label, x0: a.x, x1: b.x, y0: a.y, y1: b.y, row: r.row };
      });
    },
    labels: () => ({ board: boardLabel, aiMarginMm }),
    frame() {
      if (!rig || !layout) return { beamTopY: NaN, floorY: NaN, sceneTop: NaN, sceneBottom: NaN, hudTop: NaN, windowW: NaN };
      const cx = (rig.visibleX()[0] + rig.visibleX()[1]) / 2;
      const sp = (y: number, z: number): number => {
        v3.set(cx, y, z).project((rig as CameraRig).base);
        return (layout as Layout).scene.y + (1 - v3.y) * 0.5 * (layout as Layout).scene.h;
      };
      return {
        beamTopY: sp(BEAM_TOP, -0.07), floorY: sp(0, Z_FLOOR_FRONT),
        sceneTop: layout.scene.y, sceneBottom: layout.scene.y + layout.scene.h, hudTop: layout.hudTop, windowW: rig.windowW,
      };
    },
    probe(x, y) {
      if (!gl || !stage || !rig || !layout) return null;
      gl.render(stage.scene, rig.view);
      // Read in the same task as the render: the drawing buffer is still intact.
      const ctx = gl.getContext();
      const k = gl.getPixelRatio();
      const px = Math.floor((x - layout.scene.x) * k), py = Math.floor((layout.scene.y + layout.scene.h - y) * k);
      const buf = new Uint8Array(4);
      ctx.readPixels(px, py, 1, 1, ctx.RGBA, ctx.UNSIGNED_BYTE, buf);
      return [buf[0] as number, buf[1] as number, buf[2] as number];
    },
  };
  return api;
}
