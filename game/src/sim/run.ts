// Simulation state and the tick stepper (GAME_DESIGN.md §4.4-§4.6, §10.4). Owner: O1.
//
// One tick = 2 substeps of H = 1/120 s with the force F = q*Fmax/127 held (zero-order hold).
// A substep integrates (Taut RK4 / pinned pendulum / Slack ballistic + re-tension, rail-end impulses),
// then counts `substep` and applies, in order: collisions a-e (§4.5), WallCross, Apex, the hold /
// success rules (§4.6) and the time-up (f). stepTick stops on the substep that ends the run.
// stepTick allocates nothing: scratch storage is module level or owned by the Run, and numbers cross
// function boundaries through Float64Arrays rather than as arguments / return values, because V8 boxes a
// double into a fresh HeapNumber at every call it did not inline (see dynamics.ts). That includes calls on
// rarely taken branches: once they have type feedback, TurboFan may box their double arguments on every pass
// (the crash calls did, ~32 B per substep), so crashAt() takes integers only and reads the rest from the
// state. Measured (Node 24, --trace-gc): no minor GC during 230k ticks of the 20 mixed golden runs once
// optimised. Only the rail-stop impulse and the crash itself still box a few numbers, once per event.
import * as K from './constants';
import * as DM from './detmath';
import * as DY from './dynamics';
import * as CO from './collide';
import { Ev, type SimEvents } from './events';
import * as RU from './rules';
import type { Vec2 } from './collide';
import type { LevelPhysics, WallDef, ZoneDef } from './level';

// Module-local copies of everything the hot loop imports. Vitest's module runner resolves each access to an
// imported binding through a getter (the loop ran ~3x slower under test than bundled); bundlers
// (Vite/Rolldown, wrangler/esbuild) produce the same machine code either way. Values are identical.
const B_TROLLEY = K.B_TROLLEY;
const BALL_R = K.BALL_R;
const BEAM_Y = K.BEAM_Y;
const G = K.G;
const H = K.H;
const HOLD_SUB = K.HOLD_SUB;
const MAX_SUB = K.MAX_SUB;
const Q_MAX = K.Q_MAX;
const RAIL_Y = K.RAIL_Y;
const REST_V = K.REST_V;
const SNAP_EV_MIN_J = K.SNAP_EV_MIN_J;
const atan2kAt = DM.atan2kAt;
const sincosAt = DM.sincosAt;
const ACC = DY.ACC;
const SNAP = DY.SNAP;
const accelAt = DY.accelAt;
const railStopW = DY.railStopW;
const rk4CartP = DY.rk4CartP;
const rk4PinnedP = DY.rk4PinnedP;
const rk4TautP = DY.rk4TautP;
const snapImpulseA = DY.snapImpulseA;
const pointSegDist2 = CO.pointSegDist2;
const segHitsSlabA = CO.segHitsSlabA;
const segSlabClosestA = CO.segSlabClosestA;
const segSlabEntry = CO.segSlabEntry;
const restEnergy = RU.restEnergy;
const EV_SNAP: Ev = Ev.Snap;
const EV_SLACK_BEGIN: Ev = Ev.SlackBegin;
const EV_STOP_HIT: Ev = Ev.StopHit;
const EV_WALL_CROSS: Ev = Ev.WallCross;
const EV_APEX: Ev = Ev.Apex;
const EV_HOLD_BEGIN: Ev = Ev.HoldBegin;
const EV_HOLD_RESET: Ev = Ev.HoldReset;
const EV_PHASE_DONE: Ev = Ev.PhaseDone;
const EV_SUCCESS: Ev = Ev.Success;
const EV_CRASH: Ev = Ev.Crash;
const EV_TIMEOUT: Ev = Ev.Timeout;

export const enum Mode { Taut = 0, Slack = 1 }
export const enum Status { Ready = 0, Running = 1, Success = 2, Crash = 3, Timeout = 4 }
export const enum CrashKind { Ball = 1, String = 2, Beam = 3, Floor = 4, Egg = 5 }

// Enum members as module constants: the hot loop then does not depend on the transpiler inlining
// const enums across files (vitest / Vite transform each file separately).
const TAUT: Mode = Mode.Taut;
const SLACK: Mode = Mode.Slack;
const READY: Status = Status.Ready;
const RUNNING: Status = Status.Running;
const SUCCESS: Status = Status.Success;
const CRASH: Status = Status.Crash;
const TIMEOUT: Status = Status.Timeout;

export interface CrashInfo { kind: CrashKind; wall: number; px: number; py: number; d2: number }
/** Reused object (never reallocated during a run). */
export interface NearInfo { wall: number; d2: number; px: number; py: number }
/**
 * Simulation state (§4.4). (x, v) is the trolley; (th, w) the taut-string coordinates, which are only
 * meaningful while mode is Taut: during Slack they keep the value from when the string went slack (or was
 * last projected), so use (bx, by) relative to the pivot (x, RAIL_Y) for the string angle then.
 * (bx, by, bvx, bvy) is the ball's world state, always current. T = 0 while slack.
 */
export interface SimState {
  mode: Mode; pinned: -1 | 0 | 1;
  x: number; v: number; th: number; w: number;
  bx: number; by: number; bvx: number; bvy: number;
  F: number; T: number;
  substep: number; status: Status;
  phase: number; hold: number; holdStart: number;
  score: number;          // valid on Success (1/120 s)
  minD2: number;          // minimum (ball centre to wall distance)^2 over the run (swept per substep; +Infinity without walls)
  peakF: number;
  near: NearInfo;         // nearest wall this substep (wall -1, d2 +Infinity without walls); also filled at Ready
  crash: CrashInfo | null; // d2: ball = its squared distance; string / egg = r^2 (0 mm overlap); beam / floor = gap^2
}
export interface PoseSnap { x: number; bx: number; by: number; mode: Mode; T: number; F: number }
export interface Run { readonly phys: LevelPhysics; readonly s: SimState; readonly prev: PoseSnap; readonly cur: PoseSnap }

/**
 * Hidden per-run bookkeeping carried by every state made here (createRun / newSimState).
 * copyState copies it too, so a restored state resumes bit-identically.
 */
interface StateExt extends SimState {
  /** Storage that `crash` points to after a crash (so a crash allocates nothing). */
  crashBuf: CrashInfo;
  /** Per wall: minimum d2 since the ball entered the WallCross window |bx - cx| < hw + 0.30. */
  winMin: Float64Array;
  /** Bit i set while the ball is inside wall i's window. */
  winIn: number;
}

const MIN_WALL_SLOTS = 4;
const R2 = BALL_R * BALL_R;
const CROSS_WINDOW = 0.30;

// ---- module scratch (single-threaded, never escapes) -------------------------------------------

// Numbers cross function boundaries in these arrays, not as arguments (see dynamics.ts: no HeapNumber boxing).
const SC = new Float64Array(2); // [sin, cos] of TH[0]
const TH = new Float64Array(1); // angle handed to sincosAt
const A2 = new Float64Array(2); // [y, x] handed to atan2kAt
const SN = new Float64Array(6); // [sn, cs, vr, bvx, bvy, v] handed to snapImpulseA
const SEG = new Float64Array(4); // [ax, ay, bx, by]: the ball chord of this substep
const STR = new Float64Array(4); // [px, py, bx, by]: the string at the end of this substep
const SOUT = new Float64Array(3); // [d2, closest x, closest y] from segSlabClosestA
const Y4 = new Float64Array(4); // [x, v, th, w] being integrated
const Y0 = new Float64Array(4); // start of the current free taut step (for the rail-end re-integration)
const Y2 = new Float64Array(2);
const CP: Vec2 = { x: 0, y: 0 };
let D2 = new Float64Array(8);
let eggHit = false;

// ---- run --------------------------------------------------------------------------------------

class RunCore implements Run {
  // `declare`: no class-field definitions (useDefineForClassFields would first set every field to undefined,
  // which makes V8 keep the numeric fields tagged); the constructor below creates them with their values.
  declare readonly phys: LevelPhysics;
  declare readonly s: StateExt;
  declare readonly prev: PoseSnap;
  declare readonly cur: PoseSnap;

  declare readonly M: number;
  declare readonly m: number;
  declare readonly L: number;
  declare readonly Fmax: number;
  declare readonly xMin: number;
  declare readonly xMax: number;
  declare readonly eRest: number;
  declare readonly egg: boolean;
  declare readonly Tmax: number;
  declare readonly Jmax: number;
  declare readonly walls: WallDef[];
  declare readonly nW: number;
  declare readonly wcx: Float64Array; // wall centre x
  declare readonly wwin: Float64Array; // WallCross window half width hw + 0.30
  declare readonly zones: ZoneDef[];
  declare readonly nPhases: number;
  /** Integration parameter block [M, m, L, F, h] (dynamics.ts ParBlock); F and h change per (sub)step. */
  declare readonly par: Float64Array;

  constructor(phys: LevelPhysics) {
    this.phys = phys;
    this.M = phys.M;
    this.m = phys.m;
    this.L = phys.L;
    this.Fmax = phys.Fmax;
    this.xMin = phys.rail[0];
    this.xMax = phys.rail[1];
    this.eRest = restEnergy(phys);
    this.egg = phys.egg !== undefined;
    this.Tmax = phys.egg ? phys.egg.Tmax : Infinity;
    this.Jmax = phys.egg ? phys.egg.Jmax : Infinity;
    this.walls = phys.walls;
    this.nW = phys.walls.length;
    this.wcx = new Float64Array(this.nW);
    this.wwin = new Float64Array(this.nW);
    for (let i = 0; i < this.nW; i++) {
      const w = phys.walls[i]!;
      this.wcx[i] = 0.5 * (w.x0 + w.x1);
      this.wwin[i] = 0.5 * (w.x1 - w.x0) + CROSS_WINDOW;
    }
    if (D2.length < this.nW) D2 = new Float64Array(this.nW);
    this.zones = phys.phases;
    this.nPhases = phys.phases.length;
    this.par = new Float64Array(5);
    this.par[0] = phys.M;
    this.par[1] = phys.m;
    this.par[2] = phys.L;
    this.s = allocState(this.nW);
    this.prev = { x: 0, bx: 0, by: 0, mode: TAUT, T: 0, F: 0 };
    this.cur = { x: 0, bx: 0, by: 0, mode: TAUT, T: 0, F: 0 };
    initState(this);
  }
}

function allocState(nWalls: number): StateExt {
  return {
    mode: TAUT, pinned: 0,
    x: 0, v: 0, th: 0, w: 0,
    bx: 0, by: 0, bvx: 0, bvy: 0,
    F: 0, T: 0,
    substep: 0, status: READY,
    phase: 0, hold: 0, holdStart: 0,
    score: 0, minD2: Infinity, peakF: 0,
    near: { wall: -1, d2: Infinity, px: 0, py: 0 },
    crash: null,
    crashBuf: { kind: CrashKind.Ball, wall: -1, px: 0, py: 0, d2: 0 },
    winMin: new Float64Array(nWalls > MIN_WALL_SLOTS ? nWalls : MIN_WALL_SLOTS),
    winIn: 0,
  };
}

/** A fresh state object with the hidden bookkeeping (e.g. for the practice-mode rewind ring). */
export function newSimState(): SimState {
  return allocState(MIN_WALL_SLOTS);
}

function setPose(p: PoseSnap, s: SimState): void {
  p.x = s.x;
  p.bx = s.bx;
  p.by = s.by;
  p.mode = s.mode;
  p.T = s.T;
  p.F = s.F;
}

function initState(r: RunCore): void {
  const s = r.s;
  const phys = r.phys;
  s.mode = TAUT;
  s.pinned = 0;
  s.x = phys.startX;
  s.v = 0;
  s.th = 0;
  s.w = 0;
  s.bx = phys.startX;
  s.by = RAIL_Y - r.L;
  s.bvx = 0;
  s.bvy = 0;
  s.F = 0;
  s.T = r.m * G;
  s.substep = 0;
  s.status = READY;
  s.phase = 0;
  s.hold = 0;
  s.holdStart = 0;
  s.score = 0;
  s.peakF = 0;
  s.crash = null;
  s.winIn = 0;
  // proximity at rest (so the HUD gap gauge works in READY): the zero-length chord at the hanging ball gives the
  // point-to-slab distance and closest point (same values as pointSlabClosest; the array form keeps doubles off
  // call boundaries, so resetRun allocates nothing)
  SEG[0] = s.bx;
  SEG[1] = s.by;
  SEG[2] = s.bx;
  SEG[3] = s.by;
  let best = Infinity;
  let bestW = -1;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < r.nW; i++) {
    segSlabClosestA(SEG, r.walls[i]!, SOUT);
    const d2 = SOUT[0]!;
    if (d2 < best) {
      best = d2;
      bestW = i;
      cx = SOUT[1]!;
      cy = SOUT[2]!;
    }
    if (Math.abs(s.bx - r.wcx[i]!) < r.wwin[i]!) {
      s.winIn |= 1 << i;
      s.winMin[i] = d2;
    } else {
      s.winMin[i] = Infinity;
    }
  }
  s.near.wall = bestW;
  s.near.d2 = best;
  s.near.px = cx;
  s.near.py = cy;
  s.minD2 = best;
  setPose(r.prev, s);
  setPose(r.cur, s);
}

export function createRun(phys: LevelPhysics): Run {
  return new RunCore(phys);
}

/** Back to the start state. No allocation. */
export function resetRun(run: Run): void {
  initState(run as RunCore);
}

/** Copies every field including the contents of near and crash. No allocation (after a state's first use). */
export function copyState(src: SimState, dst: SimState): void {
  const a = src as StateExt;
  const b = dst as StateExt;
  b.mode = a.mode;
  b.pinned = a.pinned;
  b.x = a.x;
  b.v = a.v;
  b.th = a.th;
  b.w = a.w;
  b.bx = a.bx;
  b.by = a.by;
  b.bvx = a.bvx;
  b.bvy = a.bvy;
  b.F = a.F;
  b.T = a.T;
  b.substep = a.substep;
  b.status = a.status;
  b.phase = a.phase;
  b.hold = a.hold;
  b.holdStart = a.holdStart;
  b.score = a.score;
  b.minD2 = a.minD2;
  b.peakF = a.peakF;
  if (!b.near) b.near = { wall: -1, d2: Infinity, px: 0, py: 0 };
  b.near.wall = a.near.wall;
  b.near.d2 = a.near.d2;
  b.near.px = a.near.px;
  b.near.py = a.near.py;
  if (!b.crashBuf) b.crashBuf = { kind: CrashKind.Ball, wall: -1, px: 0, py: 0, d2: 0 };
  if (a.crash === null) {
    b.crash = null;
  } else {
    const c = b.crashBuf;
    c.kind = a.crash.kind;
    c.wall = a.crash.wall;
    c.px = a.crash.px;
    c.py = a.crash.py;
    c.d2 = a.crash.d2;
    b.crash = c;
  }
  const n = a.winMin ? a.winMin.length : 0;
  if (!b.winMin || b.winMin.length < n) b.winMin = new Float64Array(n > MIN_WALL_SLOTS ? n : MIN_WALL_SLOTS);
  if (a.winMin) b.winMin.set(a.winMin);
  b.winIn = a.winIn ?? 0;
}

/** Inverse of copyState; also aligns prev and cur poses. */
export function restoreState(run: Run, s: SimState): void {
  const r = run as RunCore;
  copyState(s, r.s);
  setPose(r.prev, r.s);
  setPose(r.cur, r.s);
}

/** q * Fmax / 127 */
export function forceOfQ(q: number, Fmax: number): number {
  return (q * Fmax) / 127;
}

// ---- integration --------------------------------------------------------------------------------

/** Ball world state from the taut coordinates (§4.4 Taut step 5 / 9); sin(th), cos(th) = sc[i], sc[i + 1]. */
function ballFromTaut(r: RunCore, sc: Float64Array, i: number): void {
  const s = r.s;
  const L = r.L;
  const sn = sc[i]!; // sin(th)
  const cs = sc[i + 1]!; // cos(th)
  s.bx = s.x + L * sn;
  s.by = RAIL_Y - L * cs;
  s.bvx = s.v + L * s.w * cs;
  s.bvy = L * s.w * sn;
}

/**
 * §4.4 Taut: pinned test, tension, egg, slack transition, RK4 (free or pinned), rail-end impulses.
 * Force and step length come from r.par (F = par[3], h = par[4]).
 */
function tautStep(r: RunCore, depth: number, ev: SimEvents, sub: number): void {
  const s = r.s;
  const par = r.par;
  const m = r.m;
  const L = r.L;
  Y4[0] = s.x;
  Y4[1] = s.v;
  Y4[2] = s.th;
  Y4[3] = s.w;
  // 1. free-trolley accelerations (also k1 of the RK4 below)
  accelAt(par, Y4);
  const xdd = ACC[0]!;
  const sn = ACC[2]!;
  const cs = ACC[3]!;
  // 2. pinned test first
  let fixed = false;
  if ((s.pinned === 1 && xdd >= 0) || (s.pinned === -1 && xdd <= 0)) fixed = true;
  else s.pinned = 0;
  // 3. tension with the acceleration actually used
  const w = s.w;
  const T = fixed ? m * (G * cs + L * w * w) : m * (G * cs + L * w * w - xdd * sn);
  s.T = T;
  // 4. egg
  if (r.egg && T > r.Tmax) {
    eggHit = true;
    return;
  }
  // 5. slack
  if (T < 0) {
    ballFromTaut(r, ACC, 2);
    const k = ev.slot(EV_SLACK_BEGIN, sub);
    if (k >= 0) {
      ev.a[k] = T;
      ev.b[k] = s.bx;
      ev.c[k] = s.by;
    }
    s.mode = SLACK;
    slackStep(r, ev, sub);
    return;
  }
  if (fixed) {
    // 6. fixed pivot
    Y2[0] = s.th;
    Y2[1] = s.w;
    rk4PinnedP(par, Y2);
    s.th = Y2[0]!;
    s.w = Y2[1]!;
    s.v = 0;
  } else {
    // 7. free (ACC still holds k1)
    Y0[0] = Y4[0]!;
    Y0[1] = Y4[1]!;
    Y0[2] = Y4[2]!;
    Y0[3] = Y4[3]!;
    rk4TautP(par, Y4, true);
    const x1 = Y4[0]!;
    if (x1 > r.xMax || x1 < r.xMin) {
      railHitTaut(r, depth, ev, sub);
      return;
    }
    s.x = x1;
    s.v = Y4[1]!;
    s.th = Y4[2]!;
    s.w = Y4[3]!;
  }
  // 9. ball world state
  TH[0] = s.th;
  sincosAt(TH, 0, SC);
  ballFromTaut(r, SC, 0);
}

/** §4.4 Taut step 8: the free trolley crossed a rail end during this (sub)step (start Y0, end Y4). */
function railHitTaut(r: RunCore, depth: number, ev: SimEvents, sub: number): void {
  const s = r.s;
  const par = r.par;
  const L = r.L;
  const x0 = Y0[0]!;
  const x1 = Y4[0]!;
  const side: 1 | -1 = x1 > r.xMax ? 1 : -1;
  const xe = side === 1 ? r.xMax : r.xMin;
  if (x0 === xe && Y0[1] === 0) {
    // The trolley started this step resting against this end (no impact): step 2 released it because the
    // free xdd pointed away from the end at the start, but xdd turns back within the step and the RK4 step
    // ends beyond the end. The end holds the trolley, so this step is the fixed pivot of step 6. (Taking the
    // f = 0 path instead would re-integrate nothing, emit zero-speed StopHits and freeze the pendulum for as
    // long as F stays the same; the depth-1 remainder after a taut stop always starts here as well.)
    s.x = xe;
    s.v = 0;
    s.pinned = side;
    Y2[0] = Y0[2]!;
    Y2[1] = Y0[3]!;
    rk4PinnedP(par, Y2);
    s.th = Y2[0]!;
    s.w = Y2[1]!;
    TH[0] = s.th;
    sincosAt(TH, 0, SC);
    ballFromTaut(r, SC, 0);
    return;
  }
  const f = (xe - x0) / (x1 - x0);
  const h = par[4]!;
  // integrate again from the start state for f*h
  Y4[0] = x0;
  Y4[1] = Y0[1]!;
  Y4[2] = Y0[2]!;
  Y4[3] = Y0[3]!;
  par[4] = f * h;
  rk4TautP(par, Y4, false);
  const vOld = Y4[1]!;
  s.x = xe;
  s.th = Y4[2]!;
  s.w = Y4[3]!;
  sincosAt(Y4, 2, SC);
  const sn = SC[0]!;
  const cs = SC[1]!;
  let taut: boolean;
  if (vOld * sn >= 0) {
    // the string pulls: stays taut, p_theta conserved
    s.w = railStopW(L, vOld, cs, s.w);
    s.v = 0;
    s.pinned = side;
    ballFromTaut(r, SC, 0);
    taut = true;
  } else {
    // the string would have to push: the ball keeps its world velocity, the string goes slack
    s.v = vOld;
    ballFromTaut(r, SC, 0);
    s.v = 0;
    s.pinned = side;
    s.mode = SLACK;
    s.T = 0;
    taut = false;
  }
  const k = ev.slot(EV_STOP_HIT, sub);
  if (k >= 0) {
    ev.a[k] = side;
    ev.b[k] = Math.abs(vOld);
    ev.c[k] = taut ? 1 : 0;
  }
  if (depth === 0) {
    par[4] = (1 - f) * h;
    if (s.mode === TAUT) tautStep(r, 1, ev, sub);
    else slackStep(r, ev, sub);
  }
}

/** §4.4 Slack: trolley alone, ballistic ball, re-tension with the inelastic string impulse (F = par[3], h = par[4]). */
function slackStep(r: RunCore, ev: SimEvents, sub: number): void {
  const s = r.s;
  const par = r.par;
  const L = r.L;
  const F = par[3]!;
  const h = par[4]!;
  // 1. trolley
  if (s.pinned !== 0 && (F - B_TROLLEY * s.v) * s.pinned >= 0) {
    s.v = 0;
  } else {
    s.pinned = 0;
    Y2[0] = s.x;
    Y2[1] = s.v;
    rk4CartP(par, Y2);
    const x1 = Y2[0]!;
    if (x1 > r.xMax) {
      s.x = r.xMax;
      s.v = 0;
      s.pinned = 1;
      const k = ev.slot(EV_STOP_HIT, sub);
      if (k >= 0) {
        ev.a[k] = 1;
        ev.b[k] = Math.abs(Y2[1]!);
      }
    } else if (x1 < r.xMin) {
      s.x = r.xMin;
      s.v = 0;
      s.pinned = -1;
      const k = ev.slot(EV_STOP_HIT, sub);
      if (k >= 0) {
        ev.a[k] = -1;
        ev.b[k] = Math.abs(Y2[1]!);
      }
    } else {
      s.x = x1;
      s.v = Y2[1]!;
    }
  }
  // 2. ball: exact parabola
  s.bx += s.bvx * h;
  s.by += s.bvy * h - 0.5 * G * h * h;
  s.bvy -= G * h;
  // 3. re-tension
  const dx = s.bx - s.x;
  const dy = s.by - RAIL_Y;
  if (dx * dx + dy * dy >= L * L) {
    A2[0] = dx;
    A2[1] = -dy;
    atan2kAt(A2, TH, 0);
    const th = TH[0]!;
    sincosAt(TH, 0, SC);
    const sn = SC[0]!;
    const cs = SC[1]!;
    s.th = th;
    s.bx = s.x + L * sn;
    s.by = RAIL_Y - L * cs;
    const vr = (s.bvx - s.v) * sn - s.bvy * cs;
    if (vr > 0) {
      const held = s.pinned * sn > 0;
      SN[0] = sn;
      SN[1] = cs;
      SN[2] = vr;
      SN[3] = s.bvx;
      SN[4] = s.bvy;
      SN[5] = s.v;
      snapImpulseA(r.par, SN, held);
      const J = SNAP[0]!;
      s.bvx = SNAP[1]!;
      s.bvy = SNAP[2]!;
      s.v = SNAP[3]!;
      if (!held && s.pinned !== 0 && s.v * s.pinned < 0) s.pinned = 0;
      s.w = ((s.bvx - s.v) * cs + s.bvy * sn) / L;
      s.mode = TAUT;
      if (J >= SNAP_EV_MIN_J) {
        const k = ev.slot(EV_SNAP, sub);
        if (k >= 0) {
          ev.a[k] = J;
          ev.b[k] = s.bx;
          ev.c[k] = s.by;
        }
      }
      if (r.egg && J > r.Jmax) eggHit = true;
    }
  }
  // 4.
  s.T = 0;
}

// ---- rules ------------------------------------------------------------------------------------

/**
 * Ends the run with a crash. Only integers are passed in: the contact point and d2 are derived here from the
 * state (so no double crosses a call boundary on the hot path; V8 would otherwise box them on every substep):
 * - Ball: the swept chord's closest slab point and d2, already in s.near,
 * - String: corner < 0: where the string (pivot -> ball) enters the slab (else the nearer top corner);
 *   corner 0 / 1: the top corner (x0, h) / (x1, h) the string swept. d2 = r^2 (0 mm overlap),
 * - Beam / Floor: below the ball at y = BEAM_Y / 0, d2 = gap^2 (0 when the centre is past it),
 * - Egg: the ball centre, d2 = r^2.
 */
function crashAt(r: RunCore, kind: CrashKind, wall: number, corner: number, ev: SimEvents, sub: number): void {
  const s = r.s;
  const c = s.crashBuf;
  let px = s.bx;
  let py = s.by;
  let d2 = R2;
  if (kind === CrashKind.Ball) {
    px = s.near.px;
    py = s.near.py;
    d2 = s.near.d2;
  } else if (kind === CrashKind.String) {
    const w = r.walls[wall]!;
    if (corner >= 0) {
      px = corner === 0 ? w.x0 : w.x1;
      py = w.h;
    } else if (segSlabEntry(s.x, RAIL_Y, s.bx, s.by, w, CP)) {
      px = CP.x;
      py = CP.y;
    } else {
      const d0 = pointSegDist2(w.x0, w.h, s.x, RAIL_Y, s.bx, s.by);
      const d1 = pointSegDist2(w.x1, w.h, s.x, RAIL_Y, s.bx, s.by);
      px = d0 <= d1 ? w.x0 : w.x1;
      py = w.h;
    }
  } else if (kind === CrashKind.Beam) {
    const g = BEAM_Y - s.by;
    py = BEAM_Y;
    d2 = g > 0 ? g * g : 0;
  } else if (kind === CrashKind.Floor) {
    py = 0;
    d2 = s.by > 0 ? s.by * s.by : 0;
  }
  c.kind = kind;
  c.wall = wall;
  c.px = px;
  c.py = py;
  c.d2 = d2;
  s.crash = c;
  s.status = CRASH;
  const k = ev.slot(EV_CRASH, sub);
  if (k >= 0) {
    ev.a[k] = kind;
    ev.b[k] = px;
    ev.c[k] = py;
  }
}

/** One substep with force r.par[3]: integrate, count, then collisions a-e, WallCross, Apex, hold/success, time-up. */
function substep(r: RunCore, ev: SimEvents): void {
  const s = r.s;
  const sub = s.substep + 1;
  const bx0 = s.bx;
  const by0 = s.by;
  const px0 = s.x;
  const w0 = s.w;
  const taut0 = s.mode === TAUT;
  eggHit = false;
  r.par[4] = H;
  if (taut0) tautStep(r, 0, ev, sub);
  else slackStep(r, ev, sub);
  s.substep = sub;

  const bx = s.bx;
  const by = s.by;
  const px = s.x;
  const nW = r.nW;
  const walls = r.walls;

  // proximity of the swept ball centre (this substep's chord) to every wall
  SEG[0] = bx0;
  SEG[1] = by0;
  SEG[2] = bx;
  SEG[3] = by;
  let best = Infinity;
  let bestW = -1;
  let cpx = 0;
  let cpy = 0;
  for (let i = 0; i < nW; i++) {
    segSlabClosestA(SEG, walls[i]!, SOUT);
    const d2 = SOUT[0]!;
    D2[i] = d2;
    if (d2 < best) {
      best = d2;
      bestW = i;
      cpx = SOUT[1]!;
      cpy = SOUT[2]!;
    }
  }
  const near = s.near;
  near.wall = bestW;
  near.d2 = best;
  near.px = cpx;
  near.py = cpy;
  if (best < s.minD2) s.minD2 = best;

  // (a) ball x wall
  if (best < R2) {
    crashAt(r, CrashKind.Ball, bestW, -1, ev, sub);
    return;
  }
  // (b) string x wall (chord pivot -> ball also while slack) and the corner sweep
  STR[0] = px;
  STR[1] = RAIL_Y;
  STR[2] = bx;
  STR[3] = by;
  for (let i = 0; i < nW; i++) {
    const wall = walls[i]!;
    if (segHitsSlabA(STR, wall)) {
      crashAt(r, CrashKind.String, i, -1, ev, sub);
      return;
    }
    for (let k = 0; k < 2; k++) {
      const kx = k === 0 ? wall.x0 : wall.x1;
      const ky = wall.h;
      const s0 = (bx0 - px0) * (ky - RAIL_Y) - (by0 - RAIL_Y) * (kx - px0);
      const s1 = (bx - px) * (ky - RAIL_Y) - (by - RAIL_Y) * (kx - px);
      if ((s0 > 0 && s1 < 0) || (s0 < 0 && s1 > 0)) {
        const ux = bx - px;
        const uy = by - RAIL_Y;
        const t = ((kx - px) * ux + (ky - RAIL_Y) * uy) / (ux * ux + uy * uy);
        if (t >= 0 && t <= 1) {
          crashAt(r, CrashKind.String, i, k, ev, sub);
          return;
        }
      }
    }
  }
  // (c) beam
  if (by + BALL_R >= BEAM_Y) {
    crashAt(r, CrashKind.Beam, -1, -1, ev, sub);
    return;
  }
  // (d) floor
  if (by - BALL_R <= 0) {
    crashAt(r, CrashKind.Floor, -1, -1, ev, sub);
    return;
  }
  // (e) egg (tension / impulse flagged during the integration)
  if (eggHit) {
    crashAt(r, CrashKind.Egg, -1, -1, ev, sub);
    return;
  }

  // WallCross (§4.5)
  for (let i = 0; i < nW; i++) {
    const cx = r.wcx[i]!;
    const bit = 1 << i;
    if (Math.abs(bx - cx) < r.wwin[i]!) {
      if ((s.winIn & bit) === 0) {
        s.winIn |= bit;
        s.winMin[i] = D2[i]!;
      } else if (D2[i]! < s.winMin[i]!) {
        s.winMin[i] = D2[i]!;
      }
    } else {
      s.winIn &= ~bit;
    }
    const a0 = bx0 >= cx;
    const a1 = bx >= cx;
    if (a0 !== a1 && by - BALL_R > walls[i]!.h) {
      const k = ev.slot(EV_WALL_CROSS, sub);
      if (k >= 0) {
        ev.a[k] = i;
        ev.b[k] = a1 ? 1 : -1;
        ev.c[k] = s.winMin[i]!;
      }
    }
  }

  // Apex: omega changed sign during a fully taut substep
  if (taut0 && s.mode === TAUT) {
    const w1 = s.w;
    if ((w0 > 0 && w1 <= 0) || (w0 < 0 && w1 >= 0)) {
      TH[0] = s.th;
      sincosAt(TH, 0, SC);
      const L = r.L;
      const k = ev.slot(EV_APEX, sub);
      if (k >= 0) {
        ev.a[k] = s.th;
        ev.b[k] = 0.5 * L * L * w1 * w1 + G * L * (1 - SC[1]!);
      }
    }
  }

  // hold / success (§4.6)
  const zone = r.zones[s.phase]!;
  let ok = false;
  if (s.mode === TAUT && zone.xa <= bx && bx <= zone.xb && Math.abs(s.v) < REST_V) {
    TH[0] = s.th;
    sincosAt(TH, 0, SC);
    // E = 0.5*L*L*w*w + G*L*(1 - cos(th))  (rules.swingEnergy, written out to keep doubles off call boundaries)
    const L = r.L;
    const w = s.w;
    ok = 0.5 * L * L * w * w + G * L * (1 - SC[1]!) < r.eRest;
  }
  if (ok) {
    if (s.hold === 0) {
      s.holdStart = sub;
      ev.push(EV_HOLD_BEGIN, sub, s.phase, 0, 0);
    }
    s.hold++;
    if (s.hold === HOLD_SUB) {
      if (s.phase === r.nPhases - 1) {
        s.status = SUCCESS;
        s.score = s.holdStart;
        ev.push(EV_SUCCESS, sub, s.score, 0, 0);
        return;
      }
      ev.push(EV_PHASE_DONE, sub, s.phase, s.holdStart, 0);
      s.phase++;
      s.hold = 0;
    }
  } else if (s.hold > 0) {
    ev.push(EV_HOLD_RESET, sub, s.phase, s.hold, 0);
    s.hold = 0;
  }

  // (f) time-up
  if (sub >= MAX_SUB) {
    s.status = TIMEOUT;
    ev.push(EV_TIMEOUT, sub, 0, 0, 0);
  }
}

/**
 * One 60 Hz tick: two substeps with force q*Fmax/127 (stops early on a terminal status).
 * Clears `ev` first, so after the call it holds exactly this tick's events. The first call moves the
 * run from Ready to Running (tick 0). On a finished run it does nothing and returns the final status.
 * q is clamped to [-127, 127] and truncated to an integer like the replay's Int8Array (NaN and -0 count as 0).
 */
export function stepTick(run: Run, q: number, ev: SimEvents): Status {
  ev.clear();
  const r = run as RunCore;
  const s = r.s;
  if (s.status !== READY && s.status !== RUNNING) return s.status;
  s.status = RUNNING;
  // clamp, then truncate to an integer exactly as the replay's Int8Array stores it (NaN and -0 become 0), so a
  // live run and the re-simulation of its replay always see the same force
  const qq = (q > Q_MAX ? Q_MAX : q < -Q_MAX ? -Q_MAX : q) | 0;
  const F = (qq * r.Fmax) / 127; // forceOfQ, written out (no double across a call)
  s.F = F;
  r.par[3] = F;
  const aF = Math.abs(F);
  if (aF > s.peakF) s.peakF = aF;
  const cur = r.cur;
  const prev = r.prev;
  prev.x = cur.x;
  prev.bx = cur.bx;
  prev.by = cur.by;
  prev.mode = cur.mode;
  prev.T = cur.T;
  prev.F = cur.F;
  substep(r, ev);
  if (s.status === RUNNING) substep(r, ev);
  setPose(cur, s);
  return s.status;
}

// ---- test / tooling helpers (not part of the §10.4 contract) --------------------------------------

/** Runs exactly one substep with force F (no tick bookkeeping, `ev` is not cleared). For tests. */
export function substepForTest(run: Run, F: number, ev: SimEvents): Status {
  const r = run as RunCore;
  if (r.s.status === READY) r.s.status = RUNNING;
  r.par[3] = F;
  if (r.s.status === RUNNING) substep(r, ev);
  return r.s.status;
}

/** Puts a run into an arbitrary taut state (ball world state derived), status Running. For tests. */
export function setTautStateForTest(run: Run, x: number, v: number, th: number, w: number, pinned: -1 | 0 | 1 = 0): void {
  const r = run as RunCore;
  const s = r.s;
  s.mode = TAUT;
  s.pinned = pinned;
  s.x = x;
  s.v = v;
  s.th = th;
  s.w = w;
  s.status = RUNNING;
  TH[0] = th;
  sincosAt(TH, 0, SC);
  ballFromTaut(r, SC, 0);
  setPose(r.prev, s);
  setPose(r.cur, s);
}

/** Puts a run into an arbitrary slack state, status Running. For tests. */
export function setSlackStateForTest(run: Run, x: number, v: number, bx: number, by: number, bvx: number, bvy: number,
  pinned: -1 | 0 | 1 = 0): void {
  const r = run as RunCore;
  const s = r.s;
  s.mode = SLACK;
  s.pinned = pinned;
  s.x = x;
  s.v = v;
  s.bx = bx;
  s.by = by;
  s.bvx = bvx;
  s.bvy = bvy;
  s.T = 0;
  s.status = RUNNING;
  setPose(r.prev, s);
  setPose(r.cur, s);
}
