// Motion sources for dev/render-demo.html (GAME_DESIGN.md §11 M4). Owner: O5.
//
// Two ways to produce fake RenderFrames + GameEvents so the renderer can be judged without core /
// input / UI:
//   - TrackRun: kinematic replay of a recorded AI path (x, theta at 60 Hz), with a scripted
//     near-miss (the AI keeps >= 20 mm, the demo "player" pretends to shave a wall so the near-miss
//     art shows).
//   - SimRun: the REAL deterministic simulation (src/sim: createRun / stepTick) driven by the §3.2
//     target servo, with the SimEvents -> GameEvent mapping done the same way as core/session.ts.
//     Crash, rail-end stop, slack and snap therefore show exactly what the game will emit.
import type { LevelDef, LevelPhysics, WallDef } from '../src/sim/level';
import type { GameEvent } from '../src/core/bus';
import type { GhostKind, GhostPose, RenderFrame } from '../src/render/renderer';
import type { CrashKind, PoseSnap, Run } from '../src/sim/run';
import { Mode, Status, createRun } from '../src/sim/run';
import { Ev, SimEvents } from '../src/sim/events';
import { stepTick } from '../src/sim/run';
import { BALL_R as SIM_BALL_R, BEAM_Y, G, HOLD_SUB, Q_MAX, RAIL_Y as SIM_RAIL_Y } from '../src/sim/constants';

export const RAIL_Y = SIM_RAIL_Y;
export const BALL_R = SIM_BALL_R;
const RAD = 180 / Math.PI;

export interface GhostJson {
  kind: string; label: string; hz: 60; n: number; parSub: number; planT: number; x: string; th: string; f: string;
}
export interface GhostFile { ghosts: GhostJson[] }

/** §8.2 channel codec: base64url -> LEB128 varints -> zigzag -> first absolute, then deltas. */
export function decodeChannel(s: string, scale: number): Float64Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64 + '==='.slice((b64.length + 3) % 4);
  const bin = atob(pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const out: number[] = [];
  let acc = 0, shift = 0, cur = 0, prev = 0, first = true;
  for (const byte of bytes) {
    acc += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (byte & 0x80) continue;
    const z = acc;
    acc = 0;
    shift = 0;
    const v = z % 2 === 0 ? z / 2 : -(z + 1) / 2;
    cur = first ? v : prev + v;
    first = false;
    prev = cur;
    out.push(cur / scale);
  }
  return Float64Array.from(out);
}

export interface Track { kind: string; label: string; x: Float64Array; th: Float64Array; parSub: number }

export function decodeTrack(g: GhostJson): Track {
  return { kind: g.kind, label: g.label, x: decodeChannel(g.x, 1e4), th: decodeChannel(g.th, 1e4), parSub: g.parSub };
}

/** Pose of a track at time t (s), stretched by `slow`, delayed by `delay`. */
export function trackPose(tr: Track, t: number, L: number, slow = 1, delay = 0): { x: number; bx: number; by: number } {
  const n = tr.x.length;
  const u = Math.max(0, (t - delay) / slow) * 60;
  const i = Math.min(n - 1, Math.floor(u));
  const j = Math.min(n - 1, i + 1);
  const f = Math.min(1, u - i);
  const x = (tr.x[i] as number) * (1 - f) + (tr.x[j] as number) * f;
  const th = (tr.th[i] as number) * (1 - f) + (tr.th[j] as number) * f;
  return { x, bx: x + L * Math.sin(th), by: RAIL_Y - L * Math.cos(th) };
}

function slabDist(px: number, py: number, w: WallDef): { d: number; qx: number; qy: number } {
  const qx = Math.min(w.x1, Math.max(w.x0, px));
  const qy = Math.min(w.h, Math.max(0, py));
  return { d: Math.hypot(px - qx, py - qy), qx, qy };
}

function reqDegOf(phys: LevelPhysics, w: number): number | null {
  const wall = phys.walls[w];
  if (!wall) return null;
  const c = (RAIL_Y - (wall.h + BALL_R)) / phys.L;
  return c >= 1 ? 0 : Math.acos(Math.max(-1, c)) * RAD;
}

/** The first wall between the ball and the active zone, within 1.2 m (core/session.ts computeNextWall). */
function nextWallOf(phys: LevelPhysics, phase: number, bx: number): number | null {
  if (phys.walls.length === 0) return null;
  const zone = phys.phases[Math.min(phase, phys.phases.length - 1)] as { xa: number; xb: number };
  const zc = (zone.xa + zone.xb) / 2;
  let best: number | null = null, bestD = Infinity;
  phys.walls.forEach((w, i) => {
    const cx = (w.x0 + w.x1) / 2;
    const between = zc > bx ? cx > bx && cx < zc : cx < bx && cx > zc;
    if (!between) return;
    const d = Math.abs(cx - bx);
    if (d < bestD) { best = i; bestD = d; }
  });
  return best !== null && bestD <= 1.2 ? best : null;
}

export interface DemoState {
  t: number; x: number; F: number; status: Status; phase: number; hold: number; targetX: number | null;
}

/** What render-demo.ts needs from a motion source (60 Hz ticks). */
export interface DemoSource {
  readonly phys: LevelPhysics;
  readonly level: LevelDef;
  readonly s: DemoState;
  readonly prev: PoseSnap;
  readonly cur: PoseSnap;
  advance(): GameEvent[];
  ampDeg(): number;
  reqDegNext(bx: number): number | null;
  nextWall(bx: number): number | null;
  near(): { wall: number; gapMm: number; px: number; py: number } | null;
  holdFrac(): number;
  saturated(): boolean;
}

// ---------------------------------------------------------------------------------------------
// Kinematic AI-path replay.

export class TrackRun implements DemoSource {
  readonly phys: LevelPhysics;
  readonly s: DemoState;
  prev: PoseSnap;
  cur: PoseSnap;
  private th = 0;
  private w = 0;
  private lastW = 0;
  private windowMin: number[];
  private sat = 0;
  private endAt = Infinity;
  private tick = -1;
  private readonly restE: number;
  /** Near-miss gap reported on wall crossings (the AI keeps >= 20 mm; the demo shaves it). */
  fakeGapMm = 7.5;

  constructor(readonly level: LevelDef, readonly track: Track, readyTime = 0.6) {
    this.phys = level.physics;
    const p = this.phys;
    this.s = { t: -readyTime, x: p.startX, F: 0, status: Status.Ready, phase: 0, hold: 0, targetX: null };
    this.cur = this.pose();
    this.prev = { ...this.cur };
    this.windowMin = p.walls.map(() => Infinity);
    this.restE = G * p.L * (1 - Math.cos((p.restDeg * Math.PI) / 180));
  }

  private pose(): PoseSnap {
    const L = this.phys.L;
    return { x: this.s.x, bx: this.s.x + L * Math.sin(this.th), by: RAIL_Y - L * Math.cos(this.th), mode: Mode.Taut,
      T: this.phys.m * (G * Math.cos(this.th) + L * this.w * this.w), F: this.s.F };
  }

  ampDeg(): number {
    const L = this.phys.L;
    const E = 0.5 * L * L * this.w * this.w + G * L * (1 - Math.cos(this.th));
    return Math.acos(Math.min(1, Math.max(-1, 1 - E / (G * L)))) * RAD;
  }

  saturated(): boolean {
    return this.sat >= 3;
  }

  advance(): GameEvent[] {
    const ev: GameEvent[] = [];
    const s = this.s, p = this.phys, tr = this.track;
    this.prev = this.cur;
    s.t += 1 / 60;
    if (s.status === Status.Ready) {
      if (s.t < 0) return ev;
      s.status = Status.Running;
      s.t = 0;
      ev.push({ t: 'runStart' });
    }
    if (s.status !== Status.Running) return ev;
    this.tick++;
    const n = tr.x.length;
    const i = Math.min(n - 1, this.tick), i0 = Math.max(0, i - 1), i1 = Math.min(n - 1, i + 1);
    const xa = tr.x[i] as number;
    const ax = ((tr.x[i1] as number) - 2 * xa + (tr.x[i0] as number)) * 3600;
    const va = ((tr.x[i1] as number) - (tr.x[i0] as number)) * 30;
    this.th = tr.th[i] as number;
    this.w = ((tr.th[i1] as number) - (tr.th[i0] as number)) * 30;
    s.x = xa;
    s.F = Math.max(-p.Fmax, Math.min(p.Fmax, (p.M + p.m) * ax + 0.3 * va));
    s.targetX = tr.x[Math.min(n - 1, i + 14)] as number;
    this.cur = this.pose();
    const { bx, by } = this.cur;

    const satNow = Math.abs(s.F) >= p.Fmax * 0.999;
    const was = this.sat >= 3;
    this.sat = satNow ? this.sat + 1 : 0;
    if (!was && this.sat >= 3) ev.push({ t: 'saturate', on: true });
    if (was && this.sat === 0) ev.push({ t: 'saturate', on: false });

    if (Math.sign(this.w) !== Math.sign(this.lastW) && this.lastW !== 0 && Math.abs(this.th) > 3 / RAD) {
      const amp = Math.abs(this.th) * RAD;
      const req = this.reqDegNext(bx);
      ev.push({ t: 'apex', ampDeg: amp, reqDeg: req, reached: req !== null && amp >= req, x: s.x, y: RAIL_Y });
    }
    this.lastW = this.w;

    const pb = this.prev.bx;
    p.walls.forEach((wall, k) => {
      const d = slabDist(bx, by, wall);
      const cx = (wall.x0 + wall.x1) / 2;
      if (Math.abs(bx - cx) < (wall.x1 - wall.x0) / 2 + 0.3) this.windowMin[k] = Math.min(this.windowMin[k] as number, d.d);
      if ((pb - cx) * (bx - cx) < 0 && by - BALL_R > wall.h) {
        const gapMm = Math.min(((this.windowMin[k] as number) - BALL_R) * 1000, this.fakeGapMm);
        ev.push({ t: 'cross', wall: k, dir: bx > pb ? 1 : -1, gapMm, speed: Math.abs(bx - pb) * 60, px: d.qx, py: d.qy });
        this.windowMin[k] = Infinity;
      }
    });

    // Goal hold (the §4.6 rule per tick; 30 ticks = 0.5 s).
    const z = p.phases[s.phase];
    const E = 0.5 * p.L * p.L * this.w * this.w + G * p.L * (1 - Math.cos(this.th));
    const ok = z !== undefined && bx >= z.xa && bx <= z.xb && E < this.restE && Math.abs(va) < 0.05;
    if (ok) {
      if (s.hold === 0) ev.push({ t: 'holdStart', phase: s.phase });
      s.hold++;
      if (s.hold >= 30) {
        if (s.phase + 1 < p.phases.length) {
          ev.push({ t: 'phase', index: s.phase });
          s.phase++;
          s.hold = 0;
        } else {
          s.status = Status.Success;
          ev.push({ t: 'success', score: Math.round(s.t * 120), medal: 2, crown: false, firstCrown: false, pb: true, badges: [] });
        }
      }
    } else if (s.hold > 0) {
      ev.push({ t: 'holdReset', phase: s.phase, frac: s.hold / 30 });
      s.hold = 0;
    }
    if (this.endAt === Infinity && this.tick >= n) this.endAt = s.t + 3;
    if (s.status === Status.Running && s.t > Math.min(this.endAt, 30)) {
      s.status = Status.Timeout;
      ev.push({ t: 'timeout', reason: 'swing', value: this.ampDeg() });
    }
    return ev;
  }

  reqDegNext(bx: number): number | null {
    const w = this.nextWall(bx);
    return w === null ? null : reqDegOf(this.phys, w);
  }

  nextWall(bx: number): number | null {
    return nextWallOf(this.phys, this.s.phase, bx);
  }

  near(): { wall: number; gapMm: number; px: number; py: number } | null {
    const { bx, by } = this.cur;
    let best: { wall: number; gapMm: number; px: number; py: number } | null = null;
    this.phys.walls.forEach((w, i) => {
      const d = slabDist(bx, by, w);
      const gap = (d.d - BALL_R) * 1000;
      if (!best || gap < best.gapMm) best = { wall: i, gapMm: gap, px: d.qx, py: d.qy };
    });
    return best !== null && (best as { gapMm: number }).gapMm <= 250 ? best : null;
  }

  holdFrac(): number {
    return this.s.status === Status.Success ? 1 : Math.min(1, this.s.hold / 30);
  }
}

// ---------------------------------------------------------------------------------------------
// The real simulation + §3.2 servo.

/** §3.2 target servo -> quantised q. */
export function servoQ(phys: LevelPhysics, x: number, v: number, xt: number): number {
  const kv = (20 / 3) * (phys.M + phys.m);
  const vcmd = Math.max(-4, Math.min(4, 5 * (xt - x)));
  const F = Math.max(-phys.Fmax, Math.min(phys.Fmax, kv * (vcmd - v)));
  return Math.max(-Q_MAX, Math.min(Q_MAX, Math.round((F * Q_MAX) / phys.Fmax)));
}

export class SimRun implements DemoSource {
  readonly phys: LevelPhysics;
  readonly s: DemoState;
  private readonly run: Run;
  private readonly ev = new SimEvents();
  private started = false;
  private satRun = 0;
  private sat = false;
  private reachedWall = -1;
  private ticks = 0;

  constructor(readonly level: LevelDef, readonly target: (t: number) => number, readyTime = 0.6) {
    this.phys = level.physics;
    this.run = createRun(this.phys);
    this.s = { t: -readyTime, x: this.phys.startX, F: 0, status: Status.Ready, phase: 0, hold: 0, targetX: null };
  }

  get prev(): PoseSnap { return this.run.prev; }
  get cur(): PoseSnap { return this.run.cur; }

  saturated(): boolean {
    return this.sat;
  }

  ampDeg(): number {
    const r = this.run.s, L = this.phys.L;
    if (r.mode !== Mode.Taut) return 0;
    const E = 0.5 * L * L * r.w * r.w + G * L * (1 - Math.cos(r.th));
    return Math.acos(Math.min(1, Math.max(-1, 1 - E / (G * L)))) * RAD;
  }

  advance(): GameEvent[] {
    const out: GameEvent[] = [];
    const s = this.s, r = this.run.s, p = this.phys;
    s.t += 1 / 60;
    if (s.status !== Status.Ready && s.status !== Status.Running) return out;
    if (s.t < 0) return out;
    const xt = this.target(s.t);
    s.targetX = xt;
    const q = servoQ(p, r.x, r.v, xt);
    if (!this.started) {
      if (q === 0) return out;
      this.started = true;
      s.t = 0;
      out.push({ t: 'runStart' });
    }
    if (this.ticks >= 7200) return out;
    const tautBefore = r.mode === Mode.Taut;
    stepTick(this.run, q, this.ev);
    this.ticks++;
    // Saturation: |q| = 127 for >= 3 ticks (§3.4).
    if (Math.abs(q) === Q_MAX) {
      this.satRun++;
      if (this.satRun >= 3 && !this.sat) {
        this.sat = true;
        out.push({ t: 'saturate', on: true });
      }
    } else {
      this.satRun = 0;
      if (this.sat) {
        this.sat = false;
        out.push({ t: 'saturate', on: false });
      }
    }
    this.mapEvents(out, tautBefore);
    s.x = r.x;
    s.F = r.F;
    s.status = r.status;
    s.phase = r.phase;
    s.hold = r.hold;
    return out;
  }

  /** SimEvents -> GameEvent, as core/session.ts processEvents does. */
  private mapEvents(out: GameEvent[], tautBefore: boolean): void {
    const ev = this.ev, r = this.run.s, p = this.phys;
    let taut = tautBefore;
    for (let k = 0; k < ev.n; k++) {
      const kind = ev.kind[k] as Ev, a = ev.a[k] as number, b = ev.b[k] as number, c = ev.c[k] as number;
      switch (kind) {
        case Ev.Snap: out.push({ t: 'snap', J: a, x: b, y: c }); break;
        case Ev.SlackBegin: out.push({ t: 'slack', x: b, y: c }); break;
        case Ev.StopHit: {
          // D5 (as core): feedback from 0.1 m/s only; c = 0 on a taut string also means it went slack there.
          const wentSlack = c === 0 && taut;
          if (c === 0) taut = false;
          if (b < 0.1) break;
          out.push({ t: 'stop', side: a < 0 ? -1 : 1, speed: b });
          if (wentSlack) out.push({ t: 'slack', x: r.bx, y: r.by });
          break;
        }
        case Ev.WallCross: {
          if (r.status === Status.Crash) break;
          const wall = a, w = p.walls[wall];
          const gapMm = Number.isFinite(c) ? (Math.sqrt(Math.max(0, c)) - BALL_R) * 1000 : Infinity;
          const nearHere = r.near.wall === wall;
          out.push({
            t: 'cross', wall, dir: b > 0 ? 1 : -1, gapMm, speed: Math.hypot(r.bvx, r.bvy),
            px: nearHere ? r.near.px : w ? (w.x0 + w.x1) / 2 : r.bx, py: nearHere ? r.near.py : w ? w.h : r.by,
          });
          break;
        }
        case Ev.Apex: {
          const amp = Math.abs(a) * RAD;
          if (amp <= 3) break;
          const nw = nextWallOf(p, r.phase, r.bx);
          const req = nw !== null ? reqDegOf(p, nw) : null;
          const reached = req !== null && nw !== null && amp >= req && this.reachedWall !== nw;
          if (reached) this.reachedWall = nw;
          out.push({ t: 'apex', ampDeg: amp, reqDeg: req, reached, x: r.x, y: RAIL_Y });
          break;
        }
        case Ev.HoldBegin: out.push({ t: 'holdStart', phase: a }); break;
        case Ev.HoldReset: out.push({ t: 'holdReset', phase: a, frac: Math.min(1, b / HOLD_SUB) }); break;
        case Ev.PhaseDone: out.push({ t: 'phase', index: a }); this.reachedWall = -1; break;
        case Ev.Success:
          out.push({ t: 'success', score: a, medal: 2, crown: false, firstCrown: false, pb: true, badges: [] });
          break;
        case Ev.Crash: {
          const ck = a as CrashKind;
          const info = r.crash;
          const d2 = info ? info.d2 : 0;
          const overlapMm = ck === 1 ? Math.max(0, (BALL_R - Math.sqrt(Math.max(0, d2))) * 1000)
            : ck === 3 ? Math.max(0, (r.by + BALL_R - BEAM_Y) * 1000)
              : ck === 4 ? Math.max(0, (BALL_R - r.by) * 1000) : 0;
          out.push({ t: 'crash', kind: ck, wall: info ? info.wall : -1, x: b, y: c, overlapMm });
          break;
        }
        case Ev.Timeout: out.push({ t: 'timeout', reason: 'swing', value: this.ampDeg() }); break;
        default: break;
      }
    }
  }

  reqDegNext(bx: number): number | null {
    const w = this.nextWall(bx);
    return w === null ? null : reqDegOf(this.phys, w);
  }

  nextWall(bx: number): number | null {
    return nextWallOf(this.phys, this.run.s.phase, bx);
  }

  near(): { wall: number; gapMm: number; px: number; py: number } | null {
    const n = this.run.s.near;
    if (n.wall < 0 || !Number.isFinite(n.d2)) return null;
    const gapMm = (Math.sqrt(n.d2) - BALL_R) * 1000;
    return gapMm <= 250 ? { wall: n.wall, gapMm, px: n.px, py: n.py } : null;
  }

  holdFrac(): number {
    return this.run.s.status === Status.Success ? 1 : Math.min(1, this.run.s.hold / HOLD_SUB);
  }
}

export interface GhostSpec { kind: GhostKind; label: string; track: Track; slow: number; delay: number }

export function frameOf(run: DemoSource, ghosts: GhostSpec[], alpha: number, opts: { showAiLine: boolean; showMargin: boolean }): RenderFrame {
  const L = run.phys.L;
  const tGhost = Math.max(0, run.s.t);
  const poses: GhostPose[] = ghosts.map((g) => {
    const p = run.s.status === Status.Ready ? trackPose(g.track, 0, L) : trackPose(g.track, tGhost, L, g.slow, g.delay);
    return { kind: g.kind, label: g.label, x: p.x, bx: p.bx, by: p.by, slack: false, visible: true };
  });
  const bx = run.cur.bx;
  const running = run.s.status === Status.Running;
  return {
    alpha, prev: run.prev, cur: run.cur, L,
    ghosts: poses,
    targetX: run.s.status === Status.Ready ? null : run.s.targetX,
    F: run.s.F, Fmax: run.phys.Fmax, saturated: running && run.saturated(),
    near: run.near(),
    holdFrac: run.holdFrac(), ampDeg: run.ampDeg(), reqDeg: running ? run.reqDegNext(bx) : null, nextWall: running ? run.nextWall(bx) : null,
    timeScale: 1, status: run.s.status, showAiLine: opts.showAiLine, showMargin: opts.showMargin,
  };
}
