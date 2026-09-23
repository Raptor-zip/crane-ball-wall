// Shared helpers of the data gates (GAME_DESIGN.md §8.3, §10.7 tests/data/*). Owner: O2.
//
// The data files under src/data/ are rewritten in place by the ghost pipeline (tools/ai_ghosts.py,
// tools/daily_pool.py), so everything here reads them from disk at test time and never depends on exact
// par values. The ghost checks use the game's own rule functions from src/sim (collide, detmath, rules,
// dynamics) and an independent reference decoder of the §8.2 channel codec, so the gate does not depend on
// the state of src/core/ghostcodec.ts (tests/data/ghostcodec.test.ts checks that one against this).
import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BALL_R, BEAM_Y, G, HOLD_SUB, RAIL_Y, REST_V } from '../../src/sim/constants';
import { pointSlabDist2, segHitsSlab, segSlabDist2 } from '../../src/sim/collide';
import { sincos } from '../../src/sim/detmath';
import { tensionFree } from '../../src/sim/dynamics';
import { inZone, restEnergy } from '../../src/sim/rules';
import { levelFacts } from '../../src/sim/display';
import type { LevelDef, LevelPhysics, SplitDef } from '../../src/sim/level';

// ------------------------------------------------------------------------------------------ files

const DATA_DIR = new URL('../../src/data/', import.meta.url);
const FIXTURE_DIR = new URL('../fixtures/', import.meta.url);

export function dataPath(rel: string): string {
  return fileURLToPath(new URL(rel, DATA_DIR));
}
export function hasData(rel: string): boolean {
  return existsSync(dataPath(rel));
}
export function readData<T>(rel: string): T {
  return JSON.parse(readFileSync(dataPath(rel), 'utf8')) as T;
}

/**
 * daily_pool.json / daily_ghosts.json live in src/data; YP_DAILY_DIR=<dir> points the daily gate at another
 * directory instead (e.g. a smoke pool from `daily_pool.py --count 7 --out <dir>`) without touching src/data.
 */
export function dailyPath(name: 'daily_pool.json' | 'daily_ghosts.json'): string {
  const dir = process.env['YP_DAILY_DIR'];
  return dir ? resolvePath(dir, name) : dataPath(name);
}
export function hasDaily(name: 'daily_pool.json' | 'daily_ghosts.json'): boolean {
  return existsSync(dailyPath(name));
}
export function readDaily<T>(name: 'daily_pool.json' | 'daily_ghosts.json'): T {
  return JSON.parse(readFileSync(dailyPath(name), 'utf8')) as T;
}
export function readFixture<T>(rel: string): T {
  return JSON.parse(readFileSync(fileURLToPath(new URL(rel, FIXTURE_DIR)), 'utf8')) as T;
}

/** The 18 campaign levels of §5.1, in campaign order. */
export const LEVEL_IDS = [
  '1-1', '1-2', '1-3', '1-4', '2-1', '2-2', '2-3', '2-4', '3-1', '3-2', '3-3',
  '4-1', '4-2', '4-3', '5-1', '5-2', '5-3', '5-4',
] as const;

/** Ghost entry as tools/common.py build_ghost writes it (splitSub entries may be null = never reached). */
export interface GhostJson {
  kind: string; label: string; hz: number; n: number; parSub: number; planT: number;
  peakF: number; minGapMm: number | null; maxThetaDeg: number; pumps: number; splitSub: (number | null)[];
  x: string; th: string; f: string;
}
export interface GhostFile { format: number; levelId: string; physics: LevelPhysics; ghosts: GhostJson[] }
export interface SummaryEntry {
  hash: string; parSub: number; tMin: number; planT: number; calmT: number | null; peakF: number;
  minGapMm: number | null; pumps: number; headroom: string | null; aiMarginMm: number; aiTensionMinN: number;
  fallbackApplied: unknown[]; mode?: string;
}
export interface SummaryFile { format: number; levels: Record<string, SummaryEntry> }
export interface DailyGhostsFile { format: number; ghosts: Record<string, GhostJson[]> }

/** §8.2 labels of the AI ghost kinds. */
export const GHOST_LABELS: Readonly<Record<string, string>> = {
  ai: 'AI', calm: 'AI(お手本)', research_fast: 'AI(省エネ)', research_pump: 'AI(ブランコ)',
};

// ------------------------------------------------------------------ reference codec (§8.2)
// Written independently of src/core/ghostcodec.ts (BigInt varints, table-free base64url).

export type Channel = 'x' | 'th' | 'f';
export const CHANNEL_SCALE: Readonly<Record<Channel, number>> = { x: 1e4, th: 1e4, f: 10 };

function b64Value(c: number): number {
  if (c >= 65 && c <= 90) return c - 65; // A-Z
  if (c >= 97 && c <= 122) return c - 71; // a-z
  if (c >= 48 && c <= 57) return c + 4; // 0-9
  if (c === 45) return 62; // -
  if (c === 95) return 63; // _
  return -1;
}
function b64Char(v: number): string {
  return String.fromCharCode(v < 26 ? v + 65 : v < 52 ? v + 71 : v < 62 ? v - 4 : v === 62 ? 45 : 95);
}

/** base64url without padding -> bytes. Throws on a bad character or an impossible length. */
export function refB64urlDecode(s: string): Uint8Array {
  if (s.length % 4 === 1) throw new Error('ref: impossible base64url length');
  const out: number[] = [];
  for (let i = 0; i < s.length; i += 4) {
    const chunk = s.slice(i, i + 4);
    const vals = [...chunk].map((ch, j) => {
      const v = b64Value(ch.charCodeAt(0));
      if (v < 0) throw new Error(`ref: bad base64url character at ${i + j}`);
      return v;
    });
    const bits = vals.reduce((acc, v) => acc * 64 + v, 0) * 64 ** (4 - vals.length); // 24-bit group
    const nBytes = vals.length - 1; // 4 chars -> 3 bytes, 3 -> 2, 2 -> 1
    for (let b = 0; b < nBytes; b++) out.push(Math.floor(bits / 256 ** (2 - b)) % 256);
  }
  return Uint8Array.from(out);
}

export function refB64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = Math.min(3, bytes.length - i);
    let bits = 0;
    for (let b = 0; b < 3; b++) bits = bits * 256 + (b < n ? bytes[i + b]! : 0);
    for (let c = 0; c <= n; c++) s += b64Char(Math.floor(bits / 64 ** (3 - c)) % 64);
  }
  return s;
}

/** Channel text -> quantised integers (LEB128 varints of zigzag(first value, then differences)). */
export function refDecodeInts(s: string): number[] {
  const bytes = refB64urlDecode(s);
  const out: number[] = [];
  let z = 0n;
  let shift = 0n;
  let open = false;
  let prev = 0n;
  for (const byte of bytes) {
    z |= BigInt(byte & 0x7f) << shift;
    if (byte & 0x80) {
      shift += 7n;
      open = true;
      continue;
    }
    const d = (z & 1n) === 0n ? z >> 1n : -((z + 1n) >> 1n);
    prev = out.length === 0 ? d : prev + d;
    out.push(Number(prev));
    z = 0n;
    shift = 0n;
    open = false;
  }
  if (open) throw new Error('ref: truncated varint');
  return out;
}

export function refEncodeInts(ints: readonly number[]): string {
  const bytes: number[] = [];
  let prev = 0n;
  ints.forEach((v, i) => {
    const n = BigInt(v);
    const d = i === 0 ? n : n - prev;
    prev = n;
    let z = d >= 0n ? 2n * d : -2n * d - 1n;
    do {
      const low = Number(z & 0x7fn);
      z >>= 7n;
      bytes.push(z > 0n ? low | 0x80 : low);
    } while (z > 0n);
  });
  return refB64urlEncode(Uint8Array.from(bytes));
}

/** Math.round(value * scale), with -0 normalised to 0. */
export function refQuantize(values: readonly number[], channel: Channel): number[] {
  const k = CHANNEL_SCALE[channel];
  return values.map((v) => Math.round(v * k) + 0);
}

export function refDecodeChannel(s: string, channel: Channel): Float64Array {
  const k = CHANNEL_SCALE[channel];
  return Float64Array.from(refDecodeInts(s), (n) => n / k);
}

// ------------------------------------------------------------------ 120 Hz samples of a ghost

/** Linear 120 Hz resampling of 60 Hz ghost samples; v and w by central differences (np.gradient). */
export interface Samples120 {
  N: number;           // 2n - 1 samples; sample k is the state at t = k/120 s (= substep k)
  x: Float64Array; th: Float64Array; v: Float64Array; w: Float64Array;
  F: Float64Array;     // zero-order hold of the 60 Hz force channel
  sn: Float64Array; cs: Float64Array; bx: Float64Array; by: Float64Array;
  T: Float64Array;     // taut string tension from the EOM (tensionFree: xdd from accel, not from differences)
}

function gradient(y: Float64Array, h: number): Float64Array {
  const n = y.length;
  const d = new Float64Array(n);
  if (n < 2) return d;
  d[0] = (y[1]! - y[0]!) / h;
  d[n - 1] = (y[n - 1]! - y[n - 2]!) / h;
  for (let i = 1; i < n - 1; i++) d[i] = (y[i + 1]! - y[i - 1]!) / (2 * h);
  return d;
}

export function samples120(phys: LevelPhysics, x60: Float64Array, th60: Float64Array, f60: Float64Array): Samples120 {
  const n = x60.length;
  const N = n > 0 ? 2 * n - 1 : 0;
  const x = new Float64Array(N);
  const th = new Float64Array(N);
  const F = new Float64Array(N);
  for (let k = 0; k < n; k++) {
    x[2 * k] = x60[k]!;
    th[2 * k] = th60[k]!;
    F[2 * k] = f60[k]!;
    if (k + 1 < n) {
      x[2 * k + 1] = x60[k]! + 0.5 * (x60[k + 1]! - x60[k]!);
      th[2 * k + 1] = th60[k]! + 0.5 * (th60[k + 1]! - th60[k]!);
      F[2 * k + 1] = f60[k]!;
    }
  }
  const h = 1 / 120;
  const v = gradient(x, h);
  const w = gradient(th, h);
  const sn = new Float64Array(N);
  const cs = new Float64Array(N);
  const bx = new Float64Array(N);
  const by = new Float64Array(N);
  const T = new Float64Array(N);
  const sc = new Float64Array(2);
  const L = phys.L;
  for (let i = 0; i < N; i++) {
    sincos(th[i]!, sc);
    sn[i] = sc[0]!;
    cs[i] = sc[1]!;
    bx[i] = x[i]! + L * sc[0]!;
    by[i] = RAIL_Y - L * sc[1]!;
    T[i] = tensionFree(phys.M, phys.m, L, v[i]!, th[i]!, w[i]!, F[i]!);
  }
  return { N, x, th, v, w, F, sn, cs, bx, by, T };
}

// ------------------------------------------------------------------ game rules on the samples

export interface WallCrossEv { k: number; wall: number; dir: 1 | -1 }

/** §4.5 WallCross on the samples: the ball centre crosses the wall's centre x with by - r > h at the end sample. */
export function wallCrosses(phys: LevelPhysics, s: Samples120): WallCrossEv[] {
  const out: WallCrossEv[] = [];
  for (let k = 1; k < s.N; k++) {
    phys.walls.forEach((wall, i) => {
      const cx = 0.5 * (wall.x0 + wall.x1);
      const a0 = s.bx[k - 1]! >= cx;
      const a1 = s.bx[k]! >= cx;
      if (a0 !== a1 && s.by[k]! - BALL_R > wall.h) out.push({ k, wall: i, dir: a1 ? 1 : -1 });
    });
  }
  return out;
}

export interface SuccessScan {
  parSub: number | null;   // holdStart of the final phase (§4.6 score), null when never
  phaseSub: number[];      // holdStart of every completed phase
  doneAt: number | null;   // sample of the final (60th) hold sample
}

/**
 * §4.6 success rule on the samples (sample k = substep k, judged from k = 1): mode Taut (T > 0),
 * ball centre in the phase zone, E < E_rest, |v| < REST_V, for HOLD_SUB consecutive samples.
 */
export function successScan(phys: LevelPhysics, s: Samples120): SuccessScan {
  const L = phys.L;
  const eRest = restEnergy(phys);
  let phase = 0;
  let hold = 0;
  let holdStart = -1;
  const phaseSub: number[] = [];
  for (let k = 1; k < s.N; k++) {
    const w = s.w[k]!;
    const E = 0.5 * L * L * w * w + G * L * (1 - s.cs[k]!);
    const ok = s.T[k]! > 0 && inZone(phys.phases[phase]!, s.bx[k]!) && E < eRest && Math.abs(s.v[k]!) < REST_V;
    if (ok) {
      if (hold === 0) holdStart = k;
      hold++;
      if (hold === HOLD_SUB) {
        phaseSub.push(holdStart);
        if (phase === phys.phases.length - 1) return { parSub: holdStart, phaseSub, doneAt: k };
        phase++;
        hold = 0;
      }
    } else {
      hold = 0;
    }
  }
  return { parSub: null, phaseSub, doneAt: null };
}

/**
 * Split times as the game records them (core/splits.ts): splits are taken in order, a wall split at the
 * first matching WallCross after the previous split, a phase split at that phase's holdStart. Stops at success.
 */
export function splitScan(splits: readonly SplitDef[], crosses: readonly WallCrossEv[], sc: SuccessScan): (number | null)[] {
  type Ev = { k: number; order: number; wall?: number; dir?: 1 | -1; phase?: number; value: number };
  const evs: Ev[] = crosses.map((c) => ({ k: c.k, order: 0, wall: c.wall, dir: c.dir, value: c.k }));
  // PhaseDone happens on the 60th hold sample, after that sample's WallCross events; its split value is holdStart.
  sc.phaseSub.forEach((hs, p) => evs.push({ k: hs + HOLD_SUB - 1, order: 1, phase: p, value: hs }));
  evs.sort((a, b) => a.k - b.k || a.order - b.order);
  const out: (number | null)[] = splits.map(() => null);
  let next = 0;
  for (const e of evs) {
    if (sc.doneAt !== null && e.k > sc.doneAt) break;
    const sp = splits[next];
    if (!sp) break;
    if ('wall' in sp ? e.wall === sp.wall && e.dir === sp.dir : e.phase === sp.phase) {
      out[next] = e.value;
      next++;
    }
  }
  return out;
}

// ------------------------------------------------------------------ one ghost

export interface GhostCheck {
  n: number;
  lengths: [number, number, number];     // decoded x, th, f lengths
  gapMm: number | null;                  // swept ball-centre chord vs walls (the game's rule a), min over the run
  gapAt: { k: number; wall: number } | null;
  pointGapMm: number | null;             // point samples (to compare with the JSON minGapMm)
  stringHit: { k: number; wall: number } | null;
  cornerSweep: { k: number; wall: number } | null;
  minStringGapMm: number | null;
  maxBallTop: number;                    // max(by + r)
  minBallBottom: number;                 // min(by - r)
  xMin: number; xMax: number;
  x0: number; th0: number;
  maxThetaDeg: number;
  peakFDecoded: number;
  maxT: number; minT: number;
  scan: SuccessScan;
  splitSub: (number | null)[];
  tailStatic: boolean;                   // the last 60 samples (1.0 s) keep x, th and have F = 0
}

export function analyseGhost(phys: LevelPhysics, splits: readonly SplitDef[], g: GhostJson): GhostCheck {
  const x60 = refDecodeChannel(g.x, 'x');
  const th60 = refDecodeChannel(g.th, 'th');
  const f60 = refDecodeChannel(g.f, 'f');
  const n = Math.min(x60.length, th60.length, f60.length);
  const s = samples120(phys, x60.subarray(0, n), th60.subarray(0, n), f60.subarray(0, n));
  const walls = phys.walls;

  let minSwept = Infinity;
  let gapAt: GhostCheck['gapAt'] = null;
  let minPoint = Infinity;
  let minStr = Infinity;
  let stringHit: GhostCheck['stringHit'] = null;
  let cornerSweep: GhostCheck['cornerSweep'] = null;
  let maxTop = -Infinity;
  let minBottom = Infinity;
  let xMin = Infinity;
  let xMax = -Infinity;
  let maxTh = 0;
  let maxT = -Infinity;
  let minT = Infinity;
  for (let k = 0; k < s.N; k++) {
    const bx = s.bx[k]!;
    const by = s.by[k]!;
    const px = s.x[k]!;
    walls.forEach((wall, i) => {
      if (k > 0) {
        const d2 = segSlabDist2(s.bx[k - 1]!, s.by[k - 1]!, bx, by, wall);
        if (d2 < minSwept) {
          minSwept = d2;
          gapAt = { k, wall: i };
        }
      }
      const p2 = pointSlabDist2(bx, by, wall);
      if (p2 < minPoint) minPoint = p2;
      const q2 = segSlabDist2(px, RAIL_Y, bx, by, wall);
      if (q2 < minStr) minStr = q2;
      if (!stringHit && segHitsSlab(px, RAIL_Y, bx, by, wall)) stringHit = { k, wall: i };
      // §4.5 (b) corner sweep between the previous and this sample
      if (k > 0 && !cornerSweep) {
        const px0 = s.x[k - 1]!;
        const bx0 = s.bx[k - 1]!;
        const by0 = s.by[k - 1]!;
        for (const kx of [wall.x0, wall.x1]) {
          const ky = wall.h;
          const s0 = (bx0 - px0) * (ky - RAIL_Y) - (by0 - RAIL_Y) * (kx - px0);
          const s1 = (bx - px) * (ky - RAIL_Y) - (by - RAIL_Y) * (kx - px);
          if ((s0 > 0 && s1 < 0) || (s0 < 0 && s1 > 0)) {
            const ux = bx - px;
            const uy = by - RAIL_Y;
            const t = ((kx - px) * ux + (ky - RAIL_Y) * uy) / (ux * ux + uy * uy);
            if (t >= 0 && t <= 1) cornerSweep = { k, wall: i };
          }
        }
      }
    });
    if (by + BALL_R > maxTop) maxTop = by + BALL_R;
    if (by - BALL_R < minBottom) minBottom = by - BALL_R;
    if (px < xMin) xMin = px;
    if (px > xMax) xMax = px;
    if (Math.abs(s.th[k]!) > maxTh) maxTh = Math.abs(s.th[k]!);
    if (s.T[k]! > maxT) maxT = s.T[k]!;
    if (s.T[k]! < minT) minT = s.T[k]!;
  }
  let peakF = 0;
  for (let k = 0; k < n; k++) peakF = Math.max(peakF, Math.abs(f60[k]!));

  let tailStatic = n >= 60;
  for (let k = n - 60; tailStatic && k < n; k++) {
    if (x60[k] !== x60[n - 1] || th60[k] !== th60[n - 1] || f60[k] !== 0) tailStatic = false;
  }

  const scan = successScan(phys, s);
  const mm = (d2: number): number | null => (walls.length === 0 ? null : (Math.sqrt(d2) - BALL_R) * 1000);
  return {
    n,
    lengths: [x60.length, th60.length, f60.length],
    gapMm: mm(minSwept),
    gapAt,
    pointGapMm: mm(minPoint),
    stringHit,
    cornerSweep,
    minStringGapMm: walls.length === 0 ? null : Math.sqrt(minStr) * 1000,
    maxBallTop: maxTop,
    minBallBottom: minBottom,
    xMin,
    xMax,
    x0: n > 0 ? x60[0]! : NaN,
    th0: n > 0 ? th60[0]! : NaN,
    maxThetaDeg: (maxTh * 180) / Math.PI,
    peakFDecoded: peakF,
    maxT,
    minT,
    scan,
    splitSub: splitScan(splits, wallCrosses(phys, s), scan),
    tailStatic,
  };
}

/** Tolerances of the gate. */
export const TOL = {
  gapMinMm: 15,          // §8.3 ball-wall clearance
  parSub: 3,             // §8.3 parSub / splitSub vs the TS recomputation
  jsonGapMm: 2.5,        // JSON minGapMm (1 kHz Hermite) vs 120 Hz linear point samples
  jsonThetaDeg: 0.5,     // JSON maxThetaDeg vs samples
  peakFQuant: 0.06,      // decoded 0.1 N channel vs the JSON peakF (0.01 N)
  startMm: 0.5,          // first sample vs the level start (x = startX, th = 0)
} as const;

/**
 * All §8.3 violations of one ghost (empty = valid). `ctx` names the ghost in the messages.
 * Also checks the codec lengths, the label, the start pose and that the appended 1.0 s is at rest.
 */
export function ghostErrors(phys: LevelPhysics, splits: readonly SplitDef[], g: GhostJson, c: GhostCheck): string[] {
  const e: string[] = [];
  const f1 = (v: number | null, d = 1): string => (v === null ? 'null' : v.toFixed(d));
  if (g.hz !== 60) e.push(`hz ${g.hz} != 60`);
  if (GHOST_LABELS[g.kind] === undefined) e.push(`unknown kind ${g.kind}`);
  else if (g.label !== GHOST_LABELS[g.kind]) e.push(`label "${g.label}" != "${GHOST_LABELS[g.kind]}"`);
  if (c.lengths.some((len) => len !== g.n)) e.push(`decoded channel lengths ${c.lengths.join('/')} != n ${g.n}`);
  if (c.n < 2) {
    e.push('fewer than 2 samples');
    return e;
  }
  // start pose (the ghost runs from the player's tick 0)
  if (Math.abs(c.x0 - phys.startX) * 1000 > TOL.startMm || Math.abs(c.th0) * 1000 > TOL.startMm) {
    e.push(`starts at x ${c.x0}, th ${c.th0} instead of x ${phys.startX}, th 0`);
  }
  // clearance, string, beam, floor, rail
  if (phys.walls.length > 0) {
    if (c.gapMm === null || c.gapMm < TOL.gapMinMm) {
      e.push(`ball-wall clearance ${f1(c.gapMm)} mm < ${TOL.gapMinMm} mm (sample ${c.gapAt?.k}, wall ${c.gapAt?.wall})`);
    }
    if (g.minGapMm === null) e.push('minGapMm is null on a level with walls');
    else if (c.pointGapMm !== null && Math.abs(g.minGapMm - c.pointGapMm) > TOL.jsonGapMm) {
      e.push(`JSON minGapMm ${g.minGapMm} vs samples ${f1(c.pointGapMm, 2)} mm`);
    }
  } else if (g.minGapMm !== null) {
    e.push(`minGapMm ${g.minGapMm} on a level without walls (expected null)`);
  }
  if (c.stringHit) e.push(`string meets wall ${c.stringHit.wall} at sample ${c.stringHit.k}`);
  if (c.cornerSweep) e.push(`string sweeps a corner of wall ${c.cornerSweep.wall} at sample ${c.cornerSweep.k}`);
  if (!(c.maxBallTop < BEAM_Y)) e.push(`ball hits the beam: max(by + r) = ${c.maxBallTop.toFixed(4)} >= ${BEAM_Y}`);
  if (!(c.minBallBottom > 0)) e.push(`ball hits the floor: min(by - r) = ${c.minBallBottom.toFixed(4)}`);
  if (c.xMin < phys.rail[0] || c.xMax > phys.rail[1]) {
    e.push(`trolley leaves the rail: x in [${c.xMin}, ${c.xMax}] vs [${phys.rail[0]}, ${phys.rail[1]}]`);
  }
  // success rule, parSub, the appended second of rest
  if (c.scan.parSub === null) e.push('the success rule never holds on the samples');
  else if (Math.abs(c.scan.parSub - g.parSub) > TOL.parSub) e.push(`parSub ${g.parSub} vs TS ${c.scan.parSub} (> ±${TOL.parSub})`);
  if (!(Number.isInteger(g.parSub) && g.parSub > 0)) e.push(`parSub ${g.parSub} is not a positive integer`);
  if (!(g.parSub + HOLD_SUB <= g.n * 2)) e.push(`parSub + ${HOLD_SUB} = ${g.parSub + HOLD_SUB} > n*2 = ${g.n * 2}: the hold does not fit`);
  if (!c.tailStatic) e.push('the last 1.0 s of samples is not a rest (x, th constant, F = 0)');
  // splits
  if (!Array.isArray(g.splitSub) || g.splitSub.length !== splits.length) {
    e.push(`splitSub has ${Array.isArray(g.splitSub) ? g.splitSub.length : 'no'} entries for ${splits.length} splits`);
  } else {
    g.splitSub.forEach((js, i) => {
      const ts = c.splitSub[i] ?? null;
      if (js === null || ts === null || Math.abs(js - ts) > TOL.parSub) {
        e.push(`splitSub[${i}] ${js} vs TS ${ts} (> ±${TOL.parSub})`);
      }
    });
  }
  // force and tension
  if (!(g.peakF <= phys.Fmax + 1e-6)) e.push(`peakF ${g.peakF} > Fmax ${phys.Fmax}`);
  if (!(c.peakFDecoded <= phys.Fmax + 1e-6)) e.push(`decoded max |F| ${c.peakFDecoded} > Fmax ${phys.Fmax}`);
  if (!(c.peakFDecoded <= g.peakF + TOL.peakFQuant)) e.push(`decoded max |F| ${c.peakFDecoded} > JSON peakF ${g.peakF}`);
  if (phys.egg && !(c.maxT < phys.egg.Tmax)) e.push(`max tension ${c.maxT.toFixed(2)} N >= egg Tmax ${phys.egg.Tmax} N`);
  if (!(c.minT > 0)) e.push(`string goes slack: min tension ${c.minT.toFixed(3)} N`);
  if (Math.abs(g.maxThetaDeg - c.maxThetaDeg) > TOL.jsonThetaDeg) {
    e.push(`JSON maxThetaDeg ${g.maxThetaDeg} vs samples ${c.maxThetaDeg.toFixed(2)}`);
  }
  return e;
}

/** One-line diagnostics of a ghost for the test output. */
export function describeGhost(g: GhostJson, c: GhostCheck): string {
  const f = (v: number | null, d = 1): string => (v === null ? '–' : v.toFixed(d));
  return `${g.kind}: n ${g.n}, parSub ${g.parSub}/TS ${c.scan.parSub}, split ${JSON.stringify(g.splitSub)}/TS ${JSON.stringify(c.splitSub)}, ` +
    `gap ${f(c.gapMm)} mm (JSON ${f(g.minGapMm)}), top ${c.maxBallTop.toFixed(3)}, T ${c.minT.toFixed(2)}..${c.maxT.toFixed(2)} N, ` +
    `|F| ${c.peakFDecoded} (JSON ${g.peakF})`;
}

// ------------------------------------------------------------------ §5.3 placeholders

export const PLACEHOLDER = /\{(\w+)\}/g;

/** Distinct placeholder names of a text, sorted. */
export function placeholderNames(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]!))].sort();
}

/**
 * §5.3 value of a placeholder for a level in its display format (m 2 decimals, integer degrees, integer cm,
 * integer N, s 2 decimals), from O1's levelFacts; null when it cannot be resolved for this level.
 */
export function resolvePlaceholder(name: string, lv: LevelDef): string | null {
  const p = lv.physics;
  const f = levelFacts(p);
  const idx = /^(h|req)([0-3])$/.exec(name);
  if (idx) {
    const i = Number(idx[2]);
    if (i >= p.walls.length) return null;
    const v = idx[1] === 'h' ? f.wallH[i] : f.reqDeg[i];
    if (v === undefined || !Number.isFinite(v) || v <= 0) return null;
    return idx[1] === 'h' ? v.toFixed(2) : String(Math.round(v));
  }
  switch (name) {
    case 'beam':
      return Number.isFinite(f.beamDeg) ? String(Math.round(f.beamDeg)) : null;
    case 'gap':
      return f.gapCm !== null && Number.isFinite(f.gapCm) && f.gapCm > 0 ? String(Math.round(f.gapCm)) : null;
    case 'Fmax':
      return String(Math.round(p.Fmax));
    case 'Tmax':
      return p.egg ? String(Math.round(p.egg.Tmax)) : null;
    case 'period':
      return Number.isFinite(f.periodS) && f.periodS > 0 ? f.periodS.toFixed(2) : null;
    default:
      return null;
  }
}

/** research_* kinds a level must carry, from ai.extras (§8.1). */
export function researchKindsOf(extras: readonly string[] | undefined): string[] {
  const kinds = new Set<string>();
  for (const e of extras ?? []) kinds.add(e.endsWith('_pump') ? 'research_pump' : 'research_fast');
  return [...kinds].sort();
}
