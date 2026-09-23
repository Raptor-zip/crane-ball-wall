// Ghost tracks: AI ghosts from JSON, player ghosts from replays (GAME_DESIGN.md §8.4, §10.4 "ゴースト"). Owner: O3.
//
// A track is sampled at 60 Hz from the player's tick 0: sample k is the state at t = k/60 s
// (sample 0 = the start pose). f[k] is the force held during [k/60, (k+1)/60).
// Display-only: may use Math.sin / cos.
import type { LevelDef } from '../sim/level';
import type { GhostKind, GhostPose } from '../render/renderer';
import { RAIL_Y } from '../sim/constants';
import { Ev, type SimEvents } from '../sim/events';
import { Mode, Status, type SimState } from '../sim/run';
import { decodeReplay, simulateReplay } from '../sim/replay';
import { b64urlDecode } from '../sim/b64';
import { decodeChannelValues } from './ghostcodec';
import { createSplitTracker, type SplitTracker } from './splits';

export interface GhostTrack {
  kind: GhostKind; label: string; n: number; hz: 60;
  x: Float32Array; bx: Float32Array; by: Float32Array; slack: Uint8Array; f: Float32Array;
  finishSub: number | null; splitSub: number[] /* in level.splits order, NaN when not reached */;
}
export interface AiGhostJson {
  kind: 'ai' | 'calm' | 'research_fast' | 'research_pump'; label: string; hz: 60; n: number; parSub: number; planT: number;
  peakF: number; minGapMm: number; maxThetaDeg: number; pumps: number; splitSub: number[]; x: string; th: string; f: string;
}
/** src/data/ghosts/<id>.json (§8.2 "ゴーストファイルの形式"). */
export interface GhostFileJson { format: 1; levelId: string; physics: unknown; ghosts: AiGhostJson[] }

export const GHOST_HZ = 60;

function splitsFromJson(raw: readonly (number | null)[] | undefined, count: number): number[] {
  const out = new Array<number>(count).fill(NaN);
  if (!raw) return out;
  for (let i = 0; i < count && i < raw.length; i++) {
    const v = raw[i];
    out[i] = typeof v === 'number' && Number.isFinite(v) ? v : NaN;
  }
  return out;
}

/** Decodes channels; ball positions via Math.sin/cos (display only). splitSub and finishSub (= parSub) come from the JSON. */
export function trackFromAiGhost(g: AiGhostJson, L: number, level: LevelDef): GhostTrack {
  const xs = decodeChannelValues(g.x, 'x');
  const ths = decodeChannelValues(g.th, 'th');
  const fs = g.f ? decodeChannelValues(g.f, 'f') : new Float64Array(0);
  const n = Math.min(xs.length, ths.length, g.n > 0 ? g.n : Infinity);
  const x = new Float32Array(n);
  const bx = new Float32Array(n);
  const by = new Float32Array(n);
  const f = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const xk = xs[k]!;
    const th = ths[k]!;
    x[k] = xk;
    bx[k] = xk + L * Math.sin(th);
    by[k] = RAIL_Y - L * Math.cos(th);
    f[k] = k < fs.length ? fs[k]! : 0;
  }
  return {
    kind: g.kind, label: g.label, n, hz: 60, x, bx, by, slack: new Uint8Array(n), f,
    finishSub: Number.isFinite(g.parSub) ? g.parSub : null,
    splitSub: splitsFromJson(g.splitSub, level.splits?.length ?? 0),
  };
}

// ------------------------------------------------------------------------------------ recording

/** Records a run tick by tick into preallocated buffers (no allocation per tick). Used by the session and trackFromReplay. */
export interface TrackRecorder {
  /** Clears and stores sample 0 (the start pose). */
  begin(s: SimState): void;
  /** Stores the pose after one tick and feeds WallCross / PhaseDone events to the split tracker. */
  push(s: SimState, ev: SimEvents | null): void;
  readonly n: number;
  /** Drops samples after the first n (practice rewind). */
  truncate(n: number): void;
  splits(): number[];
  /** Copies the recorded samples into a new GhostTrack. */
  finish(kind: GhostKind, label: string, finishSub: number | null): GhostTrack;
}

/** 60 s of ticks + the start sample. */
export const MAX_TRACK_SAMPLES = 3601;

export function createTrackRecorder(level: LevelDef, capacity = MAX_TRACK_SAMPLES): TrackRecorder {
  const x = new Float32Array(capacity);
  const bx = new Float32Array(capacity);
  const by = new Float32Array(capacity);
  const f = new Float32Array(capacity);
  const slack = new Uint8Array(capacity);
  const splits: SplitTracker = createSplitTracker(level);
  let n = 0;

  const put = (s: SimState): void => {
    if (n >= capacity) return;
    x[n] = s.x;
    bx[n] = s.bx;
    by[n] = s.by;
    slack[n] = s.mode === Mode.Slack ? 1 : 0;
    f[n] = 0;
    if (n > 0) f[n - 1] = s.F; // the force of the tick that led here
    n++;
  };

  return {
    begin(s) {
      n = 0;
      splits.reset();
      put(s);
    },
    push(s, ev) {
      put(s);
      if (!ev) return;
      for (let k = 0; k < ev.n; k++) {
        const kind = ev.kind[k]!;
        if (kind === Ev.WallCross) splits.onWallCross(ev.a[k]!, ev.b[k]! > 0 ? 1 : -1, ev.sub[k]!);
        else if (kind === Ev.PhaseDone) splits.onPhaseDone(ev.a[k]!, ev.b[k]!);
      }
    },
    get n() {
      return n;
    },
    truncate(k) {
      if (k >= 1 && k < n) {
        n = k;
        splits.truncate(2 * (k - 1)); // sample k - 1 is the state at substep 2 (k - 1)
      }
    },
    splits() {
      return splits.times();
    },
    finish(kind, label, finishSub) {
      return {
        kind, label, n, hz: 60,
        x: x.slice(0, n), bx: bx.slice(0, n), by: by.slice(0, n), slack: slack.slice(0, n), f: f.slice(0, n),
        finishSub, splitSub: splits.times(),
      };
    },
  };
}

/** The start pose of a level as a SimState-like object (sample 0 before any tick). */
export function startPose(level: LevelDef): SimState {
  const p = level.physics;
  return {
    mode: Mode.Taut, pinned: 0, x: p.startX, v: 0, th: 0, w: 0, bx: p.startX, by: RAIL_Y - p.L, bvx: 0, bvy: 0, F: 0, T: 0,
    substep: 0, status: Status.Ready, phase: 0, hold: 0, holdStart: 0, score: 0, minD2: Infinity, peakF: 0,
    near: { wall: -1, d2: Infinity, px: 0, py: 0 }, crash: null,
  };
}

/** simulateReplay with a recorder. Throws when the replay is malformed. */
export function trackFromReplay(level: LevelDef, replay: string, kind: GhostKind, label: string): GhostTrack {
  return trackAndHashFromReplay(level, replay, kind, label).track;
}

/** trackFromReplay plus the replay's stateHash (simulateReplay, the Worker's check): tests compare it (§10.7 M11). */
export function trackAndHashFromReplay(level: LevelDef, replay: string, kind: GhostKind, label: string): { track: GhostTrack; stateHash: number } {
  const { qs } = decodeReplay(b64urlDecode(replay));
  const rec = createTrackRecorder(level, Math.min(MAX_TRACK_SAMPLES, qs.length + 1));
  rec.begin(startPose(level));
  const res = simulateReplay(level.physics, qs, { onTick: (_tick, s, ev) => rec.push(s, ev) });
  return { track: rec.finish(kind, label, res.status === Status.Success && res.score !== null ? res.score : null), stateHash: res.stateHash };
}

// ------------------------------------------------------------------------------------ transforms

/**
 * Time reversal (reverse_hint, §8.1): x(T - t). The rest padding at the end of the source (the 1 s the pipeline
 * appends) is trimmed so the reversed ghost starts moving at tick 0.
 */
export function reversed(t: GhostTrack): GhostTrack {
  const n = t.n;
  if (n === 0) return { ...t, kind: 'reverse_hint', finishSub: null, splitSub: t.splitSub.map(() => NaN) };
  const lx = t.x[n - 1]!;
  const lbx = t.bx[n - 1]!;
  const lby = t.by[n - 1]!;
  const EPS = 2e-4; // 0.2 mm
  let end = n - 1;
  while (end > 0 && Math.abs(t.x[end - 1]! - lx) < EPS && Math.abs(t.bx[end - 1]! - lbx) < EPS && Math.abs(t.by[end - 1]! - lby) < EPS) end--;
  const m = end + 1;
  const x = new Float32Array(m);
  const bx = new Float32Array(m);
  const by = new Float32Array(m);
  const f = new Float32Array(m);
  const slack = new Uint8Array(m);
  for (let k = 0; k < m; k++) {
    const src = end - k;
    x[k] = t.x[src]!;
    bx[k] = t.bx[src]!;
    by[k] = t.by[src]!;
    slack[k] = t.slack[src]!;
    // Accelerations are even under time reversal, so F(T - t) keeps its sign; ZOH intervals shift by one.
    f[k] = src - 1 >= 0 ? t.f[src - 1]! : 0;
  }
  return { kind: 'reverse_hint', label: t.label, n: m, hz: 60, x, bx, by, slack, f, finishSub: null, splitSub: t.splitSub.map(() => NaN) };
}

/** Linear interpolation; holds the first pose before 0 and the last pose after the end. */
export function poseAt(t: GhostTrack, tSec: number, out: GhostPose): void {
  out.kind = t.kind;
  out.label = t.label;
  if (t.n === 0) {
    out.visible = false;
    return;
  }
  out.visible = true;
  const fpos = (Number.isFinite(tSec) ? tSec : 0) * t.hz;
  if (fpos <= 0 || t.n === 1) {
    out.x = t.x[0]!;
    out.bx = t.bx[0]!;
    out.by = t.by[0]!;
    out.slack = t.slack[0] !== 0;
    return;
  }
  if (fpos >= t.n - 1) {
    const k = t.n - 1;
    out.x = t.x[k]!;
    out.bx = t.bx[k]!;
    out.by = t.by[k]!;
    out.slack = t.slack[k] !== 0;
    return;
  }
  const i = Math.floor(fpos);
  const a = fpos - i;
  out.x = t.x[i]! + (t.x[i + 1]! - t.x[i]!) * a;
  out.bx = t.bx[i]! + (t.bx[i + 1]! - t.bx[i]!) * a;
  out.by = t.by[i]! + (t.by[i + 1]! - t.by[i]!) * a;
  out.slack = t.slack[i] !== 0;
}

/** Force held at time tSec (ZOH), 0 after the end. */
export function forceAt(t: GhostTrack, tSec: number): number {
  const k = Math.floor(Math.max(0, tSec) * t.hz);
  return k < t.n ? t.f[k]! : 0;
}

/** Duration of the track in seconds. */
export function trackDuration(t: GhostTrack): number {
  return t.n > 0 ? (t.n - 1) / t.hz : 0;
}

/** bx,by pairs of every sample (the AI line, §8.4 3). */
export function ballPath(t: GhostTrack, every = 1): Float32Array {
  const step = Math.max(1, Math.floor(every));
  const m = Math.ceil(t.n / step);
  const out = new Float32Array(2 * m);
  for (let k = 0, j = 0; k < t.n; k += step, j++) {
    out[2 * j] = t.bx[k]!;
    out[2 * j + 1] = t.by[k]!;
  }
  return out;
}

/** bx,by every 0.1 s up to (and including) `untilSample` (strobe card, §7.13). */
export function strobe(t: GhostTrack, untilSample = t.n - 1): Float32Array {
  const last = Math.min(t.n - 1, Math.max(0, untilSample));
  const pts: number[] = [];
  for (let k = 0; k <= last; k += 6) pts.push(t.bx[k]!, t.by[k]!);
  return Float32Array.from(pts);
}

export function newGhostPose(kind: GhostKind = 'ai', label = ''): GhostPose {
  return { kind, label, x: 0, bx: 0, by: 0, slack: false, visible: false };
}
