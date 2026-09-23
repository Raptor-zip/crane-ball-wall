// Medals, crowns, titles, unlock rules, hint timing, attempt / fail accounting (GAME_DESIGN.md §7.2, §7.4, §5.1). Owner: O3.
// Pure functions over plain data (no DOM, no store); app.ts applies them inside store.update().
import type { BadgeId, Medal } from './bus';
import type { LevelDef } from '../sim/level';
import type { LevelProgress } from '../store/save';
import { SIM_VERSION } from '../sim/constants';
import { ja } from '../ui/i18n/ja';
import { en } from '../ui/i18n/en';

type Lang = 'ja' | 'en';

export interface MedalResult { medal: Medal; crown: boolean; nextMedalSub: number | null }
export interface MedalThresholds { bronze: number; silver: number; gold: number; crown: number /* best score that still earns the crown: P - 1 */ }

/** floor(2.0P), floor(1.5P), floor(1.2P) in exact integer arithmetic (no 1.2 * P rounding surprises). */
export function medalThresholds(parSub: number): MedalThresholds {
  const P = Math.max(1, Math.round(parSub));
  return { bronze: 2 * P, silver: Math.floor((3 * P) / 2), gold: Math.floor((6 * P) / 5), crown: P - 1 };
}

/** Bronze <= floor(2.0P), silver <= floor(1.5P), gold <= floor(1.2P), crown < P. nextMedalSub = best score needed for the next step. */
export function medalFor(score: number, parSub: number): MedalResult {
  const t = medalThresholds(parSub);
  const medal: Medal = score <= t.gold ? 3 : score <= t.silver ? 2 : score <= t.bronze ? 1 : 0;
  const crown = score <= t.crown;
  const nextMedalSub = crown ? null : medal === 3 ? t.crown : medal === 2 ? t.gold : medal === 1 ? t.silver : t.bronze;
  return { medal, crown, nextMedalSub };
}

/** Hints open after 3 / 6 / 10 failures (§5.3, §7.4). */
export const HINT_FAILS = [3, 6, 10] as const;
export function hintsOpen(fails: number): number {
  let n = 0;
  for (const f of HINT_FAILS) if (fails >= f) n++;
  return n;
}

/**
 * Titles by crown count: 見習い(0) 玉掛け(3) 熟練オペレーター(8) 最適制御ハンター(13) 人類代表(18).
 * The words live in ONE place, the UI's i18n tables (`select.rank.<i>`, O7): TITLES and titleName() read them.
 */
export const TITLE_CROWNS = [0, 3, 8, 13, 18] as const;
const TITLE_KEYS = ['select.rank.0', 'select.rank.1', 'select.rank.2', 'select.rank.3', 'select.rank.4'] as const;
export const TITLES: Readonly<Record<Lang, readonly string[]>> = {
  ja: TITLE_KEYS.map((k) => ja[k]),
  en: TITLE_KEYS.map((k) => en[k]),
};
/** Title word of a titleIndex() in a language. */
export function titleName(index: number, lang: Lang): string {
  const i = Math.max(0, Math.min(TITLE_KEYS.length - 1, Math.floor(index)));
  return TITLES[lang][i] ?? TITLES.ja[i]!;
}
export function titleIndex(crowns: number): number {
  let i = 0;
  for (let k = 0; k < TITLE_CROWNS.length; k++) if (crowns >= TITLE_CROWNS[k]!) i = k;
  return i;
}

/** Retries before this many ticks after tick 0 are "false starts": not an attempt, not a failure (§7.4). */
export const FALSE_START_TICKS = 60;
/** Skip button after this many attempts (§2.1, §7.4). */
export const SKIP_ATTEMPTS = 10;
/** Auto demo after this many consecutive crashes on an uncleared campaign level (§7.4). */
export const DEMO_CRASHES = 3;

export function emptyProgress(hash: string): LevelProgress {
  return {
    hash, cleared: false, skipped: false, attempts: 0, fails: 0, consecutiveCrashes: 0, bestSub: null, bestReplay: null,
    medal: 0, crown: false, badges: [], hintsSeen: 0, briefed: false, demoShown: false, aiBeatenSent: false,
  };
}

/** Gets (creating when missing) the progress record of a level. Mutates `levels`. */
export function ensureProgress(levels: Record<string, LevelProgress>, id: string, hash: string): LevelProgress {
  let p = levels[id];
  if (!p) {
    p = emptyProgress(hash);
    levels[id] = p;
  }
  return p;
}

/**
 * The version a PB is valid for (LevelProgress.hash): the level's physics hash, plus the simulation version once it is
 * past 1 (`<levelHash>:s<sim>`). A SIM_VERSION bump then retires every stored PB like a physics change (its replay
 * would re-simulate to another result, and its time would hold back the runs sent to the new `:s<sim>` boards), while
 * the saves written under sim 1 (bare hashes) stay valid as they are.
 */
export function progressHash(levelHash: string, sim: number = SIM_VERSION): string {
  return sim === 1 ? levelHash : `${levelHash}:s${sim}`;
}

/**
 * Physics changed (levelHash differs): drop the PB (time and replay) but keep medals (§7.4).
 * `hash` is the progressHash() of the level. Returns true when something changed.
 */
export function reconcileHash(p: LevelProgress, hash: string): boolean {
  if (p.hash === hash) return false;
  p.hash = hash;
  p.bestSub = null;
  p.bestReplay = null;
  delete p.sentSub;   // the histogram position belongs to the old board
  return true;
}

export type RunOutcomeKind = 'success' | 'crash' | 'timeout' | 'retry';

export interface OutcomeEffects {
  counted: boolean;        // counted as an attempt
  failed: boolean;         // counted as a failure
  hintOpened: number;      // 0, or the 1-based hint level that just opened
  demoDue: boolean;        // auto demo should play now (caller sets demoShown when it does)
}

/**
 * Attempt / fail / crash-streak accounting for one finished run (§7.4):
 *  - every run that reached tick 0 is an attempt, except a retry (or leaving) before FALSE_START_TICKS;
 *  - failures are crashes, time-ups and counted mid-run retries;
 *  - the crash streak grows on a crash, resets on success and time-up, and is untouched by retries.
 * `campaign` = a campaign level played in campaign mode (auto demo only there, and only while uncleared).
 */
export function applyOutcome(p: LevelProgress, kind: RunOutcomeKind, ticks: number, campaign: boolean): OutcomeEffects {
  const fx: OutcomeEffects = { counted: false, failed: false, hintOpened: 0, demoDue: false };
  if (kind === 'retry' && ticks < FALSE_START_TICKS) return fx;
  fx.counted = true;
  p.attempts++;
  const before = hintsOpen(p.fails);
  if (kind !== 'success') {
    fx.failed = true;
    p.fails++;
  }
  if (kind === 'crash') p.consecutiveCrashes++;
  else if (kind !== 'retry') p.consecutiveCrashes = 0;
  const after = hintsOpen(p.fails);
  if (after > before) fx.hintOpened = after;
  fx.demoDue = campaign && kind === 'crash' && !p.cleared && !p.demoShown && p.consecutiveCrashes >= DEMO_CRASHES;
  return fx;
}

export interface SuccessRecord { pb: boolean; firstClear: boolean; firstCrown: boolean; medalUp: boolean; newBadges: BadgeId[] }

/**
 * Records a successful run. `rankable` = PB-eligible (not practice, not assisted: assisted runs clear with no medal and no PB, §3.6).
 * `replay` may be null (over 6 KB): the time still becomes the PB (§10.4).
 */
export function applySuccess(
  p: LevelProgress, score: number, parSub: number, replay: string | null, badges: readonly BadgeId[], rankable: boolean,
): SuccessRecord {
  const firstClear = !p.cleared;
  p.cleared = true;
  const rec: SuccessRecord = { pb: false, firstClear, firstCrown: false, medalUp: false, newBadges: [] };
  for (const b of badges) {
    if (!p.badges.includes(b)) {
      p.badges.push(b);
      rec.newBadges.push(b);
    }
  }
  if (!rankable) return rec;
  const m = medalFor(score, parSub);
  if (m.medal > p.medal) {
    p.medal = m.medal;
    rec.medalUp = true;
  }
  if (m.crown && !p.crown) {
    p.crown = true;
    rec.firstCrown = true;
  }
  if (p.bestSub === null || score < p.bestSub) {
    rec.pb = p.bestSub !== null; // "自己ベスト!" only when an existing PB improves (the first clear has its own fanfare)
    p.bestSub = score;
    p.bestReplay = replay;
  }
  return rec;
}

// ---------------------------------------------------------------- unlocks (§5.1, §7.4, §7.5)

function doneCount(world: number, levels: readonly LevelDef[], prog: Record<string, LevelProgress>): number {
  let n = 0;
  for (const l of levels) if (l.world === world && (prog[l.id]?.cleared || prog[l.id]?.skipped)) n++;
  return n;
}

/** W1 is open; W(n+1) opens when Wn is open and its clears (skips included) >= |Wn| - 1. */
export function worldUnlocked(world: number, levels: readonly LevelDef[], prog: Record<string, LevelProgress>): boolean {
  if (world <= 1) return true;
  if (!worldUnlocked(world - 1, levels, prog)) return false;
  const size = levels.filter((l) => l.world === world - 1).length;
  return doneCount(world - 1, levels, prog) >= size - 1;
}

/** Levels open in order inside an open world. */
export function levelUnlocked(level: LevelDef, levels: readonly LevelDef[], prog: Record<string, LevelProgress>): boolean {
  if (level.world === 0) return true;
  if (!worldUnlocked(level.world, levels, prog)) return false;
  const prev = levels.find((l) => l.world === level.world && l.order === level.order - 1);
  if (!prev) return true;
  const p = prog[prev.id];
  return !!(p?.cleared || p?.skipped);
}

export function skipAvailable(p: LevelProgress | undefined): boolean {
  return !!p && !p.cleared && !p.skipped && p.attempts >= SKIP_ATTEMPTS;
}

/** 今日の5球 opens once 1-2 is cleared (a skip counts as a clear for unlocking). */
export function dailyUnlocked(prog: Record<string, LevelProgress>): boolean {
  const p = prog['1-2'];
  return !!(p?.cleared || p?.skipped);
}

export function crownCount(levels: readonly LevelDef[], prog: Record<string, LevelProgress>): number {
  let n = 0;
  for (const l of levels) if (l.world !== 0 && prog[l.id]?.crown) n++;
  return n;
}

/** The level after `level` in campaign order (next world's first level after the last one), or null. */
export function nextLevel(level: LevelDef, levels: readonly LevelDef[]): LevelDef | null {
  const campaign = levels.filter((l) => l.world !== 0).slice().sort((a, b) => a.world - b.world || a.order - b.order);
  const i = campaign.findIndex((l) => l.id === level.id);
  return i >= 0 && i + 1 < campaign.length ? campaign[i + 1]! : null;
}
