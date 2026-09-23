// Shared helpers for the Worker tests (vitest-pool-workers, local D1). Owner: O9.
import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../../worker/index';
import { createRun, stepTick, Status } from '../../src/sim/run';
import { SimEvents } from '../../src/sim/events';
import { encodeReplay, DeviceTag } from '../../src/sim/replay';
import { b64urlEncode } from '../../src/sim/b64';
import { levelHash, type DailyDef, type LevelDef, type LevelPhysics, type LevelsFile } from '../../src/sim/level';
import { SIM_VERSION } from '../../src/sim/constants';
import { DAILY_EPOCH, DAY_MS, pickDaily } from '../../src/shared/daily';
import { dailyBoardKey, levelBoardKey, type BoardRow, type SubmitRequest, type SubmitRun } from '../../src/shared/api';
import { pidhFromSecret } from '../../src/shared/names';
import levelsJson from '../../src/data/levels.json';
import { decodeChannelValues } from '../../src/core/ghostcodec';
import ghost13 from '../../src/data/ghosts/1-3.json';
import ghost14 from '../../src/data/ghosts/1-4.json';
import ghost21 from '../../src/data/ghosts/2-1.json';
import ghost24 from '../../src/data/ghosts/2-4.json';
import ghost43 from '../../src/data/ghosts/4-3.json';
import ghost51 from '../../src/data/ghosts/5-1.json';
import ghost52 from '../../src/data/ghosts/5-2.json';
import { bootCacheUrl, resetBootMemoForTest } from '../../worker/routes/boot';
import { setSubmitIsolateForTest } from '../../worker/routes/submit';
import { resetLimitsForTest, setClockForTest } from '../../worker/limits';
import { setDailyPoolForTest, setParOverrideForTest } from '../../worker/verify';
import type { Env } from '../../worker/index';

export const LEVELS = (levelsJson as unknown as LevelsFile).levels;
export const level = (id: string): LevelDef => LEVELS.find((l) => l.id === id)!;

/** 2026-10-10 12:00 JST: dayIndex 9. */
export const NOW = DAILY_EPOCH + 9 * DAY_MS + 12 * 3600 * 1000;

// ---- Requests ----

let ipSeq = 0;
/** Random per test file (24 bits): the sequences of two files never share a rate-limit key within the same minute. */
const IP_RANDOM = crypto.getRandomValues(new Uint16Array(2));
const IP_PREFIX = `${(0xfd00 | (IP_RANDOM[0]! & 0xff)).toString(16)}:${IP_RANDOM[1]!.toString(16)}`;
/**
 * A fresh client IP per call so that the real RL_* bindings (6 / 30 per minute) never trip by accident. The Worker keys
 * IPv6 clients by their /64 (limits.ts rateKey), so the sequence number goes into the network part of the address.
 */
export function freshIp(): string {
  ipSeq++;
  return `${IP_PREFIX}:${(ipSeq >>> 16).toString(16)}:${(ipSeq & 0xffff).toString(16)}::1`;
}

/** Calls the Worker's fetch handler directly (same isolate, so the module test hooks apply) and waits for waitUntil. */
export async function call(path: string, init: RequestInit & { ip?: string } = {}, envOverride: Partial<Env> = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has('CF-Connecting-IP')) headers.set('CF-Connecting-IP', init.ip ?? freshIp());
  const req = new Request(`https://yurapita.test${path}`, { ...init, headers });
  const ctx = createExecutionContext();
  const res = await worker.fetch(req as Request<unknown, IncomingRequestCfProperties>, { ...(env as unknown as Env), ...envOverride }, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/**
 * The emulated RL_* bindings count in fixed windows aligned to the wall-clock minute (miniflare's RateLimiterObject),
 * so a burst that straddles a minute boundary is split over two windows. Tests that expect the Nth request to be
 * limited call this first: it waits for the next window when fewer than 3 s are left in the current one.
 */
export async function awayFromMinuteBoundary(): Promise<void> {
  const left = 60_000 - (Date.now() % 60_000);
  if (left < 3000) await new Promise((r) => setTimeout(r, left + 50));
}

export async function submit(body: unknown, opts: { ip?: string; env?: Partial<Env> } = {}): Promise<Response> {
  return call('/api/submit', {
    method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' }, ...(opts.ip ? { ip: opts.ip } : {}),
  }, opts.env);
}

// ---- Players ----

/** Deterministic 16-byte secret #i as base64url (22 chars). */
export function secretOf(i: number): string {
  const b = new Uint8Array(16);
  for (let k = 0; k < 16; k++) b[k] = (i * 37 + k * 11 + (i >> 8)) & 255;
  return b64urlEncode(b);
}
export const pidhOf = (i: number): string => pidhFromSecret(secretOf(i))!;

export function request(i: number, runs: SubmitRun[], nameSeed = 100 + i): SubmitRequest {
  return { v: 1, secret: secretOf(i), nameSeed, runs };
}

// ---- Keys and the fake daily pool ----

export const levelKey = (id: string): string => levelBoardKey(id, levelHash(level(id).physics));

/**
 * 84 daily entries (12 per tier) that all use the 1-1 physics, so the success bot solves every daily.
 * ids are "d:<i>" as in daily_pool.json; parSub is 3000 (50 s) so every bot run beats the "AI".
 */
export function fakeDailyPool(parSub = 3000, distinct = false): DailyDef[] {
  const base = level('1-1');
  const pool: DailyDef[] = [];
  for (let i = 0; i < 84; i++) {
    // distinct: every entry gets its own levelHash (restDeg + i/100), like a real pool; the bots are not used then.
    const physics = { ...base.physics, phases: base.physics.phases.map((z) => ({ ...z })), ...(distinct ? { restDeg: base.physics.restDeg + i / 100 } : {}) };
    pool.push({
      ...base, id: `d:${i}`, world: 0, order: i, tier: (Math.floor(i / 12) + 1) as DailyDef['tier'],
      template: 'hop', parSub, physics,
    });
  }
  return pool;
}

export interface DailyInfo { key: string; levelId: string; dayIndex: number; phys: LevelPhysics }
export function dailyAt(pool: readonly DailyDef[], now: number): DailyInfo {
  const p = pickDaily(pool, now);
  return { key: dailyBoardKey(p.dayIndex, levelHash(p.level.physics)), levelId: p.level.id, dayIndex: p.dayIndex, phys: p.level.physics };
}

// ---- Reset ----

export async function resetAll(opts: { now?: number; pool?: DailyDef[] | null } = {}): Promise<void> {
  await env.DB.batch([env.DB.prepare('DELETE FROM runs'), env.DB.prepare('DELETE FROM boards'), env.DB.prepare('DELETE FROM counters')]);
  resetBootMemoForTest();
  resetLimitsForTest();
  setParOverrideForTest(null);
  const now = opts.now ?? NOW;
  setClockForTest(() => now);
  setDailyPoolForTest(opts.pool === undefined ? fakeDailyPool() : opts.pool);
  await caches.default.delete(bootCacheUrl('https://yurapita.test', now));
  // Most tests are not about the cold-isolate rule (§7.8 step 1): start from a warm isolate.
  setSubmitIsolateForTest(false);
}

// ---- Bots ----

export interface BotRun { qs: Int8Array; t120: number; nTicks: number; replay: string }

/**
 * A deterministic controller that carries the ball to the middle of the first zone and settles it (no walls in the
 * way, i.e. for 1-1 physics). `waitTicks` idles first (q = 0 after a non-zero first tick); `moveS` sets the speed
 * of the minimum-jerk reference move, so different values give different times.
 */
export function successBot(phys: LevelPhysics, opts: { waitTicks?: number; moveS?: number; device?: DeviceTag } = {}): BotRun {
  const run = createRun(phys);
  const s = run.s;
  const ev = new SimEvents();
  const zone = phys.phases[0]!;
  const x0 = phys.startX, x1 = (zone.xa + zone.xb) / 2;
  const D = opts.moveS ?? 3.0;
  const wait = opts.waitTicks ?? 0;
  const Mt = phys.M + phys.m;
  const qs: number[] = [];
  for (let tick = 0; tick < 3600; tick++) {
    let q: number;
    if (tick === 0) q = 1;
    else if (tick < wait) q = 0;
    else {
      const t = Math.min(1, (tick - wait) / 60 / D);
      const r = x1 - x0;
      const xr = x0 + r * (10 * t ** 3 - 15 * t ** 4 + 6 * t ** 5);
      const vr = t >= 1 ? 0 : (r * (30 * t ** 2 - 60 * t ** 3 + 30 * t ** 4)) / D;
      const ar = t >= 1 ? 0 : (r * (60 * t - 180 * t ** 2 + 120 * t ** 3)) / (D * D);
      const F = Mt * (ar + 6 * (xr - s.x) + 5 * (vr - s.v) + 3 * phys.L * s.w);
      q = Math.max(-127, Math.min(127, Math.round((F / phys.Fmax) * 127)));
    }
    qs.push(q);
    const st = stepTick(run, q, ev);
    if (st === Status.Success) break;
    if (st !== Status.Running) throw new Error(`bot: run ended with status ${st} at tick ${tick}`);
  }
  if (s.status !== Status.Success) throw new Error('bot: no success within 60 s');
  const arr = Int8Array.from(qs);
  const bytes = encodeReplay(
    { fmt: 1, sim: SIM_VERSION, levelHash: levelHash(phys), device: opts.device ?? DeviceTag.Touch, flags: 0, nTicks: arr.length }, arr,
  );
  return { qs: arr, t120: s.score, nTicks: arr.length, replay: b64urlEncode(bytes) };
}

/** A success run of ~45 s (2500..2700 ticks): idles first, then carries the ball over. */
export function longBot(phys: LevelPhysics): BotRun {
  for (let wait = 2330; wait > 1800; wait -= 10) {
    const b = successBot(phys, { moveS: 4, waitTicks: wait });
    if (b.nTicks <= 2700 && b.nTicks >= 2500) return b;
  }
  throw new Error('longBot: no 2500..2700 tick run found');
}

interface GhostFile { levelId: string; ghosts: { kind: string; f: string }[] }
const WALL_GHOSTS = [ghost13, ghost14, ghost21, ghost24, ghost43, ghost51, ghost52] as unknown as GhostFile[];

/**
 * A success run on a level WITH walls: the bundled AI ghost's force profile (60 Hz) quantised to q, then a
 * position-holding servo once the profile ends. Returns null when the quantised run does not succeed
 * (the background ghost run may rewrite those files; callers take the first levels that work).
 */
export function aiBot(levelId: string): BotRun | null {
  const g = WALL_GHOSTS.find((x) => x.levelId === levelId)?.ghosts.find((x) => x.kind === 'ai');
  if (!g) return null;
  const phys = level(levelId).physics;
  const f = decodeChannelValues(g.f, 'f');
  const run = createRun(phys);
  const s = run.s;
  const ev = new SimEvents();
  const qs: number[] = [];
  let hold = NaN;
  for (let tick = 0; tick < 2700; tick++) {
    let q: number;
    if (tick < f.length) {
      q = Math.round((f[tick]! / phys.Fmax) * 127);
    } else {
      if (Number.isNaN(hold)) hold = s.x;
      q = Math.round(((20 / 3) * (phys.M + phys.m) * (Math.max(-4, Math.min(4, 5 * (hold - s.x))) - s.v) / phys.Fmax) * 127);
    }
    q = Math.max(-127, Math.min(127, q));
    if (tick === 0 && q === 0) q = 1;
    qs.push(q);
    const st = stepTick(run, q, ev);
    if (st === Status.Success) break;
    if (st !== Status.Running) return null;
  }
  if (s.status !== Status.Success) return null;
  const arr = Int8Array.from(qs);
  return { qs: arr, t120: s.score, nTicks: arr.length, replay: encode(phys, arr) };
}

/** The first `k` walled levels whose AI bot succeeds, with their bots. */
export function wallBots(k: number): { levelId: string; bot: BotRun }[] {
  const out: { levelId: string; bot: BotRun }[] = [];
  for (const g of WALL_GHOSTS) {
    if (out.length >= k) break;
    const bot = aiBot(g.levelId);
    if (bot) out.push({ levelId: g.levelId, bot });
  }
  if (out.length < k) throw new Error(`wallBots: only ${out.length} of ${k} walled AI bots succeed`);
  return out;
}

export function encode(phys: LevelPhysics, qs: Int8Array, flags = 0): string {
  return b64urlEncode(encodeReplay({ fmt: 1, sim: SIM_VERSION, levelHash: levelHash(phys), device: DeviceTag.Touch, flags, nTicks: qs.length }, qs));
}

// ---- D1 fixtures ----

/** Writes a boards row with `rows` in top (and matching runs rows with a 1-byte replay). */
export async function seedBoard(key: string, rows: BoardRow[], extra: { par?: number; n?: number; cleared?: number; hist?: number[] } = {}): Promise<void> {
  const stmts = [
    env.DB.prepare('INSERT INTO boards (board, par, top, n, cleared, hist) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(key, extra.par ?? 100, JSON.stringify(rows), extra.n ?? rows.length, extra.cleared ?? 0, extra.hist ? JSON.stringify(extra.hist) : null),
  ];
  for (const r of rows) {
    stmts.push(env.DB.prepare('INSERT INTO runs (board, pidh, name_seed, t120, gap_um, peak_cn, device, replay, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(key, r[0], r[1], r[2], r[3], 1000, r[4], new Uint8Array([1, 2, 3]), r[5]));
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
}

/** n synthetic rows with times start, start+step, ... (pidh "f000000000000xyz"). */
export function fakeRows(n: number, start: number, step = 1): BoardRow[] {
  const rows: BoardRow[] = [];
  for (let i = 0; i < n; i++) rows.push([`f${String(i).padStart(15, '0')}`, i, start + i * step, 5000, 1, 1_000_000 + i]);
  return rows;
}

export async function boardRow(key: string): Promise<{ ver: number; top: string; n: number; cleared: number; ai_beaten: number; par: number; hist: string | null; wr: number[] | null; tok: string | null } | null> {
  return env.DB.prepare('SELECT * FROM boards WHERE board = ?').bind(key).first();
}

export async function runRow(key: string, pidh: string): Promise<{ t120: number | null; replay: number[] | null; tries: number; balls: string | null; name_seed: number; gap_um: number | null; peak_cn: number | null } | null> {
  return env.DB.prepare('SELECT * FROM runs WHERE board = ? AND pidh = ?').bind(key, pidh).first();
}

// ---- D1 proxies (statement counting and injected conflicts) ----

export interface ProxyDb { db: D1Database; count: () => number; sqls: string[] }

/**
 * Wraps the real D1 binding: counts every statement (each statement of a batch counts once) and lets a test run
 * something right before a batch that contains a matching statement (to simulate a concurrent writer).
 */
export function proxyDb(real: D1Database, beforeBatch?: (sqls: string[]) => Promise<void>): ProxyDb {
  let n = 0;
  const sqls: string[] = [];
  const realOf = new WeakMap<object, D1PreparedStatement>();
  const sqlOf = new WeakMap<object, string>();
  const wrap = (stmt: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const p = new Proxy(stmt, {
      get(t, k) {
        if (k === 'bind') return (...a: unknown[]) => wrap(t.bind(...a), sql);
        if (k === 'first' || k === 'all' || k === 'run' || k === 'raw') {
          return (...a: unknown[]) => {
            n++;
            sqls.push(sql);
            return (t[k] as (...x: unknown[]) => unknown).apply(t, a);
          };
        }
        const v: unknown = Reflect.get(t, k, t);
        return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(t) : v;
      },
    });
    realOf.set(p, stmt);
    sqlOf.set(p, sql);
    return p;
  };
  const db = {
    prepare: (sql: string) => wrap(real.prepare(sql), sql),
    batch: async (stmts: D1PreparedStatement[]) => {
      n += stmts.length;
      const ss = stmts.map((s) => sqlOf.get(s) ?? '?');
      sqls.push(...ss);
      if (beforeBatch) await beforeBatch(ss);
      return real.batch(stmts.map((s) => realOf.get(s) ?? s));
    },
    exec: (q: string) => real.exec(q),
    dump: () => { throw new Error('no'); },
    withSession: () => { throw new Error('no'); },
  } as unknown as D1Database;
  return { db, count: () => n, sqls };
}

/** A concurrent writer: bumps ver (creating the row if needed) and leaves its own tok. */
export async function concurrentWrite(key: string): Promise<void> {
  await env.DB.prepare("INSERT INTO boards (board, par, ver, tok) VALUES (?, 1, 1, 'other') ON CONFLICT(board) DO UPDATE SET ver = ver + 1, tok = 'other'")
    .bind(key).run();
}

export const BOARD_UPDATE_SQL = 'UPDATE boards SET ver = ver + 1';
