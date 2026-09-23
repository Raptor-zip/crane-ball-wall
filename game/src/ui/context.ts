// What the UI may read from the rest of the game (all optional), and the environment handed to each screen. Owner: O7.
//
// The §10.4 UI contract is unchanged: createUI() works with no argument (bundled levels / summary, default settings,
// everything online hidden). core (O3) passes a UiContext to createUI(ctx) so that the menus show real progress,
// rankings, the daily and the graphs. Every member is optional and read lazily (never cached across screens).
import type { LevelDef } from '../sim/level';
import type { SaveV1, Store } from '../store/save';
import type { BoardResponse, BootResponse } from '../shared/api';
import type { DailyView, GhostSummary, ResultsData, Screen, UiAction } from './ui';

/** One entry of ghosts_summary.json "levels" (§8.2). Values can change when the ghost pipeline reruns. */
export interface SummaryEntry {
  hash?: string; parSub: number; tMin?: number; planT?: number; calmT?: number; peakF: number;
  minGapMm: number | null; pumps: number; headroom?: string | null; aiMarginMm?: number; aiTensionMinN?: number;
}

/** Flags for the pause menu and the READY chips (§3.3 key-less equivalents, §3.5, §3.6, §7.4). */
export interface PauseInfo {
  practiceAvailable: boolean;   // after the first crash on this level
  practice: boolean;            // practice mode is on
  skipAvailable: boolean;       // 10 attempts, or the 30 s tutorial from a shared link
  assistOffered: boolean;       // the one-time anti-sway offer is open (or accepted)
  assist: boolean;              // assist is on
  reverseHint: boolean;         // 2-3 "reverse" ghost is available
  ghostSet: 0 | 1 | 2 | 3 | 4;
  aiLine: boolean;
  muted: boolean;
}

/** 60 Hz channels for the results comparison graphs (§8.4 item 9). */
export interface Channels { x: Float32Array; th: Float32Array; f: Float32Array }
export interface CompareTracks { hz: number; me: Channels | null; ai: Channels | null }

/** Data for the AI demo overlay (§7.5 item 5, §8.4 item 6). Force samples at `hz`. */
export interface DemoInfo { hz: number; aiF: Float32Array; meF: Float32Array | null; aiGapMm: number | null; aiPeakF: number; Fmax: number }

export interface UiContext {
  /** Save data: settings, per-level progress, seen flags, generated name. The UI writes only `settings` and `seen.{notes,aiLostCard}`. */
  store?: Store | null;
  /** Campaign levels (default: bundled src/data/levels.json). */
  levels?: readonly LevelDef[];
  /** ghosts_summary.json "levels" (default: the bundled file). */
  summary?: Readonly<Record<string, SummaryEntry>>;
  /** Latest boot response (null while offline or not booted). */
  boot?: () => BootResponse | null;
  /** GET /api/board/:key (null when offline). */
  fetchBoard?: (key: string) => Promise<BoardResponse | null>;
  /** Today's daily (select-screen card and daily hub refresh). */
  daily?: () => DailyView | null;
  /** Unlock rule (§5.1). Default: the same rule computed from the store. */
  unlocked?: (levelId: string) => boolean;
  /** Strategy card data for the READY ⓘ button (null hides the button). */
  briefing?: (level: LevelDef) => GhostSummary | null;
  /** AI demo overlay graph. */
  demo?: (level: LevelDef) => DemoInfo | null;
  /** Results comparison graphs. */
  compare?: (data: ResultsData) => CompareTracks | null;
  /** AI ball path (bx,by pairs at 60 Hz) for the share card. */
  aiPath?: (levelId: string) => Float32Array | null;
  /** Pause-menu flags. Missing fields are derived from the store and the events the UI saw. */
  pause?: () => Partial<PauseInfo>;
  /** Share origin override (default: VITE_PUBLIC_ORIGIN, else location.origin on http(s), else none). */
  origin?: string | null;
}

/** Handed to every screen renderer by ui.ts. */
export interface ScreenEnv {
  ctx: UiContext;
  emit(a: UiAction, payload?: unknown): void;
  /** Opens a UI-managed sub-screen (settings, about, notes, board) on top of the current one. */
  open(s: Screen): void;
  /** Closes the current sub-screen and returns to what was under it. */
  back(): void;
  /** True when a sub-screen was opened from another screen (the back button shows). */
  canGoBack(): boolean;
  save(): SaveV1 | null;
  levels(): readonly LevelDef[];
  summary(id: string): SummaryEntry | null;
  settings(): SaveV1['settings'];
  /** Applies new settings immediately (language, text size, motion), stores them and emits 'settingsChanged'. */
  applySettings(next: SaveV1['settings']): void;
  reducedMotion(): boolean;
  /**
   * Live pause-menu flags (ctx.pause merged over the store-derived defaults). Screens re-read it after emitting a
   * toggle (core applies it synchronously and may skip unavailable ghost sets) and on HUD frames (G / H / M keys).
   */
  pauseInfo(): PauseInfo;
  /** How the run shown on the results card was played (practice / assist runs record no PB or medal). */
  lastRun(): { practice: boolean; assist: boolean; pb: boolean | null; firstCrown: boolean };
  layoutKind(): 'wide' | 'tall';
  toast(text: string, kind?: 'info' | 'badge' | 'warn'): void;
  /** Re-renders the current screen (e.g. after a language change). */
  refresh(): void;
}
