// API client with offline detection and backoff (GAME_DESIGN.md §7.7, §7.9, §7.12, §10.4 "ネット"). Owner: O8.
//
// Enabled only when VITE_NET !== 'off', location is http(s) and a boot succeeded within 3 s. Any 429 /
// 5xx / non-JSON answer (e.g. Cloudflare's 1027 page) / network error silently switches to offline;
// retries then wait 1 -> 2 -> 4 -> 8 -> 16 -> 30 (-> 30 ...) minutes. Nothing here ever throws or logs.
//
// Sending discipline (§7.9):
// - enqueue() classifies a level run against the boot board (levelClass): 'rankIn' can enter the top 100, 'urgent' is a
//   first AI-beaten, 'lazy' a first placement or a histogram move (LevelProgress.sentSub = the server's plays.t120), and
//   null means the server would write nothing: it is not queued. Dailies: once a day. The best run per board is kept
//   in SaveV1.outbox.
// - flush() sends one batch (4 runs / 16 KB / 5400 substeps) at most every 120 s, always with keepalive. Exempt:
//   'dailyDone', 'rankIn' (its board first, its own 15 s interval; a throttled one is deferred, never dropped), and
//   'pagehide' with a daily or a rank-in run waiting. menu / select leave a batch of < 4 lazy runs (queued this
//   session) for a pagehide; under soft (§7.8 9b) lazy runs stay queued.
// - deferred (and rejected:lite) stay queued; accepted / unranked / notBetter / rejected are dropped. Level answers
//   set sentSub from `counted`, patch the boot board (cutoff, n, my histogram bin) and reach onResults() listeners.
import type {
  BoardResponse, BootBoard, BootResponse, GhostResponse, SubmitRequest, SubmitResponse, SubmitResult,
} from '../shared/api';
import { HIST_BINS } from '../shared/api';
import { LEVEL_HIST_BINS, levelBin, padHist, trimHist } from '../shared/rank';
import type { SaveV1, Store } from '../store/save';
import {
  BATCH_MAX_RUNS, boardDay, dailyFallback, dailyPrev, enqueueRun, isBetter, isDailyBoard, isSendable, takeBatch, type PendingRun,
} from './outbox';

/** Why a flush happens (§7.9). 'rankIn': a top-100 candidate PB at the success tick, its board first. */
export type FlushReason = 'menu' | 'select' | 'pagehide' | 'dailyDone' | 'rankIn';

export interface Api {
  readonly enabled: boolean; readonly lite: boolean;
  boot(dayIndex: number): Promise<BootResponse | null>;       // null on failure (treated as offline)
  flush(reason: FlushReason, opts?: { first?: string }): Promise<SubmitResponse | null>;
  enqueue(r: PendingRun): void;
  /**
   * GET /api/ghost/:key/:rank (a top-100 replay): the rival ghost and the ranking's replay viewer share one budget of
   * GHOST_MAX_PER_SESSION requests and one cache (kept in sessionStorage). `opts`: the row the caller saw at that rank; a
   * cached answer for another player or time is fetched again. Null when not allowed, lite, over budget or not found.
   */
  ghost(key: string, rank: number, opts?: GhostOpts): Promise<GhostResponse | null>;
  board(key: string): Promise<BoardResponse | null>;
}

/** The row a ghost request is for (Api.ghost): an answer cached for another player / time at that rank is stale. */
export interface GhostOpts { pidh?: string; t120?: number }

/** Gets every submit answer after it was applied to the save: the runs of the request and the server's results. */
export type ResultsListener = (sent: readonly PendingRun[], results: readonly SubmitResult[]) => void;

/** The concrete client: the contract plus read-only extras for the wiring code. */
export interface NetApi extends Api {
  /** The last boot answer of this session (null before a successful boot). */
  lastBoot(): BootResponse | null;
  /** The server is in READ_ONLY mode (§7.7): nothing is sent, queued runs wait. */
  readonly readOnly: boolean;
  /**
   * The first boot of the session is still on its way (at most 3 s). The UI should not flash the
   * 「オフライン」 chip meanwhile: show it for `!enabled && !booting`.
   */
  readonly booting: boolean;
  /** The soft valve is on (§7.8 9b; from the boot or a submit answer, then for the session): lazy runs stay queued. */
  readonly soft: boolean;
  /** Subscribes to submit answers (every flush reason); returns the unsubscribe function. */
  onResults(cb: ResultsListener): () => void;
  /** /api/ghost requests this session may still make (0: only cached answers; rival and replay viewer share them). */
  ghostsLeft(): number;
}

export const BOOT_TIMEOUT_MS = 3000;
export const REQUEST_TIMEOUT_MS = 10_000;
/** A time limit whose timer fires this much later than asked was held up by a blocked main thread [ms]. */
export const LATE_TIMER_MS = 250;
export const BOOT_CACHE_MS = 10 * 60 * 1000;
export const BOOT_CACHE_KEY = 'yurapita:boot';
export const GHOST_COUNT_KEY = 'yurapita:ghosts';
/** The session's ghost answers (each replay <= 8 KB of base64url), so a reload does not pay for them again. */
export const GHOST_CACHE_KEY = 'yurapita:ghostCache';
/** /api/ghost requests per session: the rival (§7.6) and the ranking's replay viewer together (§7.10). */
export const GHOST_MAX_PER_SESSION = 3;
/** Ghost answers kept (memory and sessionStorage): the budget plus a few from an earlier budget of the same tab. */
export const GHOST_CACHE_MAX = 6;
export const BOARD_CACHE_MS = 60_000;
export const SEND_MIN_INTERVAL_MS = 120_000;
/** Minimum gap between two rank-in sends; a throttled one is deferred to the end of the gap, not dropped. */
export const RANKIN_MIN_INTERVAL_MS = 15_000;
/** Retry delays after consecutive failures, in minutes (the last one repeats). */
export const BACKOFF_MINUTES: readonly number[] = [1, 2, 4, 8, 16, 30];

/** Delay before the next attempt after `failures` consecutive failures (0 -> no wait). */
export function backoffDelayMs(failures: number): number {
  if (failures <= 0) return 0;
  return BACKOFF_MINUTES[Math.min(failures, BACKOFF_MINUTES.length) - 1]! * 60_000;
}

function currentProtocol(): string {
  try {
    return globalThis.location?.protocol ?? '';
  } catch {
    return '';
  }
}

/** §7.12: VITE_NET !== 'off' and an http(s) page. (The third condition, a successful boot, is `enabled`.) */
export function netAllowed(net: string | undefined = import.meta.env.VITE_NET, protocol: string = currentProtocol()): boolean {
  return net !== 'off' && (protocol === 'http:' || protocol === 'https:');
}

interface SessionLike { getItem(key: string): string | null; setItem(key: string, value: string): void }

export interface ApiOptions {
  fetch?: typeof fetch;
  now?: () => number;
  /** sessionStorage (boot cache, ghost count); null disables it. */
  session?: SessionLike | null;
  /** Overrides import.meta.env.VITE_NET. */
  net?: string;
  /** Overrides location.protocol. */
  protocol?: string;
  /** Prefix for the API URLs (same origin: ''). */
  base?: string;
  bootTimeoutMs?: number;
  requestTimeoutMs?: number;
}

// ---- level classes (§7.9) ----

/**
 * rankIn: can enter the top 100 (the boot cutoff); urgent: the first run below par on this board; lazy: the server
 * would move my histogram position (a first placement, or a faster run in another bin); null: the server would write
 * nothing, so the run is not sent. `b` is the boot board of the run's key.
 * Lite is not looked at here: lite keeps every level run queued (takeBatch skipLevels) and a top-100 run must survive it.
 */
export type LevelClass = 'rankIn' | 'urgent' | 'lazy' | null;
export function levelClass(r: PendingRun, d: SaveV1, b: BootBoard): LevelClass {
  const t = r.t120;
  if (t === null) return null;
  const p = d.levels[r.level];
  if (b.cutoff === null || t < b.cutoff) return 'rankIn';
  if (t < b.par && p?.aiBeatenSent !== true) return 'urgent';
  if (p?.sentSub === undefined) return 'lazy';
  if (t < p.sentSub && levelBin(t) !== levelBin(p.sentSub)) return 'lazy';
  return null;
}

/** The level histogram of a boot board as a dense LEVEL_HIST_BINS array; null when absent or malformed. */
export function levelHistOf(b: BootBoard): number[] | null {
  return b.hist === undefined ? null : padHist(b.hist, LEVEL_HIST_BINS);
}

/** The histogram of a board answer (level: 153 bins, daily: 150); null when absent or malformed. */
export function boardHistOf(r: BoardResponse): number[] | null {
  return r.hist === undefined ? null : padHist(r.hist, r.key.startsWith('D:') ? HIST_BINS : LEVEL_HIST_BINS);
}

// ---- response validation (never trust the wire) ----

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isRow = (x: unknown): boolean => Array.isArray(x) && x.length >= 6 && typeof x[0] === 'string' && x.slice(1, 6).every(isNum);
const isRows = (x: unknown): boolean => Array.isArray(x) && x.every(isRow);
/** wr: base64url replay of rank 1, or null / absent. */
const isWr = (x: unknown): boolean => x === undefined || x === null || typeof x === 'string';
const isCutoff = (x: unknown): boolean => x === null || isNum(x);

// The fields checked here are the ones the UI renders (counts, "AI に勝った人", cutoff, top rows, the
// daily histogram for "上位 n%"): an answer missing them is treated like no answer (offline), never NaN.
// A level histogram is not checked: a bad one only hides the estimates (levelHistOf / boardHistOf return null).
function isBootBoard(x: unknown): x is BootBoard {
  return isObj(x) && typeof x.key === 'string' && isNum(x.n) && isNum(x.aiBeaten) && isNum(x.par) && isCutoff(x.cutoff)
    && isRows(x.top) && isWr(x.wr);
}
function isBootDaily(x: unknown): boolean {
  return isObj(x) && typeof x.key === 'string' && isNum(x.n) && isNum(x.cleared) && isNum(x.aiBeaten) && isNum(x.par)
    && isRows(x.top) && Array.isArray(x.hist) && x.hist.every(isNum) && isWr(x.wr);
}
export function isBootResponse(x: unknown): x is BootResponse {
  return isObj(x) && x.v === 1 && isNum(x.sim) && isNum(x.day) && typeof x.lite === 'boolean'
    && isObj(x.boards) && Object.values(x.boards).every(isBootBoard) && isBootDaily(x.daily);
}
function isSubmitResponse(x: unknown): x is SubmitResponse {
  return isObj(x) && Array.isArray(x.results) && x.results.every((r) => isObj(r) && typeof r.board === 'string' && typeof r.status === 'string');
}
function isGhostResponse(x: unknown): x is GhostResponse {
  return isObj(x) && typeof x.key === 'string' && typeof x.pidh === 'string' && isNum(x.rank) && isNum(x.nameSeed)
    && isNum(x.t120) && typeof x.replay === 'string' && x.replay.length > 0;
}
function isBoardResponse(x: unknown): x is BoardResponse {
  return isObj(x) && typeof x.key === 'string' && isNum(x.n) && isNum(x.aiBeaten) && isCutoff(x.cutoff) && isRows(x.top);
}

const KEY_RE = /^[LD]:[0-9a-z-]+:[0-9a-f]{8}:s[0-9]+$/;

type Outcome = { kind: 'ok'; json: unknown } | { kind: 'offline' } | { kind: 'client'; status: number };

interface Optimistic { board: string; run: PendingRun; submitted: SaveV1['daily']['submitted']; lastSentT120: number | null; dayIndex: number }
/** One submit request on the wire; `optimistic` can grow while it is out (a pagehide during the request). */
interface Flight { sent: PendingRun[]; optimistic: Optimistic[]; done: Promise<SubmitResponse | null> | null }
/** A rank-in send waiting for the end of its 15 s gap: one timer, every caller gets the same answer. */
interface DeferredRankIn {
  first: string; promise: Promise<SubmitResponse | null>; timer: ReturnType<typeof setTimeout> | null;
  resolve(p: Promise<SubmitResponse | null> | SubmitResponse | null): void;
}

function defaultSession(): SessionLike | null {
  try {
    return (globalThis as { sessionStorage?: Storage }).sessionStorage ?? null;
  } catch {
    return null;
  }
}

export function createApi(store: Store, opts: ApiOptions = {}): NetApi {
  const allowed = netAllowed(opts.net ?? import.meta.env.VITE_NET, opts.protocol ?? currentProtocol());
  const doFetch: typeof fetch | null = opts.fetch ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
  const now = opts.now ?? Date.now;
  const session = opts.session === undefined ? defaultSession() : opts.session;
  const base = opts.base ?? '';
  const bootTimeout = opts.bootTimeoutMs ?? BOOT_TIMEOUT_MS;
  const reqTimeout = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;

  let booted: { res: BootResponse; at: number; day: number } | null = null;
  let bootedOk = false;              // a boot succeeded this session (§7.12 third condition)
  let bootInFlight: Promise<BootResponse | null> | null = null;
  let lastDay: number | null = null;
  let failures = 0;                  // consecutive offline-class failures
  let retryAt = 0;
  let bootLite = false;              // lite flag of the last boot answer
  let liteSticky = false;            // a submit said lite: stays on for the rest of the session ("その日は")
  let readOnly = false;
  let bootSoft = false;              // soft flag of the last boot answer
  let softSticky = false;            // a submit said soft: stays on for the session
  let lastSendAt = -Infinity;
  let lastRankInAt = -Infinity;
  let deferredRankIn: DeferredRankIn | null = null;
  const sessionStart = now();        // lazy sending applies only to runs queued after this (§7.9)
  const inFlight = new Set<string>();
  const flights = new Set<Flight>();
  const boardCache = new Map<string, { at: number; res: BoardResponse }>();
  /** Boards whose next board() skips every cache (an accepted run of mine just changed them). */
  const noStore = new Set<string>();
  const listeners = new Set<ResultsListener>();

  const sessionGet = (k: string): string | null => {
    try {
      return session?.getItem(k) ?? null;
    } catch {
      return null;
    }
  };
  const sessionSet = (k: string, v: string): void => {
    try {
      session?.setItem(k, v);
    } catch {
      // quota / disabled: the cache is an optimisation only
    }
  };

  let ghostCount = Number(sessionGet(GHOST_COUNT_KEY)) || 0;
  const ghostCache = new Map<string, GhostResponse>(readGhostCache());

  /** The ghost answers of this tab's session (sessionStorage), validated like a fresh answer. */
  function readGhostCache(): [string, GhostResponse][] {
    try {
      const raw = JSON.parse(sessionGet(GHOST_CACHE_KEY) ?? '[]') as unknown;
      if (!Array.isArray(raw)) return [];
      return raw.filter((e): e is [string, GhostResponse] => Array.isArray(e) && typeof e[0] === 'string' && isGhostResponse(e[1])).slice(-GHOST_CACHE_MAX);
    } catch {
      return [];
    }
  }

  function cacheGhost(ck: string, g: GhostResponse): void {
    ghostCache.delete(ck);
    ghostCache.set(ck, g);
    while (ghostCache.size > GHOST_CACHE_MAX) ghostCache.delete(ghostCache.keys().next().value!);
    sessionSet(GHOST_CACHE_KEY, JSON.stringify([...ghostCache]));
  }

  const online = (): boolean => allowed && bootedOk && failures === 0;
  const retryDue = (): boolean => failures === 0 || now() >= retryAt;
  function fail(): void {
    failures++;
    retryAt = now() + backoffDelayMs(failures);
  }
  function succeed(): void {
    failures = 0;
    retryAt = 0;
  }

  /**
   * One request. fetch() is called synchronously (pagehide relies on it). Never throws.
   * The time limit gives up at most once more before it declares the request offline: when the response headers
   * are already in (only the body is still coming), and when the timer itself fired late because the main thread
   * was blocked (a first frame compiling its shaders, a slow phone): the answer may then be sitting in the task
   * queue behind the timer. Either way the request gets one more period (at most `timeoutMs`).
   */
  function request(path: string, init: RequestInit, timeoutMs: number): Promise<Outcome> {
    if (!doFetch) return Promise.resolve({ kind: 'offline' });
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let headersIn = false;
    let extended = false;
    const t0 = now();
    const timeout = new Promise<Outcome>((resolve) => {
      const expire = (): void => {
        timer = null;
        const late = now() - t0 - timeoutMs;
        if (!extended && (headersIn || late > LATE_TIMER_MS)) {
          extended = true;
          timer = setTimeout(expire, headersIn ? timeoutMs : Math.min(timeoutMs, Math.max(late, LATE_TIMER_MS)));
          return;
        }
        try {
          ctl?.abort();
        } catch {
          // ignore
        }
        resolve({ kind: 'offline' });
      };
      timer = setTimeout(expire, timeoutMs);
    });
    let started: Promise<Response>;
    try {
      started = doFetch(base + path, ctl ? { ...init, signal: ctl.signal } : init);
    } catch {
      started = Promise.reject(new Error('fetch threw'));
    }
    started.then(() => {
      headersIn = true;
    }, () => undefined);
    const work = (async (): Promise<Outcome> => {
      try {
        const res = await started;
        if (res.status === 429 || res.status >= 500) return { kind: 'offline' };
        if (!res.ok) return { kind: 'client', status: res.status };
        try {
          return { kind: 'ok', json: await res.json() };
        } catch {
          return { kind: 'offline' };   // HTML error page (e.g. 1027) or SPA fallback instead of the API
        }
      } catch {
        return { kind: 'offline' };
      }
    })();
    return Promise.race([work, timeout]).finally(() => {
      if (timer !== null) clearTimeout(timer);
    });
  }

  // ---- boot ----

  function readBootCache(day: number): BootResponse | null {
    const raw = sessionGet(BOOT_CACHE_KEY);
    if (!raw) return null;
    try {
      const c = JSON.parse(raw) as unknown;
      if (!isObj(c) || c.day !== day || !isNum(c.at)) return null;
      const age = now() - c.at;
      if (age < 0 || age >= BOOT_CACHE_MS || !isBootResponse(c.res)) return null;
      booted = { res: c.res, at: c.at, day };
      return c.res;
    } catch {
      return null;
    }
  }

  const isLite = (): boolean => bootLite || liteSticky;
  const isSoft = (): boolean => bootSoft || softSticky;

  function adoptBoot(res: BootResponse): void {
    bootedOk = true;
    bootLite = res.lite;
    readOnly = res.readOnly === true;
    bootSoft = res.soft === true;
  }

  function boot(dayIndex: number): Promise<BootResponse | null> {
    if (!allowed) return Promise.resolve(null);
    lastDay = dayIndex;
    if (failures === 0) {
      if (booted && booted.day === dayIndex && now() - booted.at < BOOT_CACHE_MS) {
        adoptBoot(booted.res);
        return Promise.resolve(booted.res);
      }
      const cached = readBootCache(dayIndex);
      if (cached) {
        adoptBoot(cached);
        return Promise.resolve(cached);
      }
    } else if (!retryDue()) {
      return Promise.resolve(null);
    }
    if (bootInFlight) return bootInFlight;
    const p = request(`/api/boot?day=${encodeURIComponent(String(dayIndex))}`, { method: 'GET' }, bootTimeout).then((o) => {
      bootInFlight = null;
      if (o.kind === 'ok' && isBootResponse(o.json)) {
        const res = o.json;
        const at = now();
        booted = { res, at, day: dayIndex };
        sessionSet(BOOT_CACHE_KEY, JSON.stringify({ at, day: dayIndex, res }));
        succeed();
        adoptBoot(res);
        return res;
      }
      fail();
      return null;
    });
    bootInFlight = p;
    return p;
  }

  /** Resolves true when a request may be made now (booting lazily when needed and allowed). */
  function ready(allowBoot: boolean): Promise<boolean> | boolean {
    if (!allowed || !retryDue()) return false;
    if (bootedOk) return true;
    if (!allowBoot) return false;
    const d = store.data();
    return boot(lastDay ?? Math.max(0, d.daily.dayIndex)).then((r) => r !== null);
  }

  // ---- enqueue (§7.9 filters) ----

  function bootBoardFor(r: PendingRun): BootBoard | null {
    const b = booted?.res.boards[r.level];
    return b && b.key === r.board ? b : null;
  }

  /** The class of a level run against the current boot; undefined (unknown) before boot, offline, or for another key. */
  function classNow(r: PendingRun, d: SaveV1): LevelClass | undefined {
    const b = online() ? bootBoardFor(r) : null;
    return b ? levelClass(r, d, b) : undefined;
  }

  /** Lazy only for level runs queued in this session: an older queued run rides the first flush (§7.9). */
  const isLazyRun = (r: PendingRun): boolean =>
    !isDailyBoard(r.board) && r.queuedAt >= sessionStart && classNow(r, store.data()) === 'lazy';
  const isRankInRun = (r: PendingRun): boolean => !isDailyBoard(r.board) && classNow(r, store.data()) === 'rankIn';

  function enqueue(given: PendingRun): void {
    if (!allowed) return;                     // this origin never sends (single HTML, file:)
    const r = dailyFallback(given);           // a daily best over 44.5 s still counts the player
    if (!isSendable(r)) return;
    store.update((d) => {
      const run: PendingRun = { ...r };
      if (isDailyBoard(run.board)) {
        if ((run.tries ?? 0) < 1) return;
        if (boardDay(run.board) === d.daily.dayIndex) {
          if (!dailyStillDue(d, run)) return;
          const prev = dailyPrev(d.daily);
          if (prev === undefined) delete run.prev;
          else run.prev = prev;
        }
      } else if (classNow(run, d) === null) {
        return;                               // the server would write nothing (an unknown class is queued)
      }
      d.outbox = enqueueRun(d.outbox, run);
    });
  }

  // ---- flush ----

  /**
   * §7.9 for a run of today's daily: after a partial send only an improvement, and after the final one
   * only a strict improvement of the record. The 'final' branch is a safety net: a run that is already
   * queued when something marks the day final early (an optimistic pagehide commit of a worse run) would
   * otherwise be dropped unsent. In normal play the final send carries the rack's best, so nothing beats it.
   */
  function dailyStillDue(d: SaveV1, run: PendingRun): boolean {
    const s = d.daily.submitted;
    if (s === 'none') return true;
    return isBetter(run.t120, d.daily.lastSentT120);
  }

  /**
   * The outbox as it should be sent now: daily runs the server would refuse (older than yesterday), today's runs
   * that are no longer due and level runs of class null (§7.9; not while lite or soft) are dropped, and `prev` of
   * today's is refreshed.
   * Returns null when nothing changes, so a flush without news does not rewrite the save.
   */
  function normalizedOutbox(d: SaveV1): PendingRun[] | null {
    const refDay = Math.max(d.daily.dayIndex, booted?.res.day ?? -1);
    let changed = false;
    const out: PendingRun[] = [];
    const dropLevels = !isLite() && !isSoft();
    for (const r of d.outbox) {
      const day = boardDay(r.board);
      if (day !== null && day < refDay - 1) {
        changed = true;
        continue;
      }
      // A level run the server would take without writing anything (e.g. my counted time moved since it was queued).
      if (dropLevels && !isDailyBoard(r.board) && !inFlight.has(r.board) && classNow(r, d) === null) {
        changed = true;
        continue;
      }
      if (day === null || day !== d.daily.dayIndex || inFlight.has(r.board)) {
        out.push(r);
        continue;
      }
      if (!dailyStillDue(d, r)) {
        changed = true;
        continue;
      }
      const prev = dailyPrev(d.daily);
      if (prev === r.prev && (prev !== undefined || !('prev' in r))) {
        out.push(r);
        continue;
      }
      const copy: PendingRun = { ...r };
      if (prev === undefined) delete copy.prev;
      else copy.prev = prev;
      out.push(copy);
      changed = true;
    }
    return changed ? out : null;
  }

  const sameRun = (a: PendingRun, b: PendingRun): boolean =>
    a.replay === b.replay && a.t120 === b.t120 && a.tries === b.tries && a.balls === b.balls;

  function removeIfUnchanged(d: SaveV1, sent: PendingRun): void {
    const i = d.outbox.findIndex((p) => p.board === sent.board);
    if (i >= 0 && sameRun(d.outbox[i]!, sent)) d.outbox.splice(i, 1);
  }

  /** Records an accepted / notBetter daily send in SaveV1.daily (only for the day it belongs to). */
  function commitDaily(d: SaveV1, run: PendingRun, accepted: boolean): void {
    if (boardDay(run.board) !== d.daily.dayIndex) return;
    const wasNone = d.daily.submitted === 'none';
    if (accepted && (wasNone || isBetter(run.t120, d.daily.lastSentT120))) d.daily.lastSentT120 = run.t120;
    if ((run.tries ?? 0) >= 5) d.daily.submitted = 'final';
    else if (wasNone) d.daily.submitted = 'partial';
  }

  /**
   * pagehide: the answer of a request will most likely never be read, so today's daily sends in `f` are
   * committed up front (otherwise the next session would report the day again without `prev` and be
   * counted twice). Idempotent; undone by rollback() when the page survives and the send does not go through.
   */
  function commitOptimistic(d: SaveV1, f: Flight): void {
    for (const run of f.sent) {
      if (!isDailyBoard(run.board) || boardDay(run.board) !== d.daily.dayIndex) continue;
      if (f.optimistic.some((o) => o.board === run.board)) continue;
      f.optimistic.push({ board: run.board, run, submitted: d.daily.submitted, lastSentT120: d.daily.lastSentT120, dayIndex: d.daily.dayIndex });
      commitDaily(d, run, true);
      removeIfUnchanged(d, run);
    }
  }

  /** Undoes an optimistic pagehide commit (the page survived and the send did not go through). */
  function rollback(d: SaveV1, o: Optimistic): void {
    if (d.daily.dayIndex === o.dayIndex) {
      d.daily.submitted = o.submitted;
      d.daily.lastSentT120 = o.lastSentT120;
    }
    d.outbox = enqueueRun(d.outbox, o.run);
  }

  /**
   * The boot board of an answered level run follows the answer (in memory and in the sessionStorage copy): cutoff,
   * n, and my histogram bin (from the counted time `prev` to `c`), so the next results card starts from it.
   */
  function patchBoot(run: PendingRun, r: SubmitResult, prev: number | undefined, c: number | undefined): boolean {
    const b = bootBoardFor(run);
    if (!b) return false;
    let changed = false;
    if ((r.cutoff === null || isNum(r.cutoff)) && b.cutoff !== r.cutoff) {
      b.cutoff = r.cutoff;
      changed = true;
    }
    if (isNum(r.n) && r.n > b.n) {
      b.n = r.n;
      changed = true;
    }
    const h = c !== undefined && c !== prev ? levelHistOf(b) : null;
    if (h && c !== undefined) {
      if (prev !== undefined) {
        const pb = levelBin(prev);
        if (h[pb]! > 0) h[pb]! -= 1;
      }
      h[levelBin(c)]! += 1;
      b.hist = trimHist(h);
      changed = true;
    }
    return changed;
  }

  const countedOf = (x: unknown): number | null | undefined =>
    x === null ? null : typeof x === 'number' && Number.isInteger(x) && x >= 1 && x <= 1e6 ? x : undefined;

  function applyResults(f: Flight, res: SubmitResponse): void {
    const results = res.results;
    if (res.soft === true) softSticky = true;
    const byBoard = new Map(results.map((r) => [r.board, r]));
    let bootChanged = false;
    store.update((d) => {
      for (const run of f.sent) {
        const r = byBoard.get(run.board);
        const opt = f.optimistic.find((o) => o.board === run.board);
        const liteReject = r?.status === 'rejected' && r.reason === 'lite';
        if (liteReject) liteSticky = true;
        // No answer for this run, deferred, or refused only because of lite: keep it for a later send.
        if (!r || r.status === 'deferred' || liteReject) {
          if (opt) rollback(d, opt);
          continue;
        }
        if (!opt) removeIfUnchanged(d, run);
        const counted = r.status === 'accepted' || r.status === 'notBetter' || r.status === 'unranked';
        if (isDailyBoard(run.board)) {
          if (!opt && (r.status === 'accepted' || r.status === 'notBetter')) commitDaily(d, run, r.status === 'accepted');
        } else if (counted && run.t120 !== null) {
          const par = bootBoardFor(run)?.par;
          const lp = d.levels[run.level];
          if (lp && (r.aiBeaten === true || (par !== undefined && run.t120 < par))) lp.aiBeatenSent = true;
          if (lp) lp.playSent = true;
          // counted: a number = my histogram time now, null = not counted, absent (an older server) = unknown.
          const c = countedOf(r.counted);
          const prev = lp?.sentSub;
          if (lp && typeof c === 'number') lp.sentSub = c;
          else if (lp && c === null) delete lp.sentSub;
          if (patchBoot(run, r, prev, lp && typeof c === 'number' ? c : undefined)) bootChanged = true;
          if (r.status === 'accepted') {
            boardCache.delete(run.board);
            noStore.add(run.board);
          }
        }
      }
    });
    if (bootChanged && booted) sessionSet(BOOT_CACHE_KEY, JSON.stringify({ at: booted.at, day: booted.day, res: booted.res }));
    for (const cb of [...listeners]) {
      try {
        cb(f.sent, results);
      } catch {
        // a listener never breaks the api
      }
    }
  }

  function send(reason: FlushReason, exempt: boolean, first?: string): Promise<SubmitResponse | null> {
    if (readOnly) return Promise.resolve(null);
    // Checked again here: a flush that waited for a lazy boot must not follow another send within 120 s.
    if (!exempt && now() - lastSendAt < SEND_MIN_INTERVAL_MS) return Promise.resolve(null);
    const d = store.data();
    const batch = takeBatch(d.outbox, { skipLevels: isLite(), exclude: inFlight, first, lazy: isLazyRun, skipLazy: isSoft() });
    if (batch.length === 0) return Promise.resolve(null);
    const sent = batch.map((s) => ({ ...d.outbox.find((p) => p.board === s.board)! }));
    // menu / select: runs the server can take later wait for a pagehide (or until they fill a request).
    if ((reason === 'menu' || reason === 'select') && batch.length < BATCH_MAX_RUNS && sent.every(isLazyRun)) return Promise.resolve(null);
    const body: SubmitRequest = { v: 1, secret: d.id.secret, nameSeed: d.id.nameSeed, runs: batch };
    const flight: Flight = { sent, optimistic: [], done: null };
    if (reason === 'pagehide') store.update((dd) => commitOptimistic(dd, flight));

    lastSendAt = now();
    for (const r of sent) inFlight.add(r.board);
    flights.add(flight);
    const done = request('/api/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: true,
    }, reqTimeout).then((o) => {
      flights.delete(flight);
      for (const r of sent) inFlight.delete(r.board);
      if (o.kind === 'ok' && isSubmitResponse(o.json)) {
        succeed();
        const res = o.json;
        if (res.lite === true) liteSticky = true;
        applyResults(flight, res);
        return res;
      }
      if (o.kind === 'client') {
        // 400 / 413: the server will never take this batch; drop it rather than retry forever.
        store.update((dd) => {
          for (const run of sent) if (!flight.optimistic.some((x) => x.board === run.board)) removeIfUnchanged(dd, run);
        });
        return null;
      }
      fail();
      if (flight.optimistic.length > 0) store.update((dd) => flight.optimistic.forEach((x) => rollback(dd, x)));
      return null;
    });
    flight.done = done;
    return done;
  }

  /** Sends now when a request may be made (booting lazily when `allowBoot`); null when nothing could go. */
  function sendWhenReady(reason: FlushReason, exempt: boolean, allowBoot: boolean, first?: string): Promise<SubmitResponse | null> {
    const ok = ready(allowBoot);
    return ok === true ? send(reason, exempt, first) : ok === false ? Promise.resolve(null) : ok.then((yes) => (yes ? send(reason, exempt, first) : null));
  }

  // ---- rank-in (§7.9): a top-100 candidate goes out at the success tick, first in its batch ----

  function flightOf(board: string): { run: PendingRun; done: Promise<SubmitResponse | null> } | null {
    for (const f of flights) {
      const run = f.sent.find((r) => r.board === board);
      if (run && f.done) return { run, done: f.done };
    }
    return null;
  }

  /** The rank-in send of `first` now (no interval check). */
  function rankInNow(first: string): Promise<SubmitResponse | null> {
    if (readOnly || isLite()) return Promise.resolve(null);
    const queued = store.data().outbox.find((r) => r.board === first);
    if (!queued) return Promise.resolve(null);
    const flying = flightOf(first);
    if (flying) {
      // The same run is already on its way: its answer is the answer. A faster run queued meanwhile follows it.
      return sameRun(flying.run, queued) ? flying.done : flying.done.then(() => flushRankIn(first));
    }
    lastRankInAt = now();
    return sendWhenReady('rankIn', true, true, first);
  }

  function flushRankIn(first: string | undefined): Promise<SubmitResponse | null> {
    if (first === undefined || readOnly || isLite()) return Promise.resolve(null);
    if (!store.data().outbox.some((r) => r.board === first)) return Promise.resolve(null);
    if (flightOf(first)) return rankInNow(first);
    if (deferredRankIn) {
      deferredRankIn.first = first;             // the newest candidate goes first; the others ride along
      return deferredRankIn.promise;
    }
    if (now() - lastRankInAt >= RANKIN_MIN_INTERVAL_MS) return rankInNow(first);
    let resolve!: DeferredRankIn['resolve'];
    const promise = new Promise<SubmitResponse | null>((r) => { resolve = r; });
    const w: DeferredRankIn = { first, promise, resolve, timer: null };
    w.timer = setTimeout(() => {
      if (deferredRankIn !== w) return;
      deferredRankIn = null;
      w.resolve(rankInNow(w.first));
    }, Math.max(0, lastRankInAt + RANKIN_MIN_INTERVAL_MS - now()));
    deferredRankIn = w;
    return promise;
  }

  function flush(reason: FlushReason, opts: { first?: string } = {}): Promise<SubmitResponse | null> {
    if (!allowed) return Promise.resolve(null);
    if (reason === 'rankIn') return flushRankIn(opts.first);
    const norm = normalizedOutbox(store.data());
    if (norm) store.update((d) => { d.outbox = norm; });
    const d = store.data();
    const waiting = (r: PendingRun): boolean => !inFlight.has(r.board);
    const dailyWaiting = d.outbox.some((r) => isDailyBoard(r.board) && waiting(r));
    // pagehide: a top-100 run must not be stranded behind the 120 s rule (a deferred rank-in, a failed one).
    const rankInWaiting = reason === 'pagehide' && !isLite() && d.outbox.some((r) => waiting(r) && isRankInRun(r));
    const exempt = reason === 'dailyDone' || (reason === 'pagehide' && (dailyWaiting || rankInWaiting));
    // A pagehide takes over a deferred rank-in: its send carries the run (first), its answer is the answer.
    const deferred = reason === 'pagehide' ? deferredRankIn : null;
    if (deferred) {
      deferredRankIn = null;
      if (deferred.timer !== null) clearTimeout(deferred.timer);
    }
    const first = opts.first ?? deferred?.first;
    let result: Promise<SubmitResponse | null>;
    if (!exempt && now() - lastSendAt < SEND_MIN_INTERVAL_MS) {
      result = Promise.resolve(null);
    } else {
      result = sendWhenReady(reason, exempt, reason !== 'pagehide', first);
    }
    deferred?.resolve(result);
    if (reason === 'pagehide') {
      // A daily send still waiting for its answer (e.g. 'dailyDone' a moment before the tab closed) is
      // committed now too, then the queue is persisted: the page may be gone after this handler, also
      // when nothing could be sent (e.g. the daily run the caller enqueued just before this call).
      if (flights.size > 0) store.update((dd) => flights.forEach((f) => commitOptimistic(dd, f)));
      store.flush();
    }
    return result;
  }

  // ---- reads ----

  function ghost(key: string, rank: number, opts: GhostOpts = {}): Promise<GhostResponse | null> {
    if (!allowed || isLite() || !KEY_RE.test(key) || !Number.isInteger(rank) || rank < 1 || rank > 100) return Promise.resolve(null);
    const ck = `${key}/${rank}`;
    const hit = ghostCache.get(ck);
    // A cached answer is for the row the caller saw, unless the board moved since (another player or time at this rank).
    if (hit && (opts.pidh === undefined || hit.pidh === opts.pidh) && (opts.t120 === undefined || hit.t120 === opts.t120)) return Promise.resolve(hit);
    if (ghostCount >= GHOST_MAX_PER_SESSION) return Promise.resolve(null);
    const go = (): Promise<GhostResponse | null> => {
      if (ghostCount >= GHOST_MAX_PER_SESSION) return Promise.resolve(null);
      ghostCount++;
      sessionSet(GHOST_COUNT_KEY, String(ghostCount));
      return request(`/api/ghost/${key}/${rank}`, { method: 'GET' }, reqTimeout).then((o) => {
        if (o.kind === 'ok' && isGhostResponse(o.json)) {
          succeed();
          cacheGhost(ck, o.json);
          return o.json;
        }
        if (o.kind !== 'client') fail();
        return null;
      });
    };
    const ok = ready(true);
    if (ok === true) return go();
    if (ok === false) return Promise.resolve(null);
    return ok.then((yes) => (yes ? go() : null));
  }

  function board(key: string): Promise<BoardResponse | null> {
    if (!allowed || isLite() || !KEY_RE.test(key)) return Promise.resolve(null);
    // After an accepted run of mine the board changed: skip this cache and the HTTP cache (max-age 60) once.
    const fresh = noStore.has(key);
    const hit = fresh ? undefined : boardCache.get(key);
    if (hit && now() - hit.at < BOARD_CACHE_MS) return Promise.resolve(hit.res);
    const go = (): Promise<BoardResponse | null> =>
      request(`/api/board/${key}`, { method: 'GET', cache: fresh ? 'no-store' : 'default' }, reqTimeout).then((o) => {
        if (o.kind === 'ok' && isBoardResponse(o.json)) {
          succeed();
          if (fresh) noStore.delete(key);
          boardCache.set(key, { at: now(), res: o.json });
          return o.json;
        }
        if (o.kind !== 'client') fail();
        return null;
      });
    const ok = ready(true);
    if (ok === true) return go();
    if (ok === false) return Promise.resolve(null);
    return ok.then((yes) => (yes ? go() : null));
  }

  return {
    get enabled() {
      return online();
    },
    get lite() {
      return isLite();
    },
    get readOnly() {
      return readOnly;
    },
    get booting() {
      return allowed && !bootedOk && failures === 0 && bootInFlight !== null;
    },
    get soft() {
      return isSoft();
    },
    onResults(cb: ResultsListener) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    lastBoot: () => (bootedOk ? booted?.res ?? null : null),
    ghostsLeft: () => (allowed ? Math.max(0, GHOST_MAX_PER_SESSION - ghostCount) : 0),
    boot,
    flush,
    enqueue,
    ghost,
    board,
  };
}
