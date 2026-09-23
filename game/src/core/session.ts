// One level session: run, replay recording, sim events -> GameEvents (GAME_DESIGN.md §4.6-§4.8, §7.3, §7.6, §9.4, §9.5). Owner: O3.
//
// READY: the world is static; tick(q) with q == 0 does nothing. The first tick with q != 0 is tick 0
// (runStart). RUNNING: every tick steps the sim, records q and the pose, and turns the tick's SimEvents
// into bus events. A terminal status (Success / Crash / Timeout) freezes the run until retry().
// retry() resets in place (no allocation, no scene rebuild): the < 100 ms retry of §1.3.
//
// Display-side code: Math.sqrt / acos are fine here (never fed back into the simulation).
import type { LevelDef } from '../sim/level';
import { BALL_R, BEAM_Y, G, HOLD_SUB, MAX_SUB, Q_MAX, RAIL_Y, REST_V } from '../sim/constants';
import { Ev, SimEvents } from '../sim/events';
import {
  CrashKind, Mode, Status, copyState, createRun, newSimState, resetRun, restoreState, stepTick, type Run, type SimState,
} from '../sim/run';
import { DeviceTag, ReplayFlag, encodeReplay } from '../sim/replay';
import { b64urlEncode } from '../sim/b64';
import { levelHash } from '../sim/level';
import { SIM_VERSION } from '../sim/constants';
import { levelFacts } from '../sim/display';
import type { InputFrame } from '../input/types';
import type { GameEvent } from './bus';
import { createBadgeTracker, amplitudeDeg, type BadgeTracker, type TrickId } from './badges';
import { createSplitTracker, type SplitTracker } from './splits';
import { createTrackRecorder, startPose, strobe, type GhostTrack, type TrackRecorder } from './ghosts';

export const MAX_TICKS = MAX_SUB / 2;               // 3600
export const NEAR_MISS_MM = 40;                     // §9.5 near-miss tiers start below 40 mm
export const SLOWMO_GAP_M = 0.020;                  // slow-mo while the gap shrinks below 20 mm
export const SLOWMO_RESET_GAP_M = 0.10;             // leaving the wall re-arms the slow-mo
export const GAUGE_RANGE_M = 0.25;                  // the gap gauge shows within 25 cm (§9.3)
export const APEX_MIN_DEG = 3;                      // apex ticks only above 3 deg (§9.5)
export const NEXT_WALL_RANGE_M = 1.2;               // the required-angle arc shows within 1.2 m (§9.3)
export const SATURATE_TICKS = 3;                    // |q| = 127 for >= 3 ticks (§3.4)
export const REWIND_TICKS = 300;                    // practice rewind: 5 s ring (§3.5)
/** StopHit feedback gate (D5): slower end-stop bumps (a trolley creeping into the stop) emit nothing. */
export const STOP_FX_MIN_SPEED = 0.1;               // m/s

const RAD = 180 / Math.PI;

export interface TimeoutInfo { reason: 'swing' | 'speed' | 'zone' | 'none'; value: number }

/** What a finished run leaves behind (app.ts turns it into progress, results and submissions). */
export interface RunResult {
  status: Status;                 // Success / Crash / Timeout
  score: number | null;           // Success only (1/120 s)
  ticks: number;                  // ticks since tick 0 (= replay nTicks)
  substep: number;
  minD2: number;
  gapMm: number;                  // min clearance in mm over the run; NaN on levels without walls
  peakF: number;
  crash: SimState['crash'];
  timeout: TimeoutInfo | null;
  device: DeviceTag;
  flags: number;
  splits: number[];
  tricks: TrickId[];
}

export interface SessionOptions {
  level: LevelDef;
  emit: (e: GameEvent) => void;
  /** The comparison ghost for split deltas (§7.6), looked up when a split is reached. */
  compare?: () => GhostTrack | null;
  /** Near-miss slow-mo request (the app applies it unless reduced motion). */
  onSlowMo?: () => void;
  /** Tricks found this run (the app filters the ones already seen and toasts). */
  onTrick?: (t: TrickId) => void;
}

export interface Session {
  readonly level: LevelDef;
  readonly run: Run;
  readonly events: SimEvents;
  readonly recorder: TrackRecorder;
  readonly badges: BadgeTracker;
  /** Tick 0 has happened. */
  readonly started: boolean;
  /** Ticks since tick 0. */
  readonly ticks: number;
  status(): Status;
  /** Advances one tick with quantised force q; returns the sim status. frame supplies the device tag and flags. */
  tick(q: number, frame?: InputFrame | null): Status;
  retry(): void;
  /** Recorded q per tick since tick 0. */
  replayQs(): Int8Array;
  /** base64url replay of this run, or null (over 6 KB, not started). */
  replay(): string | null;
  result(): RunResult | null;
  /** Player's own track (for the PB ghost and the results graphs). */
  track(label?: string): GhostTrack;
  strobe(): Float32Array;
  // per-frame readouts
  ampDeg(): number;
  saturated(): boolean;
  nearGapMm(): number | null;
  nextWall(): number | null;
  reqDeg(): number | null;
  holdFrac(): number;
  // practice (§3.5)
  practice: boolean;
  assisted: boolean;
  /**
   * Practice rewind by up to 5 s of a running run or of one that just ended in a crash / time-up (it runs again
   * from there). Returns false when not possible. Rewound runs have no replay.
   */
  rewind(seconds: number): boolean;
}

function reqDegFallback(level: LevelDef): number[] {
  const p = level.physics;
  return p.walls.map((w) => {
    const c = (RAIL_Y - (w.h + BALL_R)) / p.L;
    return c >= 1 ? 0 : c <= -1 ? 180 : Math.acos(c) * RAD;
  });
}

export function createSession(level: LevelDef, opts: Omit<SessionOptions, 'level'> = { emit: () => {} }): Session {
  const phys = level.physics;
  const L = phys.L;
  const walls = phys.walls;
  const wcx = walls.map((w) => (w.x0 + w.x1) / 2);
  let reqDegs: number[];
  try {
    reqDegs = levelFacts(phys).reqDeg;
    if (!Array.isArray(reqDegs) || reqDegs.length !== walls.length) reqDegs = reqDegFallback(level);
  } catch {
    reqDegs = reqDegFallback(level);
  }
  const eRest = G * L * (1 - Math.cos((phys.restDeg * Math.PI) / 180));
  const hash = levelHash(phys);

  const run = createRun(phys);
  const ev = new SimEvents();
  const qs = new Int8Array(MAX_TICKS);
  const recorder = createTrackRecorder(level);
  const badges = createBadgeTracker(level);
  const splits: SplitTracker = createSplitTracker(level);
  const emit = opts.emit;

  let started = false;
  let ticks = 0;
  let satRun = 0;
  let saturated = false;
  let ampDeg = 0;
  let deviceMask = 0;
  let flags = 0;
  let prevGap = Infinity;
  let slowmoArmed = true;
  let slowmoWall = -1;
  let reachedWall = -1;
  let nextWall: number | null = null;
  let result: RunResult | null = null;
  let tricks: TrickId[] = [];
  let rewound = false;
  // practice rewind ring (allocated on first use)
  let ring: SimState[] | null = null;
  let ringTicks: Int32Array | null = null;

  const s = run.s;

  function computeNextWall(): number | null {
    if (walls.length === 0) return null;
    const zone = phys.phases[Math.min(s.phase, phys.phases.length - 1)]!;
    const zc = (zone.xa + zone.xb) / 2;
    const bx = s.bx;
    let best: number | null = null;
    let bestD = Infinity;
    for (let i = 0; i < walls.length; i++) {
      const cx = wcx[i]!;
      const between = zc > bx ? cx > bx && cx < zc : cx < bx && cx > zc;
      if (!between) continue;
      const d = Math.abs(cx - bx);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best !== null && bestD <= NEXT_WALL_RANGE_M ? best : null;
  }

  function gapM(): number {
    return walls.length > 0 && Number.isFinite(s.near.d2) ? Math.sqrt(s.near.d2) - BALL_R : Infinity;
  }

  function deviceTag(): DeviceTag {
    const bits = deviceMask;
    if (bits === 0) return DeviceTag.Unknown;
    if ((bits & (bits - 1)) !== 0) return DeviceTag.Mixed;
    for (let d = 1; d <= 4; d++) if (bits === 1 << d) return d as DeviceTag;
    return DeviceTag.Unknown;
  }

  function timeoutInfo(): TimeoutInfo {
    const zone = phys.phases[Math.min(s.phase, phys.phases.length - 1)]!;
    if (s.mode !== Mode.Taut) return { reason: 'none', value: 0 };
    if (s.bx < zone.xa || s.bx > zone.xb) return { reason: 'zone', value: s.bx };
    const E = 0.5 * L * L * s.w * s.w + G * L * (1 - Math.cos(s.th));
    if (E >= eRest) return { reason: 'swing', value: amplitudeDeg(s.th, s.w, L) };
    if (Math.abs(s.v) >= REST_V) return { reason: 'speed', value: Math.abs(s.v) };
    return { reason: 'none', value: 0 };
  }

  function overlapMm(kind: CrashKind, d2: number, by: number): number {
    switch (kind) {
      case CrashKind.Ball: return Math.max(0, (BALL_R - Math.sqrt(Math.max(0, d2))) * 1000);
      case CrashKind.Beam: return Math.max(0, (by + BALL_R - BEAM_Y) * 1000);
      case CrashKind.Floor: return Math.max(0, (BALL_R - by) * 1000);
      default: return 0;
    }
  }

  function finish(st: Status): void {
    const minD2 = s.minD2;
    result = {
      status: st,
      score: st === Status.Success ? s.score : null,
      ticks,
      substep: s.substep,
      minD2,
      gapMm: walls.length > 0 && Number.isFinite(minD2) ? (Math.sqrt(minD2) - BALL_R) * 1000 : NaN,
      peakF: s.peakF,
      crash: s.crash ? { ...s.crash } : null,
      timeout: st === Status.Timeout ? timeoutInfo() : null,
      device: deviceTag(),
      flags,
      splits: splits.times(),
      tricks: tricks.slice(),
    };
  }

  /** tautBefore: the string was taut when the tick began (tracks whether a StopHit with c = 0 made it slack). */
  function processEvents(tautBefore: boolean): void {
    const crashed = s.status === Status.Crash;
    let taut = tautBefore;
    for (let k = 0; k < ev.n; k++) {
      const kind = ev.kind[k]!;
      const sub = ev.sub[k]!;
      const a = ev.a[k]!;
      const b = ev.b[k]!;
      const c = ev.c[k]!;
      switch (kind) {
        case Ev.SlackBegin:
          taut = false;
          emit({ t: 'slack', x: b, y: c });
          break;
        case Ev.Snap:
          taut = true;
          emit({ t: 'snap', J: a, x: b, y: c });
          break;
        case Ev.StopHit: {
          // D5: feedback only from 0.1 m/s. c = 0 on a string that was taut: the stop threw the ball and the
          // string went slack right there (the sim emits no SlackBegin for that). A StopHit during slack flight
          // also has c = 0 but the string was already slack: no second 'slack'.
          const wentSlack = c === 0 && taut;
          if (c === 0) taut = false;
          if (b < STOP_FX_MIN_SPEED) break;
          emit({ t: 'stop', side: a < 0 ? -1 : 1, speed: b });
          if (wentSlack) emit({ t: 'slack', x: s.bx, y: s.by });
          break;
        }
        case Ev.WallCross: {
          const wall = a;
          const dir: 1 | -1 = b > 0 ? 1 : -1;
          const gapMm = Number.isFinite(c) ? (Math.sqrt(Math.max(0, c)) - BALL_R) * 1000 : Infinity;
          const idx = splits.onWallCross(wall, dir, sub);
          if (!crashed) {
            const w = walls[wall];
            const nearHere = s.near.wall === wall;
            emit({
              t: 'cross', wall, dir, gapMm, speed: Math.hypot(s.bvx, s.bvy),
              px: nearHere ? s.near.px : w ? wcx[wall]! : s.bx, py: nearHere ? s.near.py : w ? w.h : s.by,
            });
          }
          if (idx >= 0) emitSplit(idx, sub);
          break;
        }
        case Ev.Apex: {
          const amp = Math.abs(a) * RAD;
          if (amp <= APEX_MIN_DEG) break;
          const nw = nextWall;
          const req = nw !== null ? reqDegs[nw] ?? null : null;
          let reached = false;
          if (req !== null && nw !== null && amp >= req && reachedWall !== nw) {
            reached = true;
            reachedWall = nw;
          }
          emit({ t: 'apex', ampDeg: amp, reqDeg: req, reached, x: s.x, y: RAIL_Y });
          break;
        }
        case Ev.HoldBegin:
          emit({ t: 'holdStart', phase: a });
          break;
        case Ev.HoldReset:
          emit({ t: 'holdReset', phase: a, frac: Math.min(1, b / HOLD_SUB) });
          break;
        case Ev.PhaseDone: {
          emit({ t: 'phase', index: a });
          const idx = splits.onPhaseDone(a, b);
          if (idx >= 0) emitSplit(idx, b);
          reachedWall = -1;
          break;
        }
        case Ev.Crash: {
          const ck = a as CrashKind;
          const info = s.crash;
          emit({
            t: 'crash', kind: ck, wall: info ? info.wall : -1, x: b, y: c,
            overlapMm: overlapMm(ck, info ? info.d2 : 0, s.by),
          });
          break;
        }
        case Ev.Timeout: {
          const ti = timeoutInfo();
          emit({ t: 'timeout', reason: ti.reason, value: ti.value });
          break;
        }
        default:
          break; // Success is announced by the app (it needs the medal / PB / badges)
      }
    }
  }

  function emitSplit(index: number, sub: number): void {
    const g = opts.compare?.() ?? null;
    if (!g) return;
    const gs = g.splitSub[index];
    if (gs === undefined || !Number.isFinite(gs)) return;
    emit({ t: 'split', index, deltaSub: sub - gs, vs: g.kind });
  }

  function reset(): void {
    resetRun(run);
    ev.clear();
    started = false;
    ticks = 0;
    satRun = 0;
    saturated = false;
    ampDeg = 0;
    deviceMask = 0;
    flags = 0;
    prevGap = gapM();
    slowmoArmed = true;
    slowmoWall = -1;
    reachedWall = -1;
    result = null;
    tricks = [];
    rewound = false;
    ringTicks?.fill(-1); // never rewind into the previous run
    badges.reset();
    splits.reset();
    recorder.begin(startPose(level));
    nextWall = computeNextWall();
  }

  const session: Session = {
    level,
    run,
    events: ev,
    recorder,
    badges,
    practice: false,
    assisted: false,
    get started() {
      return started;
    },
    get ticks() {
      return ticks;
    },
    status: () => s.status,

    tick(q, frame) {
      const st0 = s.status;
      if (st0 !== Status.Ready && st0 !== Status.Running) return st0;
      const qq = Math.max(-Q_MAX, Math.min(Q_MAX, Math.round(Number.isFinite(q) ? q : 0)));
      if (!started) {
        if (qq === 0) return Status.Ready;
        started = true;
        ticks = 0;
        recorder.begin(startPose(level));
        emit({ t: 'runStart' });
      }
      if (ticks >= MAX_TICKS) return s.status;

      if (ring && ringTicks && session.practice) {
        const slot = ticks % REWIND_TICKS;
        copyState(s, ring[slot]!);
        ringTicks[slot] = ticks;
      }

      const tautBefore = s.mode === Mode.Taut;
      const st = stepTick(run, qq, ev);
      qs[ticks] = qq;
      ticks++;

      if (frame) {
        if (frame.device > 0 && frame.device < 5) deviceMask |= 1 << frame.device;
        else if (frame.device === 5) deviceMask |= 0b110;
        if (frame.intent.kind === 'force') flags |= ReplayFlag.DirectForce;
      }
      if (session.practice) flags |= ReplayFlag.Practice;
      if (session.assisted) flags |= ReplayFlag.Assisted;

      recorder.push(s, ev);
      if (s.mode === Mode.Taut) ampDeg = amplitudeDeg(s.th, s.w, L);
      nextWall = computeNextWall();

      // saturation (|q| = 127 for >= 3 ticks)
      if (Math.abs(qq) === Q_MAX) {
        satRun++;
        if (satRun >= SATURATE_TICKS && !saturated) {
          saturated = true;
          emit({ t: 'saturate', on: true });
        }
      } else {
        satRun = 0;
        if (saturated) {
          saturated = false;
          emit({ t: 'saturate', on: false });
        }
      }

      processEvents(tautBefore);

      const found = badges.onTick(s, ev);
      for (let k = 0; k < found.length; k++) {
        const t = found[k]!;
        tricks.push(t);
        opts.onTrick?.(t);
      }

      // near-miss slow-mo: once per wall pass, while the gap shrinks below 20 mm (§9.5).
      // A pass ends when the ball moves away (> 10 cm) or another wall becomes the nearest one.
      const g = gapM();
      if (walls.length > 0) {
        if (s.near.wall !== slowmoWall) {
          slowmoWall = s.near.wall;
          slowmoArmed = true;
        }
        if (g > SLOWMO_RESET_GAP_M) slowmoArmed = true;
        if (st === Status.Running && slowmoArmed && g < SLOWMO_GAP_M && g < prevGap) {
          slowmoArmed = false;
          opts.onSlowMo?.();
        }
      }
      prevGap = g;

      if (st !== Status.Running) {
        if (saturated) {
          saturated = false;
          emit({ t: 'saturate', on: false });
        }
        finish(st);
      }
      return st;
    },

    retry: reset,

    replayQs: () => qs.slice(0, ticks),

    replay() {
      if (!started || ticks === 0 || rewound) return null;
      try {
        const bytes = encodeReplay(
          { fmt: 1, sim: SIM_VERSION, levelHash: hash, device: deviceTag(), flags, nTicks: ticks },
          qs.subarray(0, ticks),
        );
        return b64urlEncode(bytes);
      } catch {
        return null; // over REPLAY_MAX_BYTES: PB only, no submission / challenge (§10.4)
      }
    },

    result: () => result,

    track(label = 'PB') {
      return recorder.finish('pb', label, result?.score ?? null);
    },

    strobe() {
      const t = recorder.finish('pb', '', null);
      return strobe(t);
    },

    ampDeg: () => ampDeg,
    saturated: () => saturated,
    nearGapMm() {
      const g = gapM();
      return g <= GAUGE_RANGE_M ? g * 1000 : null;
    },
    nextWall: () => nextWall,
    reqDeg: () => (nextWall !== null ? reqDegs[nextWall] ?? null : null),
    holdFrac: () => Math.min(1, s.hold / HOLD_SUB),

    rewind(seconds) {
      if (!session.practice) return false;
      if (!ring || !ringTicks) {
        // The first call (enableRewind, at READY) allocates the ring; it fills tick by tick from then on.
        ring = [];
        for (let i = 0; i < REWIND_TICKS; i++) ring.push(newSimState());
        ringTicks = new Int32Array(REWIND_TICKS).fill(-1);
        return false;
      }
      // a running run, or one that just crashed / timed out (the ring still holds the ticks before the end)
      if (!started || (s.status !== Status.Running && s.status !== Status.Crash && s.status !== Status.Timeout)) return false;
      const back = Math.max(1, Math.min(REWIND_TICKS, Math.round(seconds * 60)));
      let target = Math.max(0, ticks - back);
      // fall forward to the oldest state still in the ring
      while (target < ticks && ringTicks[target % REWIND_TICKS] !== target) target++;
      if (target >= ticks) return false;
      restoreState(run, ring[target % REWIND_TICKS]!);
      // the tick-0 entry was taken before tick 0 ran (status Ready): the rewound run is still under way
      if ((s.status as Status) === Status.Ready) s.status = Status.Running;
      ticks = target;
      recorder.truncate(target + 1);
      splits.truncate(s.substep);
      rewound = true;
      result = null;
      prevGap = gapM();
      if (s.mode === Mode.Taut) ampDeg = amplitudeDeg(s.th, s.w, L);
      nextWall = computeNextWall();
      return true;
    },
  };

  reset();
  return session;
}

/** Enables the practice rewind ring (allocates it once; call when practice starts). */
export function enableRewind(sess: Session): void {
  sess.rewind(0);
}
