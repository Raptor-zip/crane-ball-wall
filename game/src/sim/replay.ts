// Replay format and re-simulation (GAME_DESIGN.md §10.4 "リプレイの形式"). Owner: O1.
//
// Bytes: 0-1 magic "YP" (0x59 0x50) | 2 fmt=1 | 3 sim | 4-7 levelHash (uint32 LE) | 8 device | 9 flags |
// then varint nTicks and the q stream. q stream, starting from q = 0: read varint hd;
//   hd & 1 == 0: q += unzigzag(hd >> 1), emit 1 tick;   hd & 1 == 1: emit the current q (hd >> 1) + 2 times.
// Varints are unsigned LEB128.
import { MAX_SUB, Q_MAX, REPLAY_MAX_BYTES } from './constants';
import { FNV_OFFSET, fnv1aF64 } from './fnv';
import type { LevelPhysics } from './level';
import { createRun, Status, stepTick } from './run';
import type { CrashInfo, SimState } from './run';
import { SimEvents } from './events';

export const enum DeviceTag { Unknown = 0, Touch = 1, Mouse = 2, Keyboard = 3, Gamepad = 4, Mixed = 5 }
export const enum ReplayFlag { Assisted = 1, Practice = 2, DirectForce = 4 }

export interface ReplayHeader { fmt: 1; sim: number; levelHash: string; device: DeviceTag; flags: number; nTicks: number }
export interface ReplayResult {
  status: Status; ticks: number; score: number | null; minD2: number; peakF: number;
  crash: CrashInfo | null; stateHash: number;
}
export interface ReplayRecorder { onTick(tick: number, s: SimState, ev: SimEvents): void }

const MAGIC0 = 0x59;
const MAGIC1 = 0x50;
const HEADER_BYTES = 10;
const ALL_FLAGS = 1 | 2 | 4;
const MAX_DEVICE = 5;
/** No run can be longer than the 60 s time-up. */
export const REPLAY_MAX_TICKS = MAX_SUB / 2;

function zigzag(n: number): number {
  return n >= 0 ? 2 * n : -2 * n - 1;
}

function unzigzag(z: number): number {
  return z % 2 === 0 ? z / 2 : -(z + 1) / 2;
}

function pushVarint(out: number[], v: number): void {
  let x = v;
  while (x >= 128) {
    out.push((x % 128) | 128);
    x = Math.floor(x / 128);
  }
  out.push(x);
}

/** Throws when the result would exceed REPLAY_MAX_BYTES (6 KB) or the header / q values are invalid. */
export function encodeReplay(h: ReplayHeader, qs: Int8Array): Uint8Array {
  if (h.fmt !== 1) throw new Error('replay: fmt must be 1');
  if (!Number.isInteger(h.sim) || h.sim < 0 || h.sim > 255) throw new Error('replay: sim must be 0..255');
  if (!/^[0-9a-f]{8}$/.test(h.levelHash)) throw new Error('replay: levelHash must be 8 lowercase hex digits');
  if (!Number.isInteger(h.device) || h.device < 0 || h.device > MAX_DEVICE) throw new Error('replay: bad device tag');
  if (!Number.isInteger(h.flags) || (h.flags & ~ALL_FLAGS) !== 0 || h.flags < 0) throw new Error('replay: bad flags');
  if (h.nTicks !== qs.length) throw new Error(`replay: nTicks ${h.nTicks} != q count ${qs.length}`);
  if (qs.length > REPLAY_MAX_TICKS) throw new Error(`replay: ${qs.length} ticks is longer than ${REPLAY_MAX_TICKS}`);
  const hash = parseInt(h.levelHash, 16);
  const out: number[] = [
    MAGIC0, MAGIC1, 1, h.sim,
    hash & 255, (hash >>> 8) & 255, (hash >>> 16) & 255, (hash >>> 24) & 255,
    h.device, h.flags,
  ];
  pushVarint(out, qs.length);
  let cur = 0;
  let i = 0;
  const n = qs.length;
  while (i < n) {
    const q = qs[i]!;
    if (q < -Q_MAX) throw new Error(`replay: q[${i}] = ${q} is out of range`);
    if (q === cur) {
      let run = 1;
      while (i + run < n && qs[i + run] === cur) run++;
      if (run >= 2) pushVarint(out, ((run - 2) * 2) + 1);
      else pushVarint(out, 0); // delta 0
      i += run;
    } else {
      pushVarint(out, zigzag(q - cur) * 2);
      cur = q;
      i++;
    }
    if (out.length > REPLAY_MAX_BYTES) break;
  }
  if (out.length > REPLAY_MAX_BYTES) throw new Error(`replay: larger than ${REPLAY_MAX_BYTES} bytes`);
  return Uint8Array.from(out);
}

/** Throws on malformed input. */
export function decodeReplay(bytes: Uint8Array): { h: ReplayHeader; qs: Int8Array } {
  if (!(bytes instanceof Uint8Array)) throw new Error('replay: not bytes');
  const n = bytes.length;
  if (n > REPLAY_MAX_BYTES) throw new Error(`replay: larger than ${REPLAY_MAX_BYTES} bytes`);
  if (n < HEADER_BYTES + 1) throw new Error('replay: truncated header');
  if (bytes[0] !== MAGIC0 || bytes[1] !== MAGIC1) throw new Error('replay: bad magic');
  if (bytes[2] !== 1) throw new Error(`replay: unknown fmt ${bytes[2]}`);
  const sim = bytes[3]!;
  const hash = (bytes[4]! | (bytes[5]! << 8) | (bytes[6]! << 16) | (bytes[7]! << 24)) >>> 0;
  const device = bytes[8]!;
  if (device > MAX_DEVICE) throw new Error(`replay: bad device tag ${device}`);
  const flags = bytes[9]!;
  if ((flags & ~ALL_FLAGS) !== 0) throw new Error(`replay: unknown flags ${flags}`);
  let p = HEADER_BYTES;
  const readVarint = (): number => {
    let v = 0;
    let mul = 1;
    for (let k = 0; k < 5; k++) {
      if (p >= n) throw new Error('replay: truncated varint');
      const b = bytes[p++]!;
      v += (b & 127) * mul;
      if (b < 128) {
        if (k > 0 && b === 0) throw new Error('replay: non-canonical varint');
        return v;
      }
      mul *= 128;
    }
    throw new Error('replay: varint too long');
  };
  const nTicks = readVarint();
  if (nTicks > REPLAY_MAX_TICKS) throw new Error(`replay: ${nTicks} ticks is longer than ${REPLAY_MAX_TICKS}`);
  const qs = new Int8Array(nTicks);
  let cur = 0;
  let i = 0;
  while (i < nTicks) {
    const hd = readVarint();
    if (hd % 2 === 0) {
      cur += unzigzag(hd / 2);
      if (cur > Q_MAX || cur < -Q_MAX) throw new Error(`replay: q out of range at tick ${i}`);
      qs[i++] = cur;
    } else {
      const reps = (hd - 1) / 2 + 2;
      if (i + reps > nTicks) throw new Error('replay: repeat runs past nTicks');
      qs.fill(cur, i, i + reps);
      i += reps;
    }
  }
  if (p !== n) throw new Error('replay: trailing bytes');
  const h: ReplayHeader = {
    fmt: 1, sim, levelHash: hash.toString(16).padStart(8, '0'),
    device: device as DeviceTag, flags, nTicks,
  };
  return { h, qs };
}

/** FNV-1a over every field of a state (fixed order; NaN canonicalised). */
export function hashSimState(s: SimState, h0: number): number {
  let h = h0;
  h = fnv1aF64(s.mode, h);
  h = fnv1aF64(s.pinned, h);
  h = fnv1aF64(s.x, h);
  h = fnv1aF64(s.v, h);
  h = fnv1aF64(s.th, h);
  h = fnv1aF64(s.w, h);
  h = fnv1aF64(s.bx, h);
  h = fnv1aF64(s.by, h);
  h = fnv1aF64(s.bvx, h);
  h = fnv1aF64(s.bvy, h);
  h = fnv1aF64(s.F, h);
  h = fnv1aF64(s.T, h);
  h = fnv1aF64(s.substep, h);
  h = fnv1aF64(s.status, h);
  h = fnv1aF64(s.phase, h);
  h = fnv1aF64(s.hold, h);
  h = fnv1aF64(s.holdStart, h);
  h = fnv1aF64(s.score, h);
  h = fnv1aF64(s.minD2, h);
  h = fnv1aF64(s.peakF, h);
  h = fnv1aF64(s.near.wall, h);
  h = fnv1aF64(s.near.d2, h);
  h = fnv1aF64(s.near.px, h);
  h = fnv1aF64(s.near.py, h);
  const c = s.crash;
  h = fnv1aF64(c ? c.kind : -1, h);
  h = fnv1aF64(c ? c.wall : -1, h);
  h = fnv1aF64(c ? c.px : 0, h);
  h = fnv1aF64(c ? c.py : 0, h);
  h = fnv1aF64(c ? c.d2 : 0, h);
  return h;
}

/** FNV-1a over the events of one tick (kind, sub, a, b, c each as float64). */
export function hashEvents(ev: SimEvents, h0: number): number {
  let h = h0;
  for (let k = 0; k < ev.n; k++) {
    h = fnv1aF64(ev.kind[k]!, h);
    h = fnv1aF64(ev.sub[k]!, h);
    h = fnv1aF64(ev.a[k]!, h);
    h = fnv1aF64(ev.b[k]!, h);
    h = fnv1aF64(ev.c[k]!, h);
  }
  return h;
}

/**
 * The ranked time of a re-simulated replay, or null when the run would not be ranked (§4.6, §7.8 step 5): it must
 * succeed on its last tick, i.e. the replay has exactly nTicks = ceil((score + 59) / 2) ticks. The Worker accepts a
 * claimed time only when it equals this (worker/verify.ts simulateRun), and the client's replay viewer plays a ranked
 * replay only when it equals the row's time: one rule on both sides.
 */
export function rankedScore(qsLen: number, r: Pick<ReplayResult, 'status' | 'score'>): number | null {
  if (r.status !== Status.Success || r.score === null) return null;
  return qsLen === Math.ceil((r.score + 59) / 2) ? r.score : null;
}

/**
 * Re-simulates a q sequence from the level start. Stops at the tick that ends the run
 * (Success / Crash / Timeout); `ticks` is the number of ticks simulated. `status` is Running when the
 * sequence ended before the run did (Ready for an empty sequence). stateHash = FNV-1a over every tick's
 * events, then the final state, then `ticks`. The recorder sees each tick after it was stepped.
 */
export function simulateReplay(phys: LevelPhysics, qs: Int8Array, rec?: ReplayRecorder): ReplayResult {
  const run = createRun(phys);
  const s = run.s;
  const ev = new SimEvents();
  let h = FNV_OFFSET;
  let ticks = 0;
  let status = s.status;
  for (let i = 0; i < qs.length; i++) {
    status = stepTick(run, qs[i]!, ev);
    ticks = i + 1;
    h = hashEvents(ev, h);
    if (rec) rec.onTick(i, s, ev);
    if (status !== Status.Running) break;
  }
  h = hashSimState(s, h);
  h = fnv1aF64(ticks, h);
  const c = s.crash;
  return {
    status,
    ticks,
    score: status === Status.Success ? s.score : null,
    minD2: s.minD2,
    peakF: s.peakF,
    crash: c ? { kind: c.kind, wall: c.wall, px: c.px, py: c.py, d2: c.d2 } : null,
    stateHash: h,
  };
}
