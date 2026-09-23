// Board resolution and replay verification by re-simulation (GAME_DESIGN.md §7.8 steps 2-5). Owner: O9.
// The level catalog comes from the bundled src/data files: levels.json + ghosts_summary.json (level par),
// daily_pool.json (daily levels and their par).
import { SIM_VERSION, REPLAY_MAX_BYTES, RANKED_MAX_TICKS } from '../src/sim/constants';
import { levelHash, type DailyDef, type DailyPoolFile, type LevelDef, type LevelPhysics, type LevelsFile } from '../src/sim/level';
import { decodeReplay, simulateReplay, ReplayFlag } from '../src/sim/replay';
import { Status } from '../src/sim/run';
import { b64urlDecode } from '../src/sim/b64';
import { ballClearanceM } from '../src/sim/display';
import { DAILY_GRACE_MS, DAY_MS, jstTimeOfDay, pickDaily } from '../src/shared/daily';
import {
  dailyBoardKey, levelBoardKey, parseBoardKey,
  type RejectReason, type SubmitRun,
} from '../src/shared/api';
import levelsJson from '../src/data/levels.json';
import summaryJson from '../src/data/ghosts_summary.json';

// ---- Catalog ----

interface SummaryFile { format: 1; levels: Record<string, { hash: string; parSub: number } | undefined> }

/** A ranking the Worker accepts runs for. */
export interface Target {
  kind: 'L' | 'D';
  key: string;
  levelId: string;             // "2-2" or the daily pool id "d:17"
  phys: LevelPhysics;
  hash: string;                // levelHash(phys)
  par: number;                 // parSub
  dayIndex: number | null;     // daily only
}

let levelTargetsCache: Target[] | null = null;
let parOverride: Record<string, number> | null = null;

/** Test hook: replaces the par of some levels (null restores ghosts_summary.json). */
export function setParOverrideForTest(pars: Record<string, number> | null): void {
  parOverride = pars;
  levelTargetsCache = null;
}

/** The 18 campaign boards, in levels.json order (keys use the TS levelHash, as the client does). */
export function levelTargets(): Target[] {
  if (levelTargetsCache) return levelTargetsCache;
  const levels = (levelsJson as unknown as LevelsFile).levels;
  const summary = summaryJson as unknown as SummaryFile;
  levelTargetsCache = levels.map((l: LevelDef) => {
    const hash = levelHash(l.physics);
    const par = parOverride?.[l.id] ?? summary.levels[l.id]?.parSub;
    return {
      kind: 'L' as const, key: levelBoardKey(l.id, hash), levelId: l.id, phys: l.physics, hash,
      par: typeof par === 'number' && par > 0 ? par : 0, dayIndex: null,
    };
  });
  return levelTargetsCache;
}

export function levelTarget(levelId: string): Target | undefined {
  return levelTargets().find((t) => t.levelId === levelId);
}

let dailyPoolCache: readonly DailyDef[] | null = null;
let dailyPoolOverride: readonly DailyDef[] | null = null;
const hashCache = new WeakMap<LevelPhysics, string>();

/**
 * The bundled daily pool (src/data/daily_pool.json, written by O2's daily_pool.py).
 * Loaded through a glob import so the Worker still builds while that file does not exist yet
 * (the daily board is then unavailable: boot sends key "", daily submits are badBoard).
 */
export async function dailyPool(): Promise<readonly DailyDef[]> {
  if (dailyPoolOverride) return dailyPoolOverride;
  if (dailyPoolCache) return dailyPoolCache;
  const stem = 'daily';
  try {
    const mod = (await import(`../src/data/${stem}_pool.json`)) as { default: DailyPoolFile };
    dailyPoolCache = Array.isArray(mod.default?.pool) ? mod.default.pool : [];
  } catch {
    dailyPoolCache = [];
  }
  if (dailyPoolCache.length === 0) console.warn(JSON.stringify({ evt: 'no-daily-pool' }));
  return dailyPoolCache;
}

/** Test hook: replaces the daily pool (null restores the bundled one). */
export function setDailyPoolForTest(pool: readonly DailyDef[] | null): void {
  dailyPoolOverride = pool;
}

function physHash(phys: LevelPhysics): string {
  let h = hashCache.get(phys);
  if (h === undefined) {
    h = levelHash(phys);
    hashCache.set(phys, h);
  }
  return h;
}

/** The daily board of the JST day containing `now` (null without a pool). */
export async function dailyTarget(now: number): Promise<Target | null> {
  const pool = await dailyPool();
  if (pool.length === 0) return null;
  const pick = pickDaily(pool, now);
  const hash = physHash(pick.level.physics);
  return {
    kind: 'D', key: dailyBoardKey(pick.dayIndex, hash), levelId: pick.level.id, phys: pick.level.physics, hash,
    par: pick.level.parSub, dayIndex: pick.dayIndex,
  };
}

/**
 * 00:00-02:00 JST: yesterday's daily board still accepts runs (§7.8 step 2).
 * Re-exported from src/shared/daily.ts so the client's and the server's windows cannot drift.
 */
export { DAILY_GRACE_MS };

function inGrace(now: number): boolean {
  return jstTimeOfDay(now) < DAILY_GRACE_MS;
}

export type Resolved = { ok: true; target: Target } | { ok: false; reason: RejectReason };

/** §7.8 step 2: board key -> level and par; `stale` on a hash/sim mismatch, `badBoard` otherwise. */
export async function resolveBoard(run: SubmitRun, now: number): Promise<Resolved> {
  const k = parseBoardKey(run.board);
  if (!k) return { ok: false, reason: 'badBoard' };
  if (k.kind === 'L') {
    const t = levelTarget(k.levelId);
    if (!t || run.level !== k.levelId) return { ok: false, reason: 'badBoard' };
    if (k.sim !== SIM_VERSION || k.levelHash !== t.hash) return { ok: false, reason: 'stale' };
    return { ok: true, target: t };
  }
  const today = await dailyTarget(now);
  if (!today) return { ok: false, reason: 'badBoard' };
  const candidates = [today];
  if (inGrace(now)) {
    const y = await dailyTarget(now - DAY_MS);
    if (y) candidates.push(y);
  }
  const sameDay = candidates.filter((t) => t.dayIndex === k.dayIndex);
  if (sameDay.length === 0) return { ok: false, reason: 'badBoard' };
  const t = sameDay.find((c) => c.key === run.board);
  if (!t) return { ok: false, reason: 'stale' };
  if (run.level !== t.levelId) return { ok: false, reason: 'badBoard' };
  return { ok: true, target: t };
}

// ---- Replay decoding (§7.8 step 3) ----

/** base64url length of REPLAY_MAX_BYTES; longer strings are rejected before decoding. */
const REPLAY_MAX_CHARS = Math.ceil((REPLAY_MAX_BYTES * 4) / 3);
const FORBIDDEN_FLAGS = ReplayFlag.Assisted | ReplayFlag.Practice;

export type Decoded =
  | { ok: true; bytes: Uint8Array; qs: Int8Array; nTicks: number }
  | { ok: false; reason: 'badReplay' | 'tooLong' };

// Replay header layout (§10.4 "リプレイの形式"): 0-1 magic "YP", 2 fmt, 3 sim, 4-7 levelHash (uint32 LE),
// 8 device, 9 flags, then the nTicks varint.
const HEADER_BYTES = 10;

/** The nTicks varint (unsigned LEB128) at `p`, or null when it is truncated / longer than 5 bytes. */
function peekVarint(bytes: Uint8Array, p: number): number | null {
  let v = 0;
  let mul = 1;
  for (let k = 0; k < 5 && p + k < bytes.length; k++) {
    const b = bytes[p + k]!;
    v += (b & 127) * mul;
    if (b < 128) return v;
    mul *= 128;
  }
  return null;
}

/**
 * §7.8 step 3 in the order of the spec: size, magic, fmt, sim and levelHash -> badReplay; nTicks > 2700 -> tooLong
 * (read from the header before the full decode, so even a header claiming more than the 60 s time-up is tooLong);
 * then a full decode (q range, structure), first q = 0 and the assisted / practice flags -> badReplay.
 */
export function decodeRun(replay: string, target: Target): Decoded {
  if (replay.length === 0 || replay.length > REPLAY_MAX_CHARS) return { ok: false, reason: 'badReplay' };
  let bytes: Uint8Array;
  try {
    bytes = b64urlDecode(replay);
  } catch {
    return { ok: false, reason: 'badReplay' };
  }
  if (bytes.length > REPLAY_MAX_BYTES || bytes.length <= HEADER_BYTES) return { ok: false, reason: 'badReplay' };
  if (bytes[0] !== 0x59 || bytes[1] !== 0x50 || bytes[2] !== 1 || bytes[3] !== SIM_VERSION) return { ok: false, reason: 'badReplay' };
  const hash = ((bytes[4]! | (bytes[5]! << 8) | (bytes[6]! << 16) | (bytes[7]! << 24)) >>> 0).toString(16).padStart(8, '0');
  if (hash !== target.hash) return { ok: false, reason: 'badReplay' };
  const claimedTicks = peekVarint(bytes, HEADER_BYTES);
  if (claimedTicks === null) return { ok: false, reason: 'badReplay' };
  if (claimedTicks > RANKED_MAX_TICKS) return { ok: false, reason: 'tooLong' };
  let dec: ReturnType<typeof decodeReplay>;
  try {
    dec = decodeReplay(bytes);
  } catch {
    return { ok: false, reason: 'badReplay' };
  }
  const { h, qs } = dec;
  if (h.fmt !== 1 || h.sim !== SIM_VERSION || h.levelHash !== target.hash) return { ok: false, reason: 'badReplay' };
  if (h.nTicks > RANKED_MAX_TICKS || qs.length > RANKED_MAX_TICKS) return { ok: false, reason: 'tooLong' };
  if (qs.length === 0 || qs.length !== h.nTicks || qs[0] === 0) return { ok: false, reason: 'badReplay' };
  if ((h.flags & FORBIDDEN_FLAGS) !== 0) return { ok: false, reason: 'badReplay' };
  for (let i = 0; i < qs.length; i++) if (qs[i]! < -127) return { ok: false, reason: 'badReplay' };
  return { ok: true, bytes, qs, nTicks: qs.length };
}

// ---- Re-simulation (§7.8 steps 4-5) ----

export type Simulated =
  | { ok: true; t120: number; gapUm: number | null; peakCn: number }
  | { ok: false; reason: 'mismatch'; got: number | null; status: number; ticks: number };

/**
 * Success must happen on the last tick: nTicks = ceil((score + 59) / 2) (§4.6), and score must equal the claim.
 * gapUm is null on levels without walls.
 */
export function simulateRun(target: Target, qs: Int8Array, claimed: number): Simulated {
  const r = simulateReplay(target.phys, qs);
  const score = r.status === Status.Success ? r.score : null;
  if (score === null || score !== claimed || qs.length !== Math.ceil((score + 59) / 2)) {
    return { ok: false, reason: 'mismatch', got: score, status: r.status, ticks: r.ticks };
  }
  let gapUm: number | null = null;
  if (target.phys.walls.length > 0) {
    const c = ballClearanceM(r.minD2);
    if (Number.isFinite(c)) gapUm = Math.max(-2147483648, Math.min(2147483647, Math.round(c * 1e6)));
  }
  const peakCn = Number.isFinite(r.peakF) ? Math.max(0, Math.round(r.peakF * 100)) : 0;
  return { ok: true, t120: score, gapUm, peakCn };
}
