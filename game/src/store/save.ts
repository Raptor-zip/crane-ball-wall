// localStorage save (GAME_DESIGN.md §7.4, §10.4 "保存"). Owner: O8.
//
// - One JSON document at localStorage['yurapita:v1'] (SaveV1).
// - Every read / write is wrapped in try/catch; the first failure switches the store to memory for the
//   rest of the session (`persistent` becomes false). takeStorageNotice() then answers true exactly once
//   so the UI can say 「この環境では記録が保存されません」 one time (seen.storageNotice is that flag).
// - Parsing is migration-safe: every field is validated on load and replaced by its default when it is
//   missing or malformed, so an old / partial / hand-edited save never crashes the game.
// - update() writes with a 250 ms throttle; flush() writes pending changes now; pagehide and
//   visibilitychange(hidden) flush too. Only changed state is written, and an idle tab adopts what another
//   tab saved (storage event), so a stale second tab never overwrites newer progress when it closes.
// - A level whose physics hash changed loses its PB (bestSub / bestReplay) but keeps medals and crown.
import type { BadgeId, Medal } from '../core/bus';
import { enqueueRun, type PendingRun } from '../net/outbox';
import { isValidSecret, newSecret, pidhFromSecret, randomNameSeed } from '../shared/names';

export const SAVE_KEY = 'yurapita:v1';
/** A save that could not be parsed is copied here once before it is replaced. */
export const CORRUPT_KEY = 'yurapita:v1:corrupt';
export const SAVE_THROTTLE_MS = 250;

export interface LevelProgress {
  hash: string; cleared: boolean; skipped: boolean; attempts: number; fails: number;
  consecutiveCrashes: number; bestSub: number | null; bestReplay: string | null; medal: Medal; crown: boolean; badges: BadgeId[]; hintsSeen: number; briefed: boolean;
  demoShown: boolean; aiBeatenSent: boolean;
  /** A clear of this level reached the server once (§7.9: counts the player in `plays`); absent = not yet. */
  playSent?: boolean;
  /**
   * The time (t120) the server counts this device with in the level histogram of the level's current board
   * (SubmitResult.counted = plays.t120, §7.9). Absent = not counted, or unknown (a save from before this field).
   */
  sentSub?: number;
}
export interface SaveV1 {
  v: 1;
  id: { secret: string; pidh: string; nameSeed: number };
  settings: {
    lang: 'ja' | 'en';
    langPicked: boolean;     // the player chose lang in the settings (else it follows defaultLang: Japanese)
    volume: number;          // 0..100 (the settings slider, §3.5)
    muted: boolean; haptics: boolean; motion: 'auto' | 'on' | 'off';
    keyboard: 'speed' | 'force'; ghostSet: 0 | 1 | 2 | 3 | 4;
    steady: boolean;         // steady assist (§3.7, ranked): on by default
    aiLine: boolean | null;  // null = per-world default (§8.4: shown in W1-W2, hidden from W3)
    textScale: 100 | 125; quality: 'auto' | 'high' | 'low';
  };
  levels: Record<string, LevelProgress>;
  daily: {
    dayIndex: number;        // -1 before the first daily
    /**
     * JST calendar day (shared/daily jstDayNumber) of the rack; -1 or absent: unknown (a save written before this
     * field existed), then it follows from dayIndex. Tells apart the days before DAILY_EPOCH, which all have dayIndex 0.
     */
    jstDay?: number;
    balls: ('ok' | 'gold' | 'crown' | 'fail' | null)[]; bestSub: number | null; bestReplay: string | null;
    submitted: 'none' | 'partial' | 'final'; lastSentT120: number | null; streak: number;
    lastPlayedDay: number;   // -1 before the first daily
    /** JST calendar day of the last official ball (-1 or absent: unknown, then it follows from lastPlayedDay). */
    lastPlayedJst?: number;
  };
  outbox: PendingRun[];
  seen: { onboarding: boolean; notes: number[]; aiLostCard: boolean; storageNotice: boolean; tricks: string[] };
}
/** update() saves with a 250 ms throttle; flush() writes pending changes immediately. */
export interface Store { readonly persistent: boolean; data(): SaveV1; update(fn: (d: SaveV1) => void): void; flush(): void }

/** The concrete store: the contract plus a few helpers for the wiring code (core/main). */
export interface LocalStore extends Store {
  /** True exactly once after the store fell back to memory (then seen.storageNotice is set). */
  takeStorageNotice(): boolean;
  /** Applies the current physics hashes (levelId -> levelHash): wipes stale PBs, keeps medals. */
  applyLevelHashes(hashes: Readonly<Record<string, string>>): void;
  /** Removes the page listeners and cancels a pending write (tests, hot reload). */
  dispose(): void;
}

/** The subset of the Web Storage API the store uses. */
export interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void }

export interface StoreOptions {
  /** Defaults to window.localStorage (guarded: accessing it can throw). null = memory only. */
  storage?: StorageLike | null;
  /** levelId -> levelHash of the bundled levels; stale PBs are wiped at load. */
  levelHashes?: Readonly<Record<string, string>>;
  /** Language of a new save; defaults to navigator.language (ja* -> 'ja', else 'en'). */
  lang?: 'ja' | 'en';
  /** Install pagehide / visibilitychange / storage (other tabs) listeners (default true). */
  listen?: boolean;
}

// ---------------------------------------------------------------------------------------------
// Defaults

export const BADGE_IDS: readonly BadgeId[] = ['kamihitoe', 'ippatsu', 'hashidon', 'pashi', 'buranko', 'yasashisa'];

/** First-run language: always Japanese (the playtest asked for it); English only by choice in the settings. */
export function defaultLang(): 'ja' | 'en' {
  return 'ja';
}

export function defaultLevelProgress(hash = ''): LevelProgress {
  return {
    hash, cleared: false, skipped: false, attempts: 0, fails: 0, consecutiveCrashes: 0,
    bestSub: null, bestReplay: null, medal: 0, crown: false, badges: [], hintsSeen: 0, briefed: false,
    demoShown: false, aiBeatenSent: false,
  };
}

export function defaultDaily(): SaveV1['daily'] {
  return {
    dayIndex: -1, jstDay: -1, balls: [null, null, null, null, null], bestSub: null, bestReplay: null,
    submitted: 'none', lastSentT120: null, streak: 0, lastPlayedDay: -1, lastPlayedJst: -1,
  };
}

export function newIdentity(): SaveV1['id'] {
  const secret = newSecret();
  return { secret, pidh: pidhFromSecret(secret)!, nameSeed: randomNameSeed() };
}

export function defaultSave(lang: 'ja' | 'en' = defaultLang()): SaveV1 {
  return {
    v: 1,
    id: newIdentity(),
    settings: {
      lang, langPicked: false, volume: 80, muted: false, haptics: true, motion: 'auto', keyboard: 'speed', ghostSet: 0,
      steady: true, aiLine: null, textScale: 100, quality: 'auto',
    },
    levels: {},
    daily: defaultDaily(),
    outbox: [],
    seen: { onboarding: false, notes: [], aiLostCard: false, storageNotice: false, tricks: [] },
  };
}

/** The progress entry of a level, created (with `hash`) when missing. Call inside update(). */
export function ensureLevel(d: SaveV1, id: string, hash: string): LevelProgress {
  let p = d.levels[id];
  if (!p) {
    p = defaultLevelProgress(hash);
    d.levels[id] = p;
  }
  return p;
}

// ---------------------------------------------------------------------------------------------
// Migration-safe parsing

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);
const bool = (x: unknown, dflt: boolean): boolean => (typeof x === 'boolean' ? x : dflt);
const oneOf = <T>(x: unknown, allowed: readonly T[], dflt: T): T => (allowed.includes(x as T) ? (x as T) : dflt);
const int = (x: unknown, min: number, max: number, dflt: number): number =>
  typeof x === 'number' && Number.isInteger(x) && x >= min && x <= max ? x : dflt;
const intOrNull = (x: unknown, min: number, max: number): number | null =>
  typeof x === 'number' && Number.isInteger(x) && x >= min && x <= max ? x : null;
const strOrNull = (x: unknown): string | null => (typeof x === 'string' && x.length > 0 ? x : null);
const BIG = 2 ** 31 - 1;
const BALLS = ['ok', 'gold', 'crown', 'fail'] as const;

function parseLevel(x: unknown): LevelProgress | null {
  if (!isObj(x)) return null;
  const p = defaultLevelProgress(typeof x.hash === 'string' ? x.hash : '');
  p.cleared = bool(x.cleared, false);
  p.skipped = bool(x.skipped, false);
  p.attempts = int(x.attempts, 0, BIG, 0);
  p.fails = int(x.fails, 0, BIG, 0);
  p.consecutiveCrashes = int(x.consecutiveCrashes, 0, BIG, 0);
  p.bestSub = intOrNull(x.bestSub, 1, BIG);
  p.bestReplay = p.bestSub === null ? null : strOrNull(x.bestReplay);
  p.medal = int(x.medal, 0, 3, 0) as Medal;
  p.crown = bool(x.crown, false);
  p.badges = Array.isArray(x.badges)
    ? BADGE_IDS.filter((b) => (x.badges as unknown[]).includes(b))
    : [];
  p.hintsSeen = int(x.hintsSeen, 0, 3, 0);
  p.briefed = bool(x.briefed, false);
  p.demoShown = bool(x.demoShown, false);
  p.aiBeatenSent = bool(x.aiBeatenSent, false);
  if (x.playSent === true) p.playSent = true;
  const ss = intOrNull(x.sentSub, 1, BIG);
  if (ss !== null) p.sentSub = ss;
  return p;
}

function parseDaily(x: unknown): SaveV1['daily'] {
  const d = defaultDaily();
  if (!isObj(x)) return d;
  d.dayIndex = int(x.dayIndex, -1, BIG, -1);
  d.jstDay = d.dayIndex < 0 ? -1 : int(x.jstDay, -1, BIG, -1);
  if (Array.isArray(x.balls)) {
    for (let i = 0; i < 5; i++) d.balls[i] = oneOf(x.balls[i], BALLS, null);
  }
  d.bestSub = intOrNull(x.bestSub, 1, BIG);
  d.bestReplay = d.bestSub === null ? null : strOrNull(x.bestReplay);
  d.submitted = oneOf(x.submitted, ['none', 'partial', 'final'] as const, 'none');
  d.lastSentT120 = d.submitted === 'none' ? null : intOrNull(x.lastSentT120, 1, BIG);
  d.streak = int(x.streak, 0, BIG, 0);
  d.lastPlayedDay = int(x.lastPlayedDay, -1, BIG, -1);
  d.lastPlayedJst = d.lastPlayedDay < 0 ? -1 : int(x.lastPlayedJst, -1, BIG, -1);
  return d;
}

/** A queued run from the save; enqueueRun() (isSendable) then drops anything the Worker would refuse. */
function parsePending(x: unknown): PendingRun | null {
  if (!isObj(x) || typeof x.board !== 'string' || typeof x.level !== 'string') return null;
  const replay = typeof x.replay === 'string' && x.replay.length > 0 ? x.replay : null;
  const t120 = intOrNull(x.t120, 1, BIG);
  if ((replay === null) !== (t120 === null)) return null;
  const r: PendingRun = {
    board: x.board, level: x.level, replay, t120,
    device: int(x.device, 0, 5, 0) as PendingRun['device'],
    nTicks: int(x.nTicks, 0, BIG, 0),
    queuedAt: typeof x.queuedAt === 'number' && Number.isFinite(x.queuedAt) ? x.queuedAt : 0,
  };
  if (x.tries !== undefined) r.tries = int(x.tries, 0, 5, 0);
  if (typeof x.balls === 'string' && /^[XOGC-]{5}$/.test(x.balls)) r.balls = x.balls;
  if (x.prev === null) r.prev = null;
  else if (x.prev !== undefined && intOrNull(x.prev, 0, 1e6) !== null) r.prev = x.prev as number;
  return r;
}

/** Level ids are short plain keys ("2-2"); anything else (e.g. "__proto__") is not a level. */
const LEVEL_KEY_RE = /^[0-9A-Za-z:._-]{1,32}$/;

/**
 * Turns anything (a parsed JSON value, possibly from an older or damaged save) into a valid SaveV1.
 * Valid fields are kept, everything else gets its default. A malformed identity is replaced.
 */
export function parseSave(raw: unknown, lang: 'ja' | 'en' = defaultLang()): SaveV1 {
  const s = defaultSave(lang);
  if (!isObj(raw)) return s;

  if (isObj(raw.id) && isValidSecret(raw.id.secret)) {
    s.id.secret = raw.id.secret;
    s.id.pidh = pidhFromSecret(raw.id.secret)!;   // always recomputed: never trust a stored pidh
    s.id.nameSeed = int(raw.id.nameSeed, 0, 65535, s.id.nameSeed);
  }

  if (isObj(raw.settings)) {
    const x = raw.settings, t = s.settings;
    t.langPicked = bool(x.langPicked, false);
    // A language the player did not pick (the old navigator.language default) goes back to the default: Japanese.
    if (t.langPicked) t.lang = oneOf(x.lang, ['ja', 'en'] as const, t.lang);
    t.volume = typeof x.volume === 'number' && Number.isFinite(x.volume) ? Math.min(100, Math.max(0, Math.round(x.volume))) : t.volume;
    t.muted = bool(x.muted, t.muted);
    t.haptics = bool(x.haptics, t.haptics);
    t.motion = oneOf(x.motion, ['auto', 'on', 'off'] as const, t.motion);
    t.keyboard = oneOf(x.keyboard, ['speed', 'force'] as const, t.keyboard);
    t.ghostSet = oneOf(x.ghostSet, [0, 1, 2, 3, 4] as const, t.ghostSet);
    t.steady = bool(x.steady, t.steady);
    t.aiLine = x.aiLine === null || typeof x.aiLine === 'boolean' ? x.aiLine : t.aiLine;
    t.textScale = oneOf(x.textScale, [100, 125] as const, t.textScale);
    t.quality = oneOf(x.quality, ['auto', 'high', 'low'] as const, t.quality);
  }

  if (isObj(raw.levels)) {
    for (const [id, v] of Object.entries(raw.levels)) {
      if (!LEVEL_KEY_RE.test(id) || id === '__proto__') continue;
      const p = parseLevel(v);
      if (p) s.levels[id] = p;
    }
  }

  s.daily = parseDaily(raw.daily);

  if (Array.isArray(raw.outbox)) {
    let out: PendingRun[] = [];
    for (const v of raw.outbox) {
      const r = parsePending(v);
      if (r) out = enqueueRun(out, r);
    }
    s.outbox = out;
  }

  if (isObj(raw.seen)) {
    const x = raw.seen;
    s.seen.onboarding = bool(x.onboarding, false);
    s.seen.notes = Array.isArray(x.notes)
      ? [...new Set(x.notes.filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < 100))]
      : [];
    s.seen.aiLostCard = bool(x.aiLostCard, false);
    // storageNotice is per session: it says whether THIS session already told the player (see takeStorageNotice).
    s.seen.storageNotice = false;
    s.seen.tricks = Array.isArray(x.tricks) ? [...new Set(x.tricks.filter((t): t is string => typeof t === 'string'))] : [];
  }
  return s;
}

/**
 * §7.4: when a level's physics hash changed, its PB is wiped (medal, crown, cleared and badges stay).
 * The level's ranking changes with the hash, so the "AI beaten" report is due again and queued runs
 * for the old ranking are dropped. Levels without a hash yet just adopt it. Returns true when changed.
 */
export function reconcileLevelHashes(d: SaveV1, hashes: Readonly<Record<string, string>>): boolean {
  let changed = false;
  for (const [id, p] of Object.entries(d.levels)) {
    const h = hashes[id];
    if (h === undefined || p.hash === h) continue;
    if (p.hash !== '') {
      p.bestSub = null;
      p.bestReplay = null;
      p.aiBeatenSent = false;
    }
    delete p.playSent;   // a new board key: the player is counted again there
    delete p.sentSub;
    p.hash = h;
    changed = true;
  }
  const kept = d.outbox.filter((r) => {
    const m = /^L:([^:]+):([0-9a-f]{8}):/.exec(r.board);
    return !m || hashes[m[1]!] === undefined || hashes[m[1]!] === m[2];
  });
  if (kept.length !== d.outbox.length) {
    d.outbox = kept;
    changed = true;
  }
  return changed;
}

// ---------------------------------------------------------------------------------------------
// The store

function defaultStorage(): StorageLike | null {
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    return ls ?? null;
  } catch {
    return null;   // SecurityError: storage disabled, sandboxed iframe, some file:// contexts
  }
}

export function createStore(opts: StoreOptions = {}): LocalStore {
  const storage = opts.storage === undefined ? defaultStorage() : opts.storage;
  const lang = opts.lang ?? defaultLang();
  let failed = storage === null;
  let noticeTaken = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  let raw: string | null = null;
  if (!failed) {
    try {
      raw = storage!.getItem(SAVE_KEY);
    } catch {
      failed = true;
    }
  }
  let parsed: unknown = null;
  if (raw !== null) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      try {
        storage!.setItem(CORRUPT_KEY, raw);
      } catch {
        // best effort only
      }
    }
  }
  const data = parseSave(parsed, lang);
  if (opts.levelHashes) reconcileLevelHashes(data, opts.levelHashes);
  /** There are changes in memory that are not in storage yet. */
  let dirty = false;

  function write(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (failed) return;
    try {
      storage!.setItem(SAVE_KEY, JSON.stringify(data));
      dirty = false;
    } catch {
      failed = true;   // quota exceeded, storage revoked ... stay in memory from now on
    }
  }
  /**
   * Later writes happen only when something changed: an idle second tab that is hidden or closed must not
   * put its stale copy over the progress the other tab saved (last writer wins in localStorage).
   */
  const writeIfDirty = (): void => {
    if (dirty) write();
  };
  const schedule = (): void => {
    dirty = true;
    if (timer === null) timer = setTimeout(write, SAVE_THROTTLE_MS);
  };

  // Persist the (possibly new or migrated) save right away: keeps the identity stable across reloads
  // and probes that writing works, so a failure is noticed at startup rather than after the first run.
  // (Rewriting an unchanged save stores the same text, which other tabs do not even see as a change.)
  write();

  const onPageHide = (): void => writeIfDirty();
  const onVisibility = (): void => {
    try {
      if (document.visibilityState === 'hidden') writeIfDirty();
    } catch {
      // no document
    }
  };
  /** Another tab saved: adopt its save when this tab has nothing unsaved (the root object stays the same). */
  const onStorage = (e: StorageEvent): void => {
    try {
      if (e.key !== SAVE_KEY || e.newValue === null || dirty || failed) return;
      if (e.storageArea && e.storageArea !== (storage as unknown)) return;
      const raw2 = JSON.parse(e.newValue) as unknown;
      if (!isObj(raw2) || !isObj(raw2.id) || !isValidSecret(raw2.id.secret)) return;   // not a save we wrote
      const next = parseSave(raw2, data.settings.lang);
      if (opts.levelHashes) reconcileLevelHashes(next, opts.levelHashes);
      next.seen.storageNotice = data.seen.storageNotice;
      Object.assign(data, next);
    } catch {
      // a broken write from elsewhere: keep ours
    }
  };
  const listen = opts.listen ?? true;
  if (listen) {
    try {
      globalThis.addEventListener?.('pagehide', onPageHide);
      globalThis.addEventListener?.('storage', onStorage);
      globalThis.document?.addEventListener('visibilitychange', onVisibility);
    } catch {
      // not a browser
    }
  }

  return {
    get persistent() {
      return !failed;
    },
    data: () => data,
    update(fn) {
      try {
        fn(data);
      } finally {
        schedule();
      }
    },
    flush: writeIfDirty,
    takeStorageNotice() {
      if (!failed || noticeTaken || data.seen.storageNotice) return false;
      noticeTaken = true;
      data.seen.storageNotice = true;
      return true;
    },
    applyLevelHashes(hashes) {
      if (reconcileLevelHashes(data, hashes)) schedule();
    },
    dispose() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (listen) {
        try {
          globalThis.removeEventListener?.('pagehide', onPageHide);
          globalThis.removeEventListener?.('storage', onStorage);
          globalThis.document?.removeEventListener('visibilitychange', onVisibility);
        } catch {
          // not a browser
        }
      }
    },
  };
}
