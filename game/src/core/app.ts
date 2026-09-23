// Application state machine and wiring (GAME_DESIGN.md §9.4, §2, §4.7-§4.8, §7). Owner: O3.
//
//   BOOT -> (#d / #c= / #l=) [1-1 uncleared: TUTORIAL(1-1)] -> target | TITLE (attract)
//   TITLE -(any input)-> READY(1-1) while 1-1 is uncleared, else LEVEL_SELECT
//   LEVEL_SELECT -> [W2+ first time] BRIEFING -> READY
//   READY -(q != 0)-> RUNNING -> CRASH_BEAT (0.7 s, skippable) -> READY | SUCCESS_BEAT (0.75 s) -> RESULTS
//                               | Timeout -> RESULTS (failed) | retry -> READY
//   READY / RUNNING -(Esc, pause, hidden tab)-> PAUSED
//   3 crashes in a row (uncleared campaign level, once) -> DEMO (auto, skippable) -> READY
//   RESULTS (+ ranking) -(1位のリプレイ / a row's ▶)-> DEMO (the ranked replay, ×0.5, holds on its last frame)
//     -(戻る / any input / Esc)-> RESULTS + ranking (at the row watched) | -(このゴーストと勝負)-> READY (that ghost races)
//
// Every other module is reached only through its §10.4 interface. Dependencies can be injected (tests);
// by default the real modules are created, and audio / haptics / net degrade to no-ops if they fail.
// Retry never rebuilds the scene: the session resets in place (< 100 ms, §1.3).
import type { DailyDef, LevelDef } from '../sim/level';
import { HOLD_SUB, RAIL_Y, SIM_VERSION } from '../sim/constants';
import { Mode, Status, type PoseSnap, type SimState } from '../sim/run';
import { decodeReplay, rankedScore, ReplayFlag, simulateReplay, type ReplayResult } from '../sim/replay';
import { RANKED_MAX_TICKS } from '../sim/constants';
import { ballClearanceM } from '../sim/display';
import { b64urlDecode } from '../sim/b64';
import type { Command, InputFrame, InputManager } from '../input/types';
import { servoQ, steadyGoal } from '../input/servo';
import type { GhostKind, GhostPose, Layout, RenderFrame, Renderer, RendererExtras } from '../render/renderer';
import type { AudioEngine } from '../audio/engine';
import type { Haptics } from '../audio/haptics';
import type { DailyView, GhostSummary, HudAnchors, HudState, ResultsData, Screen, UI, UiAction } from '../ui/ui';
import type { Channels, CompareTracks, DemoInfo, PauseInfo, ReplayAvail, ReplayLoad, ReplayReq, ReplayView, UiContext } from '../ui/context';
import { failReasonText, getLang, levelHint, levelName, setLang, t as uiText } from '../ui/i18n/format';
import { dailyShareText as uiDailyShareText } from '../ui/share';
import type { LevelProgress, SaveV1, Store } from '../store/save';
import type { Api, ResultsListener } from '../net/api';
import { OUTBOX_MAX, dailySendDue, isDailyBoard, type PendingRun } from '../net/outbox';
import type { BoardRow, BootResponse, SubmitResult } from '../shared/api';
import { BOARD_TOP_N, dailyBoardKey, levelBoardKey, parseBoardKey } from '../shared/api';
import { levelBin, levelPct, localRank, stampKind, type BoardSnapshot, type Standing, type StandingPhase } from '../shared/rank';
import { DAILY_BALLS, dailyDayOpen, dayIndexAt, jstDayNumber, jstDayStartMs, pickDaily } from '../shared/daily';
import { displayName, randomNameSeed } from '../shared/names';
import { Bus, type BadgeId, type GameEvent } from './bus';
import { createLoop, createTimeFx, type Loop, type LoopEnv } from './loop';
import { createSession, enableRewind, type RunResult, type Session } from './session';
import {
  ballPath, forceAt, newGhostPose, poseAt, reversed, strobe as strobeOf, trackAndHashFromReplay, trackDuration, trackFromReplay, type GhostTrack,
} from './ghosts';
import { comparisonGhost } from './splits';
import {
  applyOutcome, applySuccess, dailyUnlocked, emptyProgress, hintsOpen, levelUnlocked, medalFor, nextLevel,
  progressHash, reconcileHash, skipAvailable, worldUnlocked, type RunOutcomeKind,
} from './progress';
import {
  ballOutcome, ballsString, ballsUsed, currentStreak, dailyShareText, emptyRack, markPlayed, rackDay, rackFull, rackIsOn,
  recordDailyBest, rolloverDaily, settleBall, topPercent, type DailyBall,
} from './dailyMode';
import { parseHash, resolveLink, shareOrigin, type ResolvedLink } from './links';
import { createGameData, type GameData } from './data';
import { aiLabel, ct, trickName } from './text';
import type { TrickId } from './badges';
import { createUI } from '../ui/ui';
import { createRenderer } from '../render/renderer';
import { createInputManager } from '../input/manager';
import { createAudioEngine } from '../audio/engine';
import { createHaptics } from '../audio/haptics';
import { createStore } from '../store/save';
import { createApi, levelHistOf } from '../net/api';
import { noteBestStreak } from '../store/cosmetic';
import { createSkinState, skinsSheetLayout } from './skinState';

export type AppState =
  | 'BOOT' | 'TUTORIAL' | 'TITLE' | 'LEVEL_SELECT' | 'BRIEFING' | 'READY' | 'RUNNING'
  | 'CRASH_BEAT' | 'SUCCESS_BEAT' | 'RESULTS' | 'PAUSED' | 'DEMO' | 'DAILY_HUB'
  | 'LEADERBOARD' | 'SHARE' | 'SETTINGS' | 'ABOUT' | 'NOTES';

/** JSON-friendly snapshot for window.__YP_TEST__.state() (§10.7). */
export interface AppDebugState {
  state: AppState;
  level: string | null;
  mode: HudState['mode'] | null;
  tutorial: boolean;
  status: number | null;
  ticks: number;
  substep: number;
  timeScale: number;
  paused: boolean;
  ghosts: GhostKind[];
  ghostSet: number;
  hint: string | null;
  offline: boolean;
  dailyBalls: DailyBall[] | null;
  last: { ok: boolean; status: number; score: number | null; medal: number; crown: boolean; pb: boolean; badges: BadgeId[]; gapMm: number | null } | null;
  bestSub: number | null;
  events: number;
  /** stateHash of the challenge link's replay (simulateReplay) when its ghost was built; null otherwise. */
  challengeHash: number | null;
  /** Sim pose of the current run (E2E drivers steer with it): trolley x / v, string angle th [rad], ball centre. */
  pose: { x: number; v: number; th: number; bx: number; by: number } | null;
  /**
   * The ranked replay in the viewer (§7.5 item 6): its row, and what the client's re-simulation (the Worker's
   * simulateReplay) gave: score (= t120, the acceptance rule) and stateHash. t: the viewer's sim time [s]. Null otherwise.
   */
  replay: { key: string; rank: number; pidh: string; t120: number; score: number | null; stateHash: number; source: 'boot' | 'local' | 'net'; kind: 'wr' | 'rival'; t: number } | null;
  /** The ghost picked with 「このゴーストと勝負」 (it races on this level until another level opens). */
  picked: { pidh: string; kind: GhostKind } | null;
}

export interface PlayReplayResult { status: number; score: number | null; ticks: number; state: AppState }

export interface App {
  state(): AppState;
  dispose(): void;
  readonly bus: Bus;
  /** window.__YP_TEST__ hooks (§10.7). */
  debugState(): AppDebugState;
  command(c: string, payload?: unknown): void;
  playReplay(levelId: string, b64: string): Promise<PlayReplayResult>;
  /** Runs one frame of dtReal seconds by hand (tests). */
  advance(dtReal: number): void;
  /** Screen position (CSS px) of the world point (x, y) through the unshaken camera (E2E drivers). */
  toScreen(x: number, y: number): { x: number; y: number } | null;
}

type HapticsLike = Haptics & { fx?(e: GameEvent): void };
type StoreLike = Store & { takeStorageNotice?(): boolean };
/**
 * NetApi extras (O8, duck-typed). booting: the session's first boot is still on its way (no 「オフライン」 chip meanwhile).
 * soft / readOnly: the valves of §7.8 (no reconcile, no rank-in). onResults: submit answers (the rank row, §7.9).
 */
type ApiLike = Api & {
  lastBoot?(): BootResponse | null; readonly booting?: boolean; readonly soft?: boolean; readonly readOnly?: boolean;
  onResults?(cb: ResultsListener): () => void;
  /** /api/ghost requests left this session (shared by the rival and the replay viewer). */
  ghostsLeft?(): number;
};
/**
 * Optional UI hooks (O7, duck-typed). back: runs the UI's own Escape / back behaviour for the screen it shows (pops a
 * settings / about / board / notes sub-screen, closes the briefing ...); returns true when the UI handled it.
 * attachContext: an injected UI (tests, another host) gets the UiContext the default UI reads through its forwarding
 * context.
 */
type UiLike = UI & { back?(): boolean; attachContext?(ctx: UiContext): void };

export interface AppDeps {
  ui: UI;
  renderer: Renderer;
  input: InputManager;
  audio: AudioEngine | null;
  haptics: HapticsLike | null;
  store: StoreLike;
  api: ApiLike | null;
  data: GameData;
  now: () => number;                        // wall clock ms (daily day index)
  loopEnv?: LoopEnv;
  autoStart?: boolean;                      // start the rAF loop (default true)
  location?: { hash: string; protocol: string; origin: string } | null;
  prefersReducedMotion?: () => boolean;
  publicOrigin?: string;
}

// ----------------------------------------------------------------------------------------------- timings

export const CRASH_BEAT_S = 0.7;
export const SUCCESS_BEAT_S = 0.75;          // 0.15 s still + 0.6 s stamp
export const CRASH_FX: readonly (readonly [number, number])[] = [[0, 0.08], [0.35, 0.25]];
export const SUCCESS_FX: readonly (readonly [number, number])[] = [[0, 0.15]];   // the ring completes, 0.15 s still
export const SLOWMO: readonly [number, number] = [0.35, 0.25];
export const DEMO_SPEED = 0.5;
export const PRACTICE_SPEED = 0.5;
export const DEMO_TAIL_S = 0.4;          // demo time (0.5x) after the AI's 0.5 s hold completes
export const TITLE_TAIL_S = 1.0;         // attract loop: rest after the AI's hold completes
/** Key / tap presses in the first moments of a demo do not skip it: the press that ended the crash beat
 *  (R, Space: a command followed by 'any') or key mashing would otherwise skip the auto demo at once. */
export const DEMO_SKIP_GUARD_S = 0.35;
export const TITLE_LEVEL = '2-2';
export const CONTEXT_HINT_TICKS = 90;        // 1-1: ball over the pad, swinging above A_rest for 1.5 s (§2.2 0:10)
export const ASSIST_OFFER_FAILS = 5;         // §3.6
export const RIVAL_MIN_ATTEMPTS = 3;         // §7.6
/** Verified replays of ranking rows kept for the session (the viewer, 「このゴーストと勝負」). */
export const REPLAY_CACHE_MAX = 12;

/** Menu states: Esc / P / gamepad Start mean "back" there. */
const MENU_STATES: ReadonlySet<AppState> = new Set<AppState>(['LEVEL_SELECT', 'DAILY_HUB', 'BRIEFING', 'SETTINGS', 'ABOUT', 'LEADERBOARD', 'NOTES']);
/** States the UI can put a sub-screen (settings / about / board / notes) on top of. */
const SUBSCREEN_HOSTS: ReadonlySet<AppState> = new Set<AppState>([...MENU_STATES, 'TITLE', 'RESULTS', 'PAUSED']);
/** The UI's sub-screen ids (data-screen of its root, ui.ts SUB_SCREENS). */
const UI_SUB_SCREENS: ReadonlySet<string> = new Set(['settings', 'about', 'board', 'notes', 'skins']);

type PlayOrigin = 'campaign' | 'daily' | 'challenge';

interface Play {
  level: LevelDef;
  origin: PlayOrigin;
  dailyOfficial: boolean;       // runs consume today's balls
  dailyBall: number;            // slot consumed by the current run (-1: none)
  tutorialNext: ResolvedLink | null;
  practice: boolean;
  assist: boolean;
  assistOffered: boolean;
  holdResetFails: number;       // §3.6 counter
  contextHintTicks: number;
  results: ResultsData | null;
  lastRun: RunResult | null;
  lastTrack: GhostTrack | null;
  wasHoldReset: boolean;
}

interface Ghosts {
  ai: GhostTrack | null;
  calm: GhostTrack | null;
  research: GhostTrack[];
  pb: GhostTrack | null;
  wr: GhostTrack | null;
  rival: GhostTrack | null;
  challenge: GhostTrack | null;
  reverse: GhostTrack | null;
  /** 「このゴーストと勝負」 (§7.6): a ranked run watched in the replay viewer (kind wr for #1, rival otherwise). */
  picked: GhostTrack | null;
  pickedPidh: string | null;
  showReverse: boolean;
  hideAi: boolean;
  researchSet: boolean;         // the extra "research AIs" set of levels with ai.extras (not persisted)
}

function noGhosts(): Ghosts {
  return {
    ai: null, calm: null, research: [], pb: null, wr: null, rival: null, challenge: null, reverse: null, picked: null, pickedPidh: null,
    showReverse: false, hideAi: false, researchSet: false,
  };
}

/** A ranked replay re-simulated and verified for the viewer (§7.5 item 6). id = `${key}|${pidh}|${t120}`. */
interface PreparedReplay {
  id: string; key: string; level: LevelDef; rank: number; pidh: string; nameSeed: number; t120: number;
  kind: 'wr' | 'rival'; track: GhostTrack; stateHash: number; res: ReplayResult; phases: { index: number; t: number }[];
  source: 'boot' | 'local' | 'net';
}

/** The replay viewer on screen (state DEMO with a ranked replay instead of the AI demo). */
interface Viewer {
  p: PreparedReplay;
  back: AppState;
  name: string;
  /** The AI par ghost racing alongside (null with the なし ghost set). */
  ai: GhostTrack | null;
  /** Show time [s] the viewer holds at: the hold completes (t120 + 0.5 s), the Success frame. */
  end: number;
  /** Phase events already given to the renderer (5-4). */
  phase: number;
  /** A rank-in stamp for the card under the viewer arrived while it was up (nobody has seen it yet). */
  stampUnseen: boolean;
}

/** 3 ticks at |F| = Fmax: the trolley's red lamp (session SATURATE_TICKS, |q| = 127), read from a track's force. */
function trackSaturated(tr: GhostTrack, tSec: number, Fmax: number): boolean {
  const k = Math.min(tr.n - 1, Math.floor(Math.max(0, tSec) * tr.hz));
  if (k < 2) return false;
  for (let i = k - 2; i <= k; i++) if (Math.abs(tr.f[i]!) < Fmax * 0.999) return false;
  return true;
}

// ----------------------------------------------------------------------------------------------- helpers

function th60(t: GhostTrack): Float32Array {
  const out = new Float32Array(t.n);
  for (let k = 0; k < t.n; k++) out[k] = Math.atan2(t.bx[k]! - t.x[k]!, RAIL_Y - t.by[k]!);
  return out;
}

function channels(t: GhostTrack | null): Channels | null {
  return t ? { x: t.x, th: th60(t), f: t.f } : null;
}

function poseSnapFrom(p: GhostPose, F: number, out: PoseSnap): PoseSnap {
  out.x = p.x;
  out.bx = p.bx;
  out.by = p.by;
  out.mode = p.slack ? Mode.Slack : Mode.Taut;
  out.T = 0;
  out.F = F;
  return out;
}

/**
 * An AI show (the demo, the title attract) seen as a run at show time t (s): Running until the AI's final hold
 * completes (finishSub + the 0.5 s hold), Success afterwards; tracks without a finish run to their end.
 */
export function showStatus(tr: GhostTrack, t: number): Status {
  const end = tr.finishSub !== null && Number.isFinite(tr.finishSub) ? (tr.finishSub + HOLD_SUB) / 120 : trackDuration(tr);
  return t >= end ? Status.Success : Status.Running;
}

/** 0..1 fill of the AI's final hold at show time t (the goal curtain / hold ring during a show). */
export function showHoldFrac(tr: GhostTrack, t: number): number {
  if (tr.finishSub === null || !Number.isFinite(tr.finishSub)) return 0;
  const f = (t * 120 - tr.finishSub) / HOLD_SUB;
  return f <= 0 ? 0 : f >= 1 ? 1 : f;
}

/** Default AI wall margin (§8.4-4, D8). */
export const AI_MARGIN_MM = 20;

/** D8: the AI's wall margin of a level: ghosts_summary aiMarginMm, else LevelDef.ai.marginMm, else 20 mm. */
export function aiMarginMmOf(level: LevelDef, data: Pick<GameData, 'summaryOf'>): number {
  const sum = data.summaryOf(level)?.aiMarginMm;
  if (typeof sum === 'number' && Number.isFinite(sum) && sum > 0) return sum;
  const own = (level.ai as { marginMm?: unknown } | undefined)?.marginMm;
  return typeof own === 'number' && Number.isFinite(own) && own > 0 ? own : AI_MARGIN_MM;
}

function mediaReducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

// ----------------------------------------------------------------------------------------------- createApp

export function createApp(root: HTMLElement, injected?: Partial<AppDeps>): App {
  const bus = new Bus();
  const given: Partial<AppDeps> = {};
  for (const [k, v] of Object.entries(injected ?? {})) if (v !== undefined) (given as Record<string, unknown>)[k] = v;
  // The UI is created before the context functions below exist: it gets a forwarding context filled at the end.
  const sink: { current: UiContext | null } = { current: null };
  const d: AppDeps = { ...defaultDeps(given, sink), ...given } as AppDeps;
  const { ui, renderer, input, store, data } = d;
  const audio = d.audio;
  const haptics = d.haptics;
  const api = d.api;
  const now = d.now;
  const prefersReduced = d.prefersReducedMotion ?? mediaReducedMotion;

  // ---- state ----
  let state: AppState = 'BOOT';
  let play: Play | null = null;
  let session: Session | null = null;
  let ghosts: Ghosts = noGhosts();
  let underState: AppState | null = null;       // for PAUSED / NOTES / LEADERBOARD
  let beatLeft = 0;
  let freshFx = false;      // a beat / time effect started during this frame's ticks: it ages from the next frame
  let afterCrash: 'ready' | 'demo' | 'daily' = 'ready';
  let demoTrack: GhostTrack | null = null;
  let demoTime = 0;
  let demoWall = 0;         // wall-clock seconds since the demo started (skip guard)
  let titleTime = 0;
  let layout: Layout | null = null;
  let replayDriver: { qs: Int8Array; i: number } | null = null;
  let eventCount = 0;
  let lastFrame: InputFrame | null = null;
  /** The steady assist's goal on the last input tick (null: it did not act). */
  let steadyX: number | null = null;
  let hintLine: string | null = null;
  let contextHintShown = false;
  let lastDebug: AppDebugState['last'] = null;
  let disposed = false;
  let pairedAny = false;    // drop the 'any' of the key press whose command just changed the state
  let challengeHash: number | null = null;   // debugState().challengeHash (tests)
  let uiBackBusy = false;   // a synthetic Escape is being delivered to the UI layer
  let inputPractice: boolean | null = null;   // last input.setPractice() value
  const rivalFetched = new Set<string>();
  /** Verified ranking replays (id -> replay), least recently used first; a boot / local source that failed is not tried again. */
  const replays = new Map<string, PreparedReplay>();
  const replayTried = new Set<string>();
  /** Rows the server answered with another run (the table was older than the board): row -> the answer's pidh / t120. */
  const replayMoved = new Map<string, { pidh: string; t120: number }>();
  let viewer: Viewer | null = null;
  let dailyGapCache: { replay: string; gapMm: number | null } | null = null;
  let pendingPb: GhostTrack | null = null;
  let dailyNet: { board: string; rank: number | null; pct: number | null } | null = null;   // from a daily submit answer (its board)
  let dailyBootAsked: string | null = null;   // daily key a boot was asked for after 00:00 JST (once per key)
  /** Confirmed stamps nobody saw on a results card, per board: toasted on the next select / results / daily screen. */
  const rankNews = new Map<string, { levelId: string; rank: number; kind: 'in' | 'up' | 'wr' }>();
  let levelSendsReconciled = false;          // reconcileLevelSends ran (once per session)
  const errorsLogged = new Set<string>();
  const timeFx = createTimeFx();      // sim time: near-miss slow-mo
  const renderFx = createTimeFx();    // render-only: crash hit-stop / debris slow-down
  const poses: GhostPose[] = [newGhostPose(), newGhostPose(), newGhostPose(), newGhostPose()];
  const shown: { track: GhostTrack; pose: GhostPose }[] = [];
  const shownPoses: GhostPose[] = [];
  const demoPose = newGhostPose('calm');
  const demoCur: PoseSnap = { x: 0, bx: 0, by: 0, mode: Mode.Taut, T: 0, F: 0 };

  const safe = <T>(site: string, fn: () => T, fallback?: T): T | undefined => {
    try {
      return fn();
    } catch (e) {
      if (!errorsLogged.has(site)) {
        errorsLogged.add(site);
        console.error(`[yurapita] ${site}:`, e);
      }
      return fallback;
    }
  };

  const save = (): SaveV1 => store.data();
  const settings = (): SaveV1['settings'] => save().settings;
  const reducedMotion = (): boolean => {
    const m = settings().motion;
    return m === 'off' ? true : m === 'on' ? false : prefersReduced();
  };
  const lang = (): 'ja' | 'en' => (settings().lang === 'en' ? 'en' : 'ja');

  // ---- skins (GAME_DESIGN.md §7.14, cosmetic only): look, unlocks and toasts live in skinState.ts ----
  const skins = createSkinState({
    store, levels: data.levels, renderer, toast: (text, kind) => ui.toast(text, kind), now: () => now(),
    canApply: () => state !== 'RUNNING' && state !== 'CRASH_BEAT' && state !== 'SUCCESS_BEAT' && !(state === 'PAUSED' && underState === 'RUNNING'),
  });
  /** The skins sheet opened from a menu page: that page's state while the title attract runs behind the sheet. */
  let skinsHost: AppState | null = null;
  /** The skins sheet is open (the title behind it does not start on confirm / any key or button). */
  let skinsOpen = false;
  /** tall, the skins sheet open: its top edge (root px), above which the renderer frames the attract (skinsSheetLayout). */
  let skinsTop: number | null = null;

  /** LevelProgress.hash of a level: its physics hash and the sim version (progressHash). */
  const pbHash = (level: LevelDef): string => progressHash(data.hash(level));
  const progressOf = (level: LevelDef): LevelProgress => {
    const p = save().levels[level.id];
    return p ?? emptyProgress(pbHash(level));
  };
  const updateProgress = <T>(level: LevelDef, fn: (p: LevelProgress, s: SaveV1) => T): T => {
    let out!: T;
    store.update((s) => {
      let p = s.levels[level.id];
      if (!p) {
        p = emptyProgress(pbHash(level));
        s.levels[level.id] = p;
      }
      reconcileHash(p, pbHash(level));
      out = fn(p, s);
    });
    return out;
  };

  // ---- events ----
  bus.on((e) => {
    eventCount++;
    if (e.t === 'holdReset' && play) play.wasHoldReset = true;
    safe('renderer.fx', () => renderer.fx(e));
    safe('ui.fx', () => ui.fx(e, screenPosOf(e)));
    if (audio) safe('audio.fx', () => audio.fx(e));
    if (haptics?.fx && haptics.enabled) safe('haptics.fx', () => haptics.fx!(e));
  });

  function screenPosOf(e: GameEvent): { x: number; y: number } | undefined {
    let x: number | undefined;
    let y: number | undefined;
    switch (e.t) {
      case 'apex': case 'slack': case 'snap': case 'crash':
        x = e.x; y = e.y; break;
      case 'cross':
        x = e.px; y = e.py; break;
      default:
        return undefined;
    }
    return safe('worldToScreen', () => renderer.worldToScreen(x!, y!));
  }

  const emit = (e: GameEvent): void => bus.emit(e);

  // The UI was created with a forwarding context; connect it before mount (function declarations are hoisted).
  const uiContext: UiContext = {
    store,
    levels: data.levels,
    summary: data.summary,
    boot: () => api?.lastBoot?.() ?? null,
    fetchBoard: (key) => (api ? api.board(key) : Promise.resolve(null)),
    daily: () => (state === 'BOOT' ? null : dailyView()),
    unlocked: (id) => {
      const l = data.level(id);
      return l ? isUnlocked(l) : false;
    },
    briefing: (level) => briefingData(level),
    demo: (level) => demoInfo(level),
    compare: (r) => compareTracks(r),
    aiPath: (id) => {
      const l = data.level(id);
      return l ? data.aiPath(l) : null;
    },
    pause: () => pauseInfo(),
    replayAvail: (key, rank, row) => safe('replayAvail', () => replayAvail(key, rank, row), null) ?? null,
    loadReplay: (req) => loadReplay(req),
    skins: () => skins.view(),
    skinPreview: (ids) => skins.preview(ids),
    skinsShown: (open, sheetTop) => skinsAttract(open, sheetTop),
    origin: shareOrigin(d.publicOrigin ?? import.meta.env.VITE_PUBLIC_ORIGIN, d.location === undefined ? safeLocation() : d.location),
  };
  sink.current = uiContext;
  safe('ui.attachContext', () => (ui as UiLike).attachContext?.(uiContext));

  // ---- mount ----
  layout = ui.mount(root);
  const els = ui.elements();
  const renderOpts: { quality: 'auto' | 'high' | 'low'; reducedMotion: boolean } = { quality: settings().quality, reducedMotion: reducedMotion() };
  safe('skins.apply', () => skins.apply());   // before init: the renderer builds (and paints) the equipped look once
  safe('renderer.init', () => renderer.init(els.canvas, { ...renderOpts }));
  safe('renderer.setLayout', () => renderer.setLayout(layout!));
  safe('input.attach', () => input.attach(els.sceneEl, els.deckEl, renderer.mapper, layout!));
  safe('input.setKeyboardMode', () => input.setKeyboardMode(settings().keyboard));
  ui.onLayout((l) => {
    // A rotation keeps the run going: only the layout changes. attach() resets the clutch and keeps the
    // target (§3.3 "目標はそのまま、クラッチはリセット"), so resetForRun must not be called here.
    layout = l;
    safe('renderer.setLayout', () => renderer.setLayout(skinsSheetLayout(l, skinsTop)));
    const e = ui.elements();
    safe('input.attach', () => input.attach(e.sceneEl, e.deckEl, renderer.mapper, l));
  });
  applySettings();

  // ---- loop ----
  const loop: Loop = createLoop({ tick: onTick, frame: onFrame }, d.loopEnv);

  // ---- UI actions / input commands ----
  input.onCommand((c) => handleCommand(c));
  const actions: (UiAction | 'pause' | 'rewind' | 'back')[] = [
    'retry', 'next', 'demo', 'board', 'share', 'resume', 'practice', 'select', 'openLevel', 'openDaily', 'settingsChanged',
    'skip', 'rerollName', 'assistAccept', 'ghostCycle', 'aiLine', 'notes', 'mute', 'reverseHint', 'pause', 'rewind', 'back',
    'replay', 'raceGhost',
  ];
  for (const a of actions) ui.on(a as UiAction, (payload) => handleAction(a, payload));

  // Leaving the page: the daily rack into the outbox (also yesterday's until 02:00 JST), the outbox out (keepalive)
  // and the save to disk.
  // Mobile browsers often kill a swiped-away tab after visibilitychange(hidden) without a pagehide, so both
  // run it; once per hide (nothing can be played while hidden), re-armed when the page is visible again.
  let hideFlushed = false;
  const flushOnHide = (): void => {
    if (hideFlushed || disposed) return;
    hideFlushed = true;
    queueDailySubmit(false);
    if (api) safe('api.flush', () => void api.flush('pagehide'));
    safe('store.flush', () => store.flush());
  };
  const onVisibility = (): void => {
    try {
      if (document.visibilityState === 'hidden') {
        if (state === 'RUNNING') pause();
        flushOnHide();
      } else {
        hideFlushed = false;
      }
    } catch {
      // no document
    }
  };
  const onPageHide = (): void => flushOnHide();
  const onPageShow = (): void => {
    hideFlushed = false;
  };
  // A #c= / #l= / #d link pasted into the address bar of the open game is a same-document navigation: no reload.
  const onHashChange = (): void => {
    if (!disposed) safe('hashchange', () => followLink(false));
  };
  // OS-level reduced motion changes while the setting is 'auto' (§3.5)
  const onMotionPref = (): void => {
    if (!disposed) applySettings();
  };
  let motionQuery: MediaQueryList | null = null;
  try {
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('hashchange', onHashChange);
    if (!d.prefersReducedMotion && typeof matchMedia === 'function') {
      motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
      motionQuery.addEventListener?.('change', onMotionPref);
    }
  } catch {
    // not a browser
  }

  // ---- boot ----
  // Submit answers (every flush) land on the results card's rank row, or become a toast later.
  const stopResults = api?.onResults ? safe('api.onResults', () => api.onResults!(onLevelAnswers), null) ?? null : null;
  if (store.takeStorageNotice?.()) ui.toast(ct('toast.storage'), 'warn');
  const bootDay = dayNow();
  if (api) {
    void api.boot(bootDay.dayIndex).then(() => { if (!disposed) onBootArrived(); }, () => {});
  }
  // After api.boot(): an unsent rack of yesterday goes out first, and that send waits for this boot (not one of its own).
  rollDaily(bootDay);
  followLink(true);
  if (d.autoStart !== false) loop.start();

  // =============================================================================================== boot

  /**
   * Opens the page's deep link (#d, #c=, #l=): at boot, and when the hash changes in the open page (a link pasted
   * into the address bar). Without a link, boot shows the title and a hash change does nothing.
   */
  function followLink(atBoot: boolean): void {
    const loc = d.location === undefined ? safeLocation() : d.location;
    const link = parseHash(loc?.hash ?? '');
    const resolved = resolveLink(link, {
      findLevel: (id) => data.level(id),
      replayLevelHash: (b64) => decodeReplay(b64urlDecode(b64)).h.levelHash,
      replaySim: (b64) => decodeReplay(b64urlDecode(b64)).h.sim,
      levelHash: (phys) => data.hash({ physics: phys } as LevelDef),
    });
    if (resolved.kind === 'none') {
      if (atBoot) goTitle();
      return;
    }
    if (resolved.kind === 'error') {
      ui.toast(ct('toast.challengeBad'), 'warn');
      goSelect();
      return;
    }
    const l11 = data.level('1-1');
    const targetIs11 = (resolved.kind === 'level' || resolved.kind === 'challenge') && resolved.level.id === '1-1';
    if (l11 && !progressOf(l11).cleared && !targetIs11) {
      ui.toast(ct('toast.tutorial'), 'info');
      openLevel(l11, { origin: 'campaign', tutorialNext: resolved, skipBriefing: true });
      return;
    }
    goLink(resolved);
  }

  function goLink(r: ResolvedLink): void {
    switch (r.kind) {
      case 'daily':
        goDaily();
        return;
      case 'level':
        openLevel(r.level, { origin: 'campaign', skipBriefing: false, force: true });
        return;
      case 'challenge': {
        if (r.stale) ui.toast(ct('toast.challengeStale'), 'warn');
        let track: GhostTrack | null = null;
        if (r.replay) {
          const built = safe('challenge ghost', () => trackAndHashFromReplay(r.level, r.replay!, 'challenge', uiText('ghost.challenge', undefined, lang())), null);
          track = built?.track ?? null;
          challengeHash = built ? built.stateHash : null;
          if (!track) {
            ui.toast(ct('toast.challengeBad'), 'warn');
            goSelect();
            return;
          }
        }
        openLevel(r.level, { origin: r.level.world === 0 ? 'daily' : 'challenge', challenge: track, skipBriefing: true, force: true, dailyPractice: r.level.world === 0 });
        return;
      }
      default:
        goSelect();
    }
  }

  function safeLocation(): { hash: string; protocol: string; origin: string } | null {
    try {
      return { hash: location.hash, protocol: location.protocol, origin: location.origin };
    } catch {
      return null;
    }
  }

  function onBootArrived(): void {
    // WR ghosts become available for the current level on the next READY.
    if (play && (state === 'READY' || state === 'RESULTS')) loadNetGhosts(play.level);
    reconcileLevelSends();
  }

  // =============================================================================================== screens

  function show(s: Screen): void {
    // the R long-press 'rewind' exists only while a practice run is on screen (D3); also back on after a
    // notes / board sub-screen when the run resumes
    setInputPractice(!!play?.practice && (s.id === 'hud' || s.id === 'pause'));
    // New skins (§7.14) after progress changed: at boot, after a run, on the menus (before the screen is built, so that
    // the title's NEW dot is there). Never while a run is on or paused (a trick found mid-run shows at the results).
    if (state !== 'RUNNING' && state !== 'PAUSED') safe('skins.check', () => skins.check(s.id === 'results' ? s.data : null));
    safe('ui.show', () => ui.show(s));
  }

  function setInputPractice(on: boolean): void {
    if (inputPractice === on) return;
    inputPractice = on;
    safe('input.setPractice', () => input.setPractice(on));
  }

  function goTitle(): void {
    dropViewer();
    state = 'TITLE';
    play = null;
    const lvl = data.level(TITLE_LEVEL) ?? data.levels[0] ?? null;
    if (lvl) {
      prepareLevel(lvl);
      session?.retry();
      ghosts = noGhosts();
      ghosts.ai = data.track(lvl, 'ai');
      safe('renderer.resetFx', () => renderer.resetFx());
    }
    titleTime = 0;
    show({ id: 'title' });
  }

  /** The select page to open: the last played world, unless it is still locked (a #l= link, a challenge). */
  function currentWorld(): number {
    const prog = save().levels;
    if (play && play.level.world > 0 && worldUnlocked(play.level.world, data.levels, prog)) return play.level.world;
    let w = 1;
    for (let k = 1; k <= 5; k++) if (worldUnlocked(k, data.levels, prog)) w = k;
    return w;
  }

  function goSelect(world?: number): void {
    leaveRun();
    if (!session) {
      const l = data.level(TITLE_LEVEL) ?? data.levels[0];
      if (l) prepareLevel(l);
    }
    state = 'LEVEL_SELECT';
    underState = null;
    show({ id: 'select', world: world ?? currentWorld() });
    flushRankNews();
    if (api) safe('api.flush', () => void api.flush('select'));
  }

  function goDaily(): void {
    leaveRun();
    const view = dailyView();
    if (!view) {
      goSelect();
      return;
    }
    state = 'DAILY_HUB';
    show({ id: 'daily', data: view });
    flushRankNews();
    void data.loadDailyGhosts();
    bootForDay(view);
  }

  /**
   * The session booted on an earlier day (a page left open across 00:00 JST): today's hub has no top 10 / 「上位 n%」
   * until a boot of today arrives. Asked once per daily key; the hub is shown again when it comes.
   */
  function bootForDay(view: DailyView): void {
    const b = api?.lastBoot?.() ?? null;
    if (!api || !b) return;
    const key = dailyBoardKey(view.dayIndex, data.hash(view.level));
    if (b.daily.key === key || dailyBootAsked === key) return;
    dailyBootAsked = key;
    void api.boot(view.dayIndex).then((res) => {
      if (disposed || !res || res.daily.key !== key || state !== 'DAILY_HUB') return;
      const v = dailyView();
      if (v) show({ id: 'daily', data: v });
    }, () => {});
  }

  function isUnlocked(level: LevelDef): boolean {
    if (level.world === 0) return dailyUnlocked(save().levels) || save().daily.lastPlayedDay >= 0;
    const p = save().levels;
    return levelUnlocked(level, data.levels, p) || !!p[level.id]?.cleared || !!p[level.id]?.skipped;
  }

  // =============================================================================================== levels

  /** Loads the level into renderer / input / session when it changed (the only place the scene is rebuilt). */
  function prepareLevel(level: LevelDef): void {
    if (session && session.level === level) return;
    session = createSession(level, {
      emit,
      // §7.6: the first non-AI ghost of the shown set, else the AI (also when the set shows no ghost at all)
      compare: () => comparisonGhost(shownTracks())?.track ?? ghosts.ai,
      onSlowMo: () => {
        if (!reducedMotion()) {
          timeFx.push(SLOWMO[0], SLOWMO[1]);
          freshFx = true;
        }
      },
      onTrick: (tr) => onTrick(tr),
    });
    loadRendererLevel(level);
    safe('input.setLevel', () => input.setLevel(level.physics));
    emit({ t: 'levelLoaded', level, label: levelLabel(level) });
  }

  /** renderer.loadLevel plus the per-level renderer extras (D8: the AI margin of the cyan lines). */
  function loadRendererLevel(level: LevelDef): void {
    safe('renderer.loadLevel', () => renderer.loadLevel(level, data.aiPath(level), level.cargo === 'egg'));
    const mm = aiMarginMmOf(level, data);
    safe('renderer.setAiMarginMm', () => (renderer as Partial<RendererExtras>).setAiMarginMm?.(mm));
  }

  /** On-screen name of a level (GameEvent levelLoaded.label): 「#N」 for today's daily, never the raw id "d:16". */
  function levelLabel(level: LevelDef): string {
    if (level.world !== 0) return level.id;
    const pick = todayPick();
    if (pick && pick.level.id === level.id) return `#${pick.n}`;
    return safe('levelName', () => levelName(level, lang()), '') || uiText('hud.daily', undefined, lang());
  }

  interface OpenOpts {
    origin: PlayOrigin;
    challenge?: GhostTrack | null;
    tutorialNext?: ResolvedLink | null;
    skipBriefing?: boolean;
    force?: boolean;             // open even when locked (links)
    dailyPractice?: boolean;     // a daily level without consuming balls
  }

  function openLevel(level: LevelDef, o: OpenOpts): void {
    if (!o.force && !isUnlocked(level)) {
      ui.toast(ct('toast.locked'), 'info');
      return;
    }
    leaveRun();
    prepareLevel(level);
    pendingPb = null;
    const daily = level.world === 0;
    const today = daily && isToday(level);
    if (today) rollDaily(dayNow());   // the rack in the save may still be an earlier day's
    const officialDaily = today && !o.dailyPractice && !rackFull(save().daily.balls);
    play = {
      level, origin: o.origin, dailyOfficial: officialDaily, dailyBall: -1, tutorialNext: o.tutorialNext ?? null,
      practice: false, assist: false, assistOffered: false, holdResetFails: 0, contextHintTicks: 0,
      results: null, lastRun: null, lastTrack: null, wasHoldReset: false,
    };
    buildGhosts(level, o.challenge ?? null);
    if (daily) {
      void data.loadDailyGhosts().then((ok) => {
        if (ok && play?.level === level && !ghosts.ai) {
          ghosts.ai = data.track(level, 'ai');
          loadRendererLevel(level);
        }
      });
    }
    const p = progressOf(level);
    if (!o.skipBriefing && !daily && level.world >= 2 && !p.briefed) {
      const brief = briefingData(level);
      if (brief) {
        state = 'BRIEFING';
        show({ id: 'briefing', level, ai: brief });
        return;
      }
    }
    enterReady(false);
  }

  function isToday(level: LevelDef): boolean {
    const pool = data.dailyPool;
    if (pool.length === 0) return false;
    try {
      return pickDaily(pool, now()).level.id === level.id;
    } catch {
      return false;
    }
  }

  function buildGhosts(level: LevelDef, challenge: GhostTrack | null): void {
    const g = noGhosts();
    g.ai = data.track(level, 'ai');
    g.calm = data.track(level, 'calm');
    g.research = data.tracks(level).filter((t) => t.kind === 'research_fast' || t.kind === 'research_pump');
    g.challenge = challenge;
    if (level.id === '2-3') {
      const src = data.level('2-2');
      const t = src ? data.track(src, 'ai') : null;
      g.reverse = t ? reversed(t) : null;
    }
    ghosts = g;
    refreshPbGhost(level);
    loadNetGhosts(level);
  }

  function refreshPbGhost(level: LevelDef): void {
    if (level.world === 0) {
      const dd = save().daily;
      const day = dayNow();
      ghosts.pb = dd.bestReplay && isToday(level) && rackIsOn(dd, day.dayIndex, day.jst) && replaySimOk(dd.bestReplay)
        ? safe('daily pb ghost', () => trackFromReplay(level, dd.bestReplay!, 'daily_pb', 'PB'), null) ?? null
        : null;
      return;
    }
    const p = progressOf(level);
    ghosts.pb = p.bestReplay ? safe('pb ghost', () => trackFromReplay(level, p.bestReplay!, 'pb', 'PB'), null) ?? null : null;
  }

  function loadNetGhosts(level: LevelDef): void {
    const boot = api?.lastBoot?.() ?? null;
    if (!boot || level.world === 0) return;
    const b = boot.boards[level.id];
    if (b && b.wr && b.key === levelBoardKey(level.id, data.hash(level))) {
      ghosts.wr = safe('wr ghost', () => trackFromReplay(level, b.wr!, 'wr', 'WR'), null) ?? null;
    }
  }

  // =============================================================================================== ghosts

  function ghostSetIndex(): number {
    return settings().ghostSet ?? 0;
  }

  function setTracks(): GhostTrack[] {
    const out: GhostTrack[] = [];
    const ai = ghosts.hideAi ? null : ghosts.ai;
    if (ghosts.researchSet) {
      if (ai) out.push(ai);
      out.push(...ghosts.research);
    } else {
      switch (ghostSetIndex()) {
        case 0: if (ai) out.push(ai); if (ghosts.pb) out.push(ghosts.pb); break;
        case 1: if (ai) out.push(ai); break;
        case 2: if (ai) out.push(ai); if (ghosts.wr) out.push(ghosts.wr); break;
        case 3: if (ai) out.push(ai); if (ghosts.rival) out.push(ghosts.rival); break;
        default: break;
      }
    }
    if (ghosts.showReverse && ghosts.reverse) out.push(ghosts.reverse);
    // 「このゴーストと勝負」 joins every set like a challenge (§7.6): it takes the place of the set's ghost of its own kind
    // (the boot WR, the fetched rival) and goes right after the AI, so the splits compare with it.
    const pk = ghosts.picked;
    if (pk) {
      const same = out.findIndex((t) => t.kind === pk.kind);
      if (same >= 0) out.splice(same, 1);
      out.splice(ai && out[0] === ai ? 1 : 0, 0, pk);
    }
    // challenge ghost joins every set; at most 3 ghosts at once (§7.6)
    if (ghosts.challenge) {
      if (out.length >= 3) out.length = 2;
      out.push(ghosts.challenge);
    }
    if (out.length > 3) out.length = 3;
    return out;
  }

  function shownTracks(): { track: GhostTrack; kind: GhostKind }[] {
    return setTracks().map((t) => ({ track: t, kind: t.kind }));
  }

  function labelOf(t: GhostTrack): string {
    switch (t.kind) {
      case 'ai': case 'calm': case 'research_fast': case 'research_pump': case 'reverse_hint':
        return aiLabel(t.label, lang());
      case 'challenge':
        return uiText('ghost.challenge', undefined, lang());
      default:
        return t.label;
    }
  }

  /** Available ghost sets (WR / rival sets are skipped until those ghosts are at hand, §7.6). */
  function cycleGhosts(): void {
    const order: (number | 'research')[] = [0, 1, 2, 3];
    if (ghosts.research.length > 0) order.push('research');
    order.push(4);
    const cur: number | 'research' = ghosts.researchSet ? 'research' : ghostSetIndex();
    let i = order.indexOf(cur);
    for (let k = 0; k < order.length; k++) {
      i = (i + 1) % order.length;
      const s = order[i]!;
      if (s === 2 && !ghosts.wr) continue;
      if (s === 3 && !ghosts.rival) continue;
      if (s === 'research') {
        ghosts.researchSet = true;
        ui.toast(ct('toast.ghostSetResearch'), 'info');
        return;
      }
      ghosts.researchSet = false;
      store.update((sv) => { sv.settings.ghostSet = s as 0 | 1 | 2 | 3 | 4; });
      ui.toast(ct(`toast.ghostSet${s}`), 'info');
      return;
    }
  }

  /** A run is on screen and interpolated between ticks (also while paused: the frozen accumulator keeps the pose). */
  function liveRun(): boolean {
    return state === 'RUNNING' || (state === 'PAUSED' && underState === 'RUNNING');
  }

  function ghostTime(alpha: number): number {
    if (!session || !session.started) return 0;
    const st = session.status();
    const k = st === Status.Running && liveRun() ? session.ticks - 1 + alpha : session.ticks;
    return Math.max(0, k) / 60;
  }

  function updateGhostPoses(tSec: number): void {
    shown.length = 0;
    shownPoses.length = 0;
    const tracks = setTracks();
    for (let i = 0; i < tracks.length && i < poses.length; i++) {
      const tr = tracks[i]!;
      const pose = poses[i]!;
      poseAt(tr, tSec, pose);
      pose.label = labelOf(tr);
      shown.push({ track: tr, pose });
      shownPoses.push(pose);
    }
  }

  // =============================================================================================== play states

  function enterReady(isRetry: boolean): void {
    if (!play || !session) return;
    session.retry();
    session.practice = play.practice;
    session.assisted = play.assist;
    if (play.practice) enableRewind(session);
    setInputPractice(play.practice);
    play.dailyBall = -1;
    play.contextHintTicks = 0;
    play.wasHoldReset = false;
    replayDriver = null;
    safe('input.resetForRun', () => input.resetForRun(play!.level.physics.startX));
    safe('renderer.resetFx', () => renderer.resetFx());
    timeFx.clear();
    renderFx.clear();
    loop.resetAccumulator();
    loop.paused = false;
    // daily: after the 5th ball, further runs are practice
    if (play.level.world === 0 && play.dailyOfficial && rackFull(save().daily.balls)) play.dailyOfficial = false;
    if (pendingPb) {
      ghosts.pb = pendingPb;
      pendingPb = null;
    }
    hintLine = computeHint();
    // 1-1: the very first attempt hides the AI ghost (§5.1)
    const prog = progressOf(play.level);
    ghosts.hideAi = play.level.id === '1-1' && prog.attempts === 0 && !prog.cleared;
    state = 'READY';
    if (isRetry) emit({ t: 'retry' });
    emit({ t: 'ready' });
    show({ id: 'hud' });
  }

  function computeHint(): string | null {
    if (!play || !play.level.hints) return null;
    const p = progressOf(play.level);
    const open = hintsOpen(p.fails);
    if (open <= 0) return null;
    const text = safe('levelHint', () => levelHint(play!.level, open - 1, lang()), null) ?? null;
    // hintsSeen = the highest hint (1..3) the player has been shown on this level
    if (text && play.level.world > 0 && p.hintsSeen < open) updateProgress(play.level, (q) => { q.hintsSeen = Math.max(q.hintsSeen, open); });
    return text;
  }

  function onRunStart(): void {
    if (!play) return;
    state = 'RUNNING';
    const level = play.level;
    if (level.id === '1-1' && !save().seen.onboarding) store.update((s) => { s.seen.onboarding = true; });
    // a daily level left open across 00:00 JST is yesterday's: practice, not a ball of the new day
    if (play.dailyOfficial && level.world === 0 && !isToday(level)) play.dailyOfficial = false;
    if (play.dailyOfficial && level.world === 0) {
      const day = dayNow();
      rollDaily(day);
      store.update((s) => {
        const i = s.daily.balls.indexOf(null);
        if (i >= 0) {
          s.daily.balls = settleBall(s.daily.balls, i, 'fail'); // consumed at tick 0, upgraded on success
          play!.dailyBall = i;
          markPlayed(s.daily, day.dayIndex, day.jst);
          noteBestStreak(s);   // the skins' streak rules keep the best streak (§7.14)
        }
      });
    }
  }

  function currentQ(s: SimState): number {
    if (replayDriver) {
      const q = replayDriver.i < replayDriver.qs.length ? replayDriver.qs[replayDriver.i++]! : 0;
      return q;
    }
    const frame = safe('input.sample', () => input.sample(s), null) ?? null;
    lastFrame = frame;
    if (!frame) return 0;
    const assist = !!play?.assist;
    // a run that used the assist at any tick stays assisted (replay flag, no PB) even if it is switched off mid-run
    if (assist && session) session.assisted = true;
    // Steady assist (§3.7, ranked): the target ring shows where it takes the ball (the hold point pulled into the zone).
    const steady = settings().steady;
    steadyX = steady ? safe('steadyGoal', () => steadyGoal(frame, s, play!.level.physics), null) ?? null : null;
    return safe('servoQ', () => servoQ(frame, s, play!.level.physics, assist, steady), 0) ?? 0;
  }

  function onTick(): void {
    if (disposed) return;
    if (state !== 'READY' && state !== 'RUNNING') return; // DEMO / TITLE time advances in onFrame (wall clock)
    try {
      stepPlay();
    } catch (e) {
      // never throw from the frame loop 60 times a second: report once and drop the broken run
      safe('tick', () => { throw e; });
      replayDriver = null;
      safe('recover', () => enterReady(true));
    }
  }

  function stepPlay(): void {
    if (!play || !session) return;
    const s = session.run.s;
    const q = currentQ(s);
    const wasStarted = session.started;
    const st = session.tick(q, replayDriver ? null : lastFrame);
    if (!wasStarted && session.started) onRunStart();
    if (!session.started) return;
    if (st === Status.Running) {
      contextHint();
      return;
    }
    finishRun(st);
  }

  /**
   * 1-1 only (§2.2 0:10, §7.4): over the pad but still swinging above A_rest for 1.5 s -> hint ② as a toast,
   * once ever (recorded as hintsSeen >= 2; it is the text of hint ②).
   */
  function contextHint(): void {
    if (!play || !session || contextHintShown || play.level.id !== '1-1') return;
    if (progressOf(play.level).hintsSeen >= 2) {
      contextHintShown = true;
      return;
    }
    const s = session.run.s;
    const zone = play.level.physics.phases[0]!;
    // "over the pad": the trolley or the ball (a swing wider than the pad carries the ball past its edges)
    const overPad = (s.bx >= zone.xa && s.bx <= zone.xb) || (s.x >= zone.xa && s.x <= zone.xb);
    if (overPad && session.ampDeg() > play.level.physics.restDeg) play.contextHintTicks++;
    else play.contextHintTicks = 0;
    if (play.contextHintTicks >= CONTEXT_HINT_TICKS) {
      contextHintShown = true;
      // With the steady assist the quickest fix is to let go over the pad (it stops the swing); without it, hint ②.
      const h = settings().steady ? ct('toast.steadyHint') : safe('levelHint', () => levelHint(play!.level, 1, lang()), null);
      if (h) {
        ui.toast(h, 'info');
        updateProgress(play.level, (q) => { q.hintsSeen = Math.max(q.hintsSeen, 2); });
      }
    }
  }

  function onTrick(tr: TrickId): void {
    if (save().seen.tricks.includes(tr)) return;
    store.update((s) => { if (!s.seen.tricks.includes(tr)) s.seen.tricks.push(tr); });
    ui.toast(ct('trick.toast', { name: trickName(tr, lang()) }), 'badge');
  }

  function outcomeOf(st: Status): RunOutcomeKind {
    return st === Status.Success ? 'success' : st === Status.Crash ? 'crash' : 'timeout';
  }

  function finishRun(st: Status): void {
    if (!play || !session) return;
    const level = play.level;
    const res = session.result();
    if (!res) return;
    play.lastRun = res;
    play.lastTrack = session.track('PB');
    const campaignMode = play.origin === 'campaign' && level.world > 0 && !play.practice;
    const beforeProgress = progressOf(level);
    // 一発 (§7.3) is about a campaign level's first attempt; daily levels keep no per-level progress
    const firstAttempt = level.world > 0 && beforeProgress.attempts === 0;
    const fx = level.world === 0 ? null : updateProgress(level, (p) => applyOutcome(p, outcomeOf(st), res.ticks, campaignMode));
    if (fx?.hintOpened) ui.toast(ct('toast.hintOpen', { n: fx.hintOpened }), 'info');
    if (fx && skipAvailable(progressOf(level)) && beforeProgress.attempts < 10 && progressOf(level).attempts >= 10) {
      ui.toast(ct('toast.skipAvailable'), 'info');
    }
    // §3.6: five failures that follow a HoldReset -> one-time assist offer
    if (st !== Status.Success && play.wasHoldReset && !play.assistOffered && level.world > 0) {
      play.holdResetFails++;
      if (play.holdResetFails >= ASSIST_OFFER_FAILS) {
        play.assistOffered = true;
        ui.toast(ct('toast.assistOffer'), 'info');
      }
    }

    if (st === Status.Success) onSuccess(res, firstAttempt);
    else if (st === Status.Crash) onCrash(res, fx?.demoDue ?? false);
    else onTimeout(res);
    if (level.world === 0 && play.dailyOfficial && play.dailyBall >= 0) sendClosedRack();
  }

  /** PB / medal / submission eligible (§3.5, §3.6): not practice, and the assist was not used in this run. */
  function rankable(): boolean {
    return !!play && !play.practice && !play.assist && !session?.assisted && !session?.practice;
  }

  function onSuccess(res: RunResult, firstAttempt: boolean): void {
    const pl = play!;
    const level = pl.level;
    const score = res.score!;
    const par = data.parSub(level);
    const replay = rankable() ? session!.replay() : null;
    const badges = session!.badges.badgesOnSuccess(session!.run.s, firstAttempt);
    const prevBest = level.world === 0 ? save().daily.bestSub : progressOf(level).bestSub;
    const isPb = prevBest === null || score < prevBest;
    const unlockedBefore = [2, 3, 4, 5].filter((w) => worldUnlocked(w, data.levels, save().levels));
    const dailyBefore = dailyUnlocked(save().levels);
    let pb = false;
    let firstCrown = false;
    const m = rankable() ? medalFor(score, par) : { medal: 0 as const, crown: false, nextMedalSub: null };

    if (level.world === 0) {
      if (pl.dailyOfficial && pl.dailyBall >= 0 && rankable()) {
        const outcome = ballOutcome(score, par);
        store.update((s) => {
          s.daily.balls = settleBall(s.daily.balls, pl.dailyBall, outcome);
          pb = recordDailyBest(s.daily, score, replay) && prevBest !== null;
        });
        if (replay && isPb) pendingPb = pl.lastTrack ? { ...pl.lastTrack, kind: 'daily_pb' } : null;
      }
    } else {
      const rec = updateProgress(level, (p) => applySuccess(p, score, par, replay, badges, rankable()));
      pb = rec.pb;
      firstCrown = rec.firstCrown;
      // A clear by a player the server does not count yet (sentSub unknown): the stored best goes out, not this
      // slower run (the server keeps the fastest time it knows; §7.9).
      if (rankable() && replay && !isPb && progressOf(level).sentSub === undefined) enqueueStoredBest(level);
      if (rankable() && isPb) {
        if (pl.lastTrack) pendingPb = { ...pl.lastTrack, kind: 'pb', label: 'PB' };
        if (replay) enqueueLevelRun(level, replay, score, res);
      }
      const unlockedAfter = [2, 3, 4, 5].filter((w) => worldUnlocked(w, data.levels, save().levels));
      for (const w of unlockedAfter) if (!unlockedBefore.includes(w)) ui.toast(ct('toast.newWorld', { n: w }), 'info');
      if (!dailyBefore && dailyUnlocked(save().levels)) ui.toast(ct('toast.dailyOpen'), 'info');
    }

    emit({ t: 'success', score, medal: m.medal, crown: m.crown, firstCrown, pb, badges });
    pl.results = resultsData(res, true, m.medal, m.crown, m.nextMedalSub, prevBest, badges, null, replay);
    lastDebug = { ok: true, status: res.status, score, medal: m.medal, crown: m.crown, pb, badges, gapMm: Number.isFinite(res.gapMm) ? res.gapMm : null };
    state = 'SUCCESS_BEAT';
    beatLeft = SUCCESS_BEAT_S;
    renderFx.sequence(SUCCESS_FX);
    freshFx = true;
    // A top-100 candidate goes out now, 0.75 s before the card: its answer can be on the card when it opens.
    if (level.world > 0 && isPb && replay) sendRankIn(level, pl.results);
    maybeFetchRival(level);
    if (level.world === 0 && pl.dailyOfficial && rackFull(save().daily.balls)) queueDailySubmit(true);
  }

  function onCrash(res: RunResult, demoDue: boolean): void {
    const pl = play!;
    lastDebug = { ok: false, status: res.status, score: null, medal: 0, crown: false, pb: false, badges: [], gapMm: Number.isFinite(res.gapMm) ? res.gapMm : null };
    renderFx.sequence(CRASH_FX);
    state = 'CRASH_BEAT';
    beatLeft = CRASH_BEAT_S;
    freshFx = true;
    afterCrash = 'ready';
    if (demoDue && (ghosts.calm || ghosts.ai)) {
      afterCrash = 'demo';
      updateProgress(pl.level, (p) => { p.demoShown = true; });
    }
    if (pl.level.world === 0 && pl.dailyOfficial && rackFull(save().daily.balls)) {
      afterCrash = 'daily';
      queueDailySubmit(true);
    }
  }

  function onTimeout(res: RunResult): void {
    const pl = play!;
    const ti = res.timeout ?? { reason: 'none' as const, value: 0 };
    const reason = safe('failReasonText', () => failReasonText(ti.reason, ti.value, pl.level.physics.restDeg, lang()), null) ?? null;
    pl.results = resultsData(res, false, 0, false, null, progressOf(pl.level).bestSub, [], reason, null);
    lastDebug = { ok: false, status: res.status, score: null, medal: 0, crown: false, pb: false, badges: [], gapMm: Number.isFinite(res.gapMm) ? res.gapMm : null };
    if (pl.level.world === 0 && pl.dailyOfficial && rackFull(save().daily.balls)) queueDailySubmit(true);
    goResults();
  }

  function resultsData(
    res: RunResult, ok: boolean, medal: 0 | 1 | 2 | 3, crown: boolean, nextMedalSub: number | null, pbSub: number | null,
    badges: BadgeId[], failReason: string | null, replay: string | null,
  ): ResultsData {
    const level = play!.level;
    const boot = api?.lastBoot?.() ?? null;
    const b = level.world > 0 ? boot?.boards[level.id] : null;
    const bOk = b && b.key === levelBoardKey(level.id, data.hash(level)) ? b : null;
    const ai = data.ghostJson(level, 'ai');
    const sum = data.summaryOf(level);
    const aiGap = sum?.minGapMm ?? ai?.minGapMm ?? null;
    return {
      level, ok, score: res.score, parSub: data.parSub(level), pbSub, wrSub: bOk?.top[0]?.[2] ?? null,
      medal, crown, nextMedalSub, gapMm: Number.isFinite(res.gapMm) ? res.gapMm : NaN,
      aiGapMm: typeof aiGap === 'number' ? aiGap : NaN, peakF: res.peakF, aiPeakF: sum?.peakF ?? ai?.peakF ?? NaN,
      badges, failReason, rank: null, aiBeaten: bOk ? bOk.aiBeaten : null, replay,
      strobe: play!.lastTrack ? strobeOf(play!.lastTrack) : new Float32Array(0),
      standing: ok ? levelStanding(level, res.score, pbSub, replay) : null,
      ballFill: skins.ballFill(level),
    };
  }

  // ---- the rank row of the results card (GAME_DESIGN.md §9.4, §7.9) ----

  /**
   * Where this clear stands, from the boot board alone (instant; the server's answer replaces it). Null for the daily,
   * a practice / assist run, offline without a boot, or a boot of another board key. `prevBest`: the PB before this run.
   * A PB shows its own standing; a slower clear shows the PB's (forPb false).
   */
  function levelStanding(level: LevelDef, score: number | null, prevBest: number | null, replay: string | null): Standing | null {
    if (level.world === 0 || score === null || !rankable() || !api) return null;
    const boot = api.lastBoot?.() ?? null;
    const key = levelBoardKey(level.id, data.hash(level));
    const b = boot?.boards[level.id];
    if (!b || b.key !== key) return null;
    const p = progressOf(level);
    const forPb = prevBest === null || score < prevBest;
    const t = forPb ? score : p.bestSub;
    if (t === null) return null;
    const snap: BoardSnapshot = { top: b.top, cutoff: b.cutoff, hist: levelHistOf(b), complete: false };
    const me = save().id.pidh;
    const counted = p.sentSub ?? null;
    const L = localRank(snap, t, me, counted);
    let was: number | null = null;
    if (forPb && prevBest !== null && L.rank !== null && L.rank > BOARD_TOP_N) {
      const w = localRank(snap, prevBest, me, counted).rank;
      if (w !== null && w > BOARD_TOP_N) was = w;
    }
    // A PB without a replay (above 6 KB) is never sent: it keeps the local estimate.
    const phase: StandingPhase = !forPb || !L.candidate || !replay ? 'local' : api.lite || api.readOnly ? 'held' : 'queued';
    return { runKey: `${key}:${t}`, forPb, rank: L.rank, n: L.n, pct: L.pct, was, exact: L.exact, candidate: L.candidate, phase, stamp: null };
  }

  /** A top-100 candidate PB goes out at once (flush 'rankIn', its board first); the answer comes through onResults. */
  function sendRankIn(level: LevelDef, r: ResultsData): void {
    const s = r.standing;
    if (!api || !s || !s.candidate || s.phase !== 'queued' || !api.enabled || api.lite || api.readOnly) return;
    r.standing = { ...s, phase: 'pending' };
    const runKey = s.runKey;
    const sent = safe('api.flush', () => api.flush('rankIn', { first: levelBoardKey(level.id, data.hash(level)) }), null);
    if (!sent) {
      setStandingPhase(runKey, 'queued');
      return;
    }
    // null: nothing carries the run now (offline, 429 backoff): it waits in the outbox.
    void sent.then((res) => { if (res === null) setStandingPhase(runKey, 'queued'); }, () => setStandingPhase(runKey, 'queued'));
  }

  /** Moves the card's standing out of 'pending' (only while it is still about the same time and still pending). */
  function setStandingPhase(runKey: string, phase: StandingPhase): void {
    const r = play?.results;
    const s = r?.standing;
    if (disposed || !r || !s || s.runKey !== runKey || s.phase !== 'pending') return;
    r.standing = { ...s, phase };
  }

  const numOrNull = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

  /** The card's standing after the server's answer for its run (a missing answer keeps the run queued). */
  function fromAnswer(s: Standing, r: SubmitResult | undefined): Standing {
    if (!r || r.status === 'deferred') return { ...s, phase: 'queued' };
    if (r.status === 'rejected') return { ...s, phase: r.reason === 'lite' ? 'held' : 'local' };
    const srvRank = numOrNull(r.rank);
    let rank = srvRank ?? s.rank;
    // A counted run inside the top 100 always gets its exact rank back, so an answer without one (unranked, or an
    // accepted / notBetter run outside the top with no usable histogram) means the local top-100 guess was wrong.
    if (srvRank === null && rank !== null && rank <= BOARD_TOP_N) rank = null;
    const nSrv = numOrNull(r.n) ?? s.n;
    const n = nSrv === null ? rank : Math.max(nSrv, rank ?? 0);
    const pct = rank !== null && rank > BOARD_TOP_N ? numOrNull(r.pct) ?? (n !== null ? levelPct(rank, n) : null) : null;
    const was = numOrNull(r.was) ?? s.was;
    // Honesty rule (§9.4): exact and stamped only with the server's own rank <= 100, never from a local number.
    const exact = srvRank !== null && srvRank <= BOARD_TOP_N;
    const stamp = srvRank !== null ? stampKind(r.status, srvRank, was) : null;
    return { ...s, rank, n, pct, was, exact, candidate: rank !== null && rank <= BOARD_TOP_N, phase: 'confirmed', stamp };
  }

  /**
   * Submit answers (any flush): the card's standing follows the answer for its run. A confirmed stamp that is not on
   * screen becomes a toast: at once on the level select / daily hub, else on the next select / results / daily screen
   * (never over READY / RUNNING).
   */
  function onLevelAnswers(sent: readonly PendingRun[], results: readonly SubmitResult[]): void {
    if (disposed) return;
    const byBoard = new Map(results.map((r) => [r.board, r]));
    for (const run of sent) {
      if (isDailyBoard(run.board) || run.t120 === null) continue;
      const key = `${run.board}:${run.t120}`;
      const r = byBoard.get(run.board);
      const card = play?.results ?? null;
      const s = card?.standing ?? null;
      const onCard = !!card && !!s && s.runKey === key;
      if (onCard) card.standing = fromAnswer(s, r);
      const rank = numOrNull(r?.rank);
      if (!r || rank === null) continue;
      const kind = onCard ? card.standing!.stamp : stampKind(r.status, rank, numOrNull(r.was));
      // The card is on screen, or under the replay viewer: 戻る brings it back with the stamp; leaving the viewer any
      // other way (勝負, a pasted link) makes it news then (dropViewer).
      const underViewer = state === 'DEMO' && viewer?.back === 'RESULTS';
      const cardUp = state === 'SUCCESS_BEAT' || state === 'RESULTS' || underViewer;
      if (kind && onCard && underViewer) viewer!.stampUnseen = true;
      if (kind && !(onCard && cardUp)) {
        rankNews.set(run.board, { levelId: run.level, rank, kind });
      }
    }
    // Already on a calm menu (the answer came after the player left the card): say it now.
    if (state === 'LEVEL_SELECT' || state === 'DAILY_HUB') flushRankNews();
  }

  /** Toasts the stamps the player did not see on a card (right after a select / results / daily screen is shown). */
  function flushRankNews(): void {
    if (rankNews.size === 0) return;
    const card = state === 'RESULTS' ? play?.results?.standing ?? null : null;
    for (const [board, n] of rankNews) {
      if (card && card.phase === 'confirmed' && card.runKey.startsWith(`${board}:`)) continue;   // on the card already
      const k = n.kind === 'wr' ? 'toast.rankWr' : n.kind === 'up' ? 'toast.rankUp' : 'toast.rankIn';
      ui.toast(ct(k, { id: n.levelId, n: n.rank }), 'badge');
    }
    rankNews.clear();
  }

  /** The results card is skipped (the 1-1 tutorial goes straight on): a stamp it already holds becomes a toast. */
  function cardStampToNews(): void {
    const s = play?.results?.standing;
    if (!play || !s || s.phase !== 'confirmed' || s.stamp === null || s.rank === null) return;
    rankNews.set(s.runKey.slice(0, s.runKey.lastIndexOf(':')), { levelId: play.level.id, rank: s.rank, kind: s.stamp });
  }

  function goResults(): void {
    if (!play?.results) {
      enterReady(true);
      return;
    }
    state = 'RESULTS';
    show({ id: 'results', data: play.results });
    flushRankNews();
  }

  function retry(): void {
    if (!play || !session) return;
    if (state === 'RUNNING' && session.started) {
      // a mid-run retry is an attempt (and a failure) unless it is a false start (< 1 s, §7.4)
      if (play.level.world > 0) {
        const fx = updateProgress(play.level, (p) => applyOutcome(p, 'retry', session!.ticks, play!.origin === 'campaign'));
        if (fx.hintOpened) ui.toast(ct('toast.hintOpen', { n: fx.hintOpened }), 'info');
      }
      if (play.level.world === 0 && play.dailyOfficial && rackFull(save().daily.balls)) queueDailySubmit(true);
      else if (play.level.world === 0 && play.dailyOfficial) sendClosedRack();
    }
    if (play.level.world === 0 && play.dailyOfficial && rackFull(save().daily.balls) && state !== 'RESULTS') {
      // the 5th ball is gone: show the share screen (§7.5)
      goDaily();
      return;
    }
    if (state === 'RESULTS' && play.results?.ok) maybeFetchRival(play.level);
    enterReady(true);
  }

  /** Leaving a run by other means than retry (menu, next level): counted like a retry. */
  function leaveRun(): void {
    // The replay viewer stands on the results card: leaving it is leaving the card.
    const from = state === 'DEMO' && viewer ? viewer.back : state;
    dropViewer();
    if (state === 'RUNNING' && play && session?.started && play.level.world > 0) {
      updateProgress(play.level, (p) => applyOutcome(p, 'retry', session!.ticks, play!.origin === 'campaign'));
    }
    if ((state === 'PAUSED' || state === 'NOTES') && underState === 'RUNNING' && play && session?.started && play.level.world > 0) {
      updateProgress(play.level, (p) => applyOutcome(p, 'retry', session!.ticks, play!.origin === 'campaign'));
    }
    if (from === 'RESULTS' || from === 'DAILY_HUB') {
      if (api) safe('api.flush', () => void api.flush('menu'));
    }
    if (state === 'PAUSED' && audio) safe('audio.resume', () => audio.resume());
    loop.paused = false;
    replayDriver = null;
    if (play) play.dailyBall = -1; // an abandoned daily ball stays red; nothing settles it any more
  }

  function pause(): void {
    if (state !== 'READY' && state !== 'RUNNING') return;
    underState = state;
    state = 'PAUSED';
    loop.paused = true;
    if (audio) safe('audio.suspend', () => audio.suspend());
    show({ id: 'pause' });
  }

  function resume(): void {
    if (state === 'PAUSED' || state === 'NOTES' || state === 'LEADERBOARD') {
      const back = underState ?? 'READY';
      underState = null;
      if (back === 'READY' || back === 'RUNNING') {
        state = back;
        loop.paused = false;
        if (audio) safe('audio.resume', () => audio.resume());
        show({ id: 'hud' });
        return;
      }
      state = back;
      reshow();
    }
  }

  function reshow(): void {
    switch (state) {
      case 'RESULTS': if (play?.results) show({ id: 'results', data: play.results }); else goSelect(); break;
      case 'DAILY_HUB': goDaily(); break;
      case 'LEVEL_SELECT': goSelect(); break;
      case 'TITLE': goTitle(); break;
      case 'PAUSED': show({ id: 'pause' }); break;
      default: show({ id: 'hud' });
    }
  }

  function goNext(): void {
    if (!play) {
      goSelect();
      return;
    }
    if (play.tutorialNext && play.level.id === '1-1') {
      const target = play.tutorialNext;
      play.tutorialNext = null;
      goLink(target);
      return;
    }
    if (play.level.world === 0) {
      goDaily();
      return;
    }
    const nxt = nextLevel(play.level, data.levels);
    if (nxt && isUnlocked(nxt)) openLevel(nxt, { origin: 'campaign' });
    else goSelect();
  }

  function startDemo(_auto: boolean): void {
    if (!play) return;
    const tr = ghosts.calm ?? ghosts.ai;
    if (!tr) {
      dropViewer();
      enterReady(true);
      return;
    }
    leaveRun();   // also drops a replay viewer: this is the AI demo
    session?.retry();
    // the demo is drawn as a Running run (not the reset session's Ready): clear the crash debris of the
    // run that led here, snap the camera and start a fresh trail
    safe('renderer.resetFx', () => renderer.resetFx());
    renderFx.clear();
    timeFx.clear();
    demoTrack = tr;
    demoTime = 0;
    demoWall = 0;
    state = 'DEMO';
    show({ id: 'demo', level: play.level });
  }

  /** Where an AI show (demo, title attract) ends: the hold completes (finishSub + 0.5 s) plus a tail; the
   *  1 s rest the ghost pipeline appends is not waited out. */
  function showEnd(tr: GhostTrack, tail: number): number {
    const dur = trackDuration(tr);
    const fin = tr.finishSub !== null && Number.isFinite(tr.finishSub) ? tr.finishSub / 120 + 0.5 : dur;
    return Math.min(dur, fin) + tail;
  }

  function endDemo(): void {
    if (viewer) {
      closeViewer();
      return;
    }
    demoTrack = null;
    enterReady(true);
  }

  // =============================================================================================== replay viewer

  /**
   * The ranking's replay viewer (§7.5 item 6). A row's replay comes from the boot WR (#1), my stored best (my row) or
   * one /api/ghost request (cached for the session), and is played only after the client re-simulated it with the
   * Worker's simulateReplay and it met the Worker's acceptance rule for the row's time (rankedScore). The viewer draws
   * the simulator's own state of every tick (the recorder), so the ball does exactly what the ranked run did.
   * Hosted by RESULTS only (the ranking opens from the results card): the finished run under it is left untouched.
   */
  const replayId = (key: string, pidh: string, t120: number): string => `${key}|${pidh}|${t120}`;

  /** The level of a board key when a replay of it can be watched now: the loaded level on the results card. */
  function replayLevel(key: string): LevelDef | null {
    if (state !== 'RESULTS' || !play || !session || session.level !== play.level) return null;
    const k = parseBoardKey(key);
    const level = play.level;
    if (!k || k.sim !== SIM_VERSION || data.hash(level) !== k.levelHash) return null;
    if (k.kind === 'L') return level.world > 0 && level.id === k.levelId ? level : null;
    // Today's daily only (practising an older daily opens today's board: not the level on screen).
    const pick = todayPick();
    return level.world === 0 && !!pick && pick.level.id === level.id && pick.dayIndex === k.dayIndex ? level : null;
  }

  /** The boot copy of a board (its top 10 and the rank-1 replay `wr`, one D1 row). */
  function bootBoardOf(key: string): { top: BoardRow[]; wr?: string | null } | null {
    const boot = api?.lastBoot?.() ?? null;
    const k = parseBoardKey(key);
    if (!boot || !k) return null;
    if (k.kind === 'L') {
      const b = boot.boards[k.levelId];
      return b && b.key === key ? b : null;
    }
    return boot.daily.key === key ? boot.daily : null;
  }

  /**
   * Re-simulates and verifies a ranked replay: the header of this board (sim, levelHash, first q, length, no assist /
   * practice flag, as the Worker's decodeRun) and rankedScore === t120 (the Worker's simulateRun). Null when it fails.
   */
  function prepareReplay(source: PreparedReplay['source'], key: string, level: LevelDef, rank: number, pidh: string, nameSeed: number, t120: number, b64: string): PreparedReplay | null {
    try {
      const { h, qs } = decodeReplay(b64urlDecode(b64));
      if (h.sim !== SIM_VERSION || h.levelHash !== data.hash(level) || (h.flags & (ReplayFlag.Assisted | ReplayFlag.Practice)) !== 0) return null;
      if (qs.length === 0 || qs[0] === 0 || qs.length > RANKED_MAX_TICKS) return null;
      const kind: 'wr' | 'rival' = rank === 1 ? 'wr' : 'rival';
      const name = safe('displayName', () => displayName(nameSeed, pidh, lang()), '') || uiText(kind === 'wr' ? 'ghost.wr' : 'ghost.rival', undefined, lang());
      const built = trackAndHashFromReplay(level, b64, kind, name);
      if (rankedScore(built.nTicks, built.result) !== t120) return null;
      const p: PreparedReplay = {
        id: replayId(key, pidh, t120), key, level, rank, pidh, nameSeed, t120, kind, track: built.track, stateHash: built.stateHash,
        res: built.result, phases: built.phases, source,
      };
      replays.delete(p.id);
      replays.set(p.id, p);
      while (replays.size > REPLAY_CACHE_MAX) replays.delete(replays.keys().next().value!);
      return p;
    } catch {
      return null;
    }
  }

  /** The rank a cached replay is watched at now (the board moves): #1 is the WR ghost (star), the others the rival's. */
  function rerank(p: PreparedReplay, rank: number): PreparedReplay {
    p.rank = rank;
    const kind: 'wr' | 'rival' = rank === 1 ? 'wr' : 'rival';
    if (p.kind !== kind) {
      p.kind = kind;
      p.track = { ...p.track, kind };   // a new track object: a ghost picked earlier keeps its own kind
    }
    return p;
  }

  /** A cached replay, now the most recently used (the cache drops the least recently used), at the rank watched now. */
  function replayHit(p: PreparedReplay, rank: number): PreparedReplay {
    replays.delete(p.id);
    replays.set(p.id, p);
    return rerank(p, rank);
  }

  /** The row as the table showed it, at its rank (the key of replayMoved). */
  const rowKey = (key: string, rank: number, pidh: string, t120: number): string => `${key}|${rank}|${pidh}|${t120}`;

  /**
   * A replay at hand without a request: watched before (also the run the server gave for a row the table showed
   * older), #1 from the boot WR, or my own stored best. A boot / local source that fails verification is not tried
   * again; one that passed is rebuilt when the cache has dropped it (#1 and my row never cost a request).
   */
  function replayAtHand(key: string, level: LevelDef, rank: number, pidh: string, nameSeed: number, t120: number): PreparedReplay | null {
    const id = replayId(key, pidh, t120);
    const hit = replays.get(id);
    if (hit) return replayHit(hit, rank);
    const moved = replayMoved.get(rowKey(key, rank, pidh, t120));
    const got = moved ? replays.get(replayId(key, moved.pidh, moved.t120)) : undefined;
    if (got) return replayHit(got, rank);
    // #1 from boot (0 requests): only when boot's rank 1 is this very row (the player may have improved since boot).
    const b = rank === 1 ? bootBoardOf(key) : null;
    const top0 = b?.top[0];
    if (b?.wr && top0 && top0[0] === pidh && top0[2] === t120 && !replayTried.has(`boot|${id}`)) {
      const p = prepareReplay('boot', key, level, rank, pidh, nameSeed, t120, b.wr);
      if (p) return p;
      replayTried.add(`boot|${id}`);
    }
    // My row (0 requests): my stored best of this board when it has the row's time.
    if (pidh === save().id.pidh && !replayTried.has(`local|${id}`)) {
      const best = level.world === 0 ? todayBest() : progressOf(level).hash === pbHash(level) ? progressOf(level) : null;
      if (best && best.bestSub === t120 && best.bestReplay) {
        const p = prepareReplay('local', key, level, rank, pidh, nameSeed, t120, best.bestReplay);
        if (p) return p;
        replayTried.add(`local|${id}`);
      }
    }
    return null;
  }

  /** Today's daily best from the save (the rack of today), or null. */
  function todayBest(): { bestSub: number | null; bestReplay: string | null } | null {
    const dd = save().daily;
    const day = dayNow();
    return rackIsOn(dd, day.dayIndex, day.jst) ? dd : null;
  }

  function replayAvail(key: string, rank: number, row: BoardRow): ReplayAvail {
    const level = replayLevel(key);
    if (!level) return null;
    if (replayAtHand(key, level, rank, row[0], row[1], row[2])) return 'ready';
    // Online and not in low-quota mode: one request. A spent budget keeps the ▶ (tapping says why, without a request).
    return api && api.enabled && !api.lite ? 'fetch' : null;
  }

  async function loadReplay(req: ReplayReq): Promise<ReplayLoad> {
    const level = replayLevel(req.key);
    if (!level) return { ok: false, reason: 'stale' };
    const near = replayAtHand(req.key, level, req.rank, req.pidh, req.nameSeed, req.t120);
    if (near) return { ok: true, id: near.id };
    if (!api || !api.enabled || api.lite) return { ok: false, reason: 'offline' };
    const left = api.ghostsLeft?.() ?? 1;
    // A row the server already answered with another run asks for that run (the api's cache has it: no request).
    const row = rowKey(req.key, req.rank, req.pidh, req.t120);
    const want = replayMoved.get(row) ?? { pidh: req.pidh, t120: req.t120 };
    const g = await api.ghost(req.key, req.rank, want).catch(() => null);
    if (disposed) return { ok: false, reason: 'stale' };
    if (!g) return { ok: false, reason: !api.enabled || api.lite ? 'offline' : left <= 0 ? 'budget' : 'missing' };
    // Named and timed from the answer (the board may have moved since the table was drawn), never from the tapped row.
    const at = replayLevel(req.key);
    if (!at || g.key !== req.key) return { ok: false, reason: 'stale' };
    if (g.pidh !== req.pidh || g.t120 !== req.t120) {
      // The next tap of this row plays the same run without asking again (and replayAvail says 'ready').
      replayMoved.delete(row);
      replayMoved.set(row, { pidh: g.pidh, t120: g.t120 });
      while (replayMoved.size > REPLAY_CACHE_MAX * 2) replayMoved.delete(replayMoved.keys().next().value!);
    }
    const hit = replays.get(replayId(req.key, g.pidh, g.t120));
    if (hit) return { ok: true, id: replayHit(hit, req.rank).id };
    const p = prepareReplay('net', req.key, at, req.rank, g.pidh, g.nameSeed, g.t120, g.replay);
    if (!p) {
      if (!errorsLogged.has('replay verify')) {
        errorsLogged.add('replay verify');
        console.warn(`[yurapita] replay of ${req.key} #${req.rank} did not re-simulate to its ranked time`);
      }
      return { ok: false, reason: 'bad' };
    }
    return { ok: true, id: p.id };
  }

  /** The viewer's data for the UI: this player's force, the AI par ghost's, and my best's on this board. */
  function replayView(p: PreparedReplay, name: string): ReplayView {
    const mine = p.pidh === save().id.pidh;
    const ai = ghosts.ai ?? data.track(p.level, 'ai');
    // My best on this board: the one this results card may just have set (pendingPb), else the PB ghost.
    const me = mine || play?.level !== p.level ? null : pendingPb ?? ghosts.pb;
    const gap = p.level.physics.walls.length > 0 && Number.isFinite(p.res.minD2) ? ballClearanceM(p.res.minD2) * 1000 : NaN;
    return {
      id: p.id, rank: p.rank, name, t120: p.t120, kind: p.kind, mine, hz: 60, f: p.track.f, aiF: ai?.f ?? null, meF: me?.f ?? null,
      Fmax: p.level.physics.Fmax, gapMm: Number.isFinite(gap) ? gap : null, peakF: p.res.peakF,
    };
  }

  function startReplay(payload: unknown): void {
    const p = replays.get(payloadId(payload) ?? '');
    if (!p || state !== 'RESULTS' || !play || play.level !== p.level || session?.level !== p.level) return;
    // The finished run under the results card stays as it is (no leaveRun / retry / flush): the card comes back.
    safe('renderer.resetFx', () => renderer.resetFx());
    renderFx.clear();
    timeFx.clear();
    loop.paused = false;
    const name = p.track.label;
    viewer = {
      p, back: state, name, ai: ghostSetIndex() === 4 ? null : ghosts.ai ?? data.track(p.level, 'ai'),
      end: (p.t120 + HOLD_SUB) / 120, phase: 0, stampUnseen: false,
    };
    demoTrack = p.track;
    demoTime = 0;
    demoWall = 0;
    state = 'DEMO';
    show({ id: 'demo', level: p.level, replay: replayView(p, name) });
  }

  /** Back to the ranking over the state the viewer came from (the results card), scrolled to the row watched. */
  function closeViewer(): void {
    const v = viewer;
    if (!v) return;
    viewer = null;
    demoTrack = null;
    // The replay's trail and camera go (the finished run's own strobe is not redrawn behind the card).
    safe('renderer.resetFx', () => renderer.resetFx());
    state = v.back;
    reshow();
    if (state === v.back) show({ id: 'board', key: v.p.key, focusRank: v.p.rank });
  }

  /**
   * The viewer goes without 戻る (勝負, a pasted #c= / #l= / #d link, anything that leaves the card): the next DEMO is
   * the AI demo again, and a rank-in stamp the card took while the viewer was up becomes news (a toast on the next
   * select / results / daily screen), as for a card that is skipped.
   */
  function dropViewer(): void {
    const v = viewer;
    if (!v) return;
    viewer = null;
    demoTrack = null;
    if (v.stampUnseen) cardStampToNews();
  }

  /** 「このゴーストと勝負」: the next attempt on this level races the replay's ghost (§7.6). */
  function raceGhost(payload: unknown): void {
    const v = viewer;
    if (state !== 'DEMO' || !v || !play || play.level !== v.p.level) return;
    const id = payloadId(payload);
    // not my own run (the viewer offers no race for it: the PB ghost is that run)
    if ((id !== null && id !== v.p.id) || v.p.pidh === save().id.pidh) return;
    dropViewer();
    state = v.back;
    ghosts.picked = v.p.track;
    ghosts.pickedPidh = v.p.pidh;
    ui.toast(ct('toast.raceGhost', { name: v.name }), 'info');
    retry();
  }

  /** 5-4: the goal zone moves on when the replay completes a phase (the renderer's 'phase' effect, not the bus). */
  function viewerPhases(): void {
    const v = viewer;
    if (!v) return;
    while (v.phase < v.p.phases.length && v.p.phases[v.phase]!.t <= demoTime) {
      const e: GameEvent = { t: 'phase', index: v.p.phases[v.phase]!.index };
      v.phase++;
      safe('renderer.fx', () => renderer.fx(e));
    }
  }

  function skip(): void {
    if (!play) return;
    if (play.tutorialNext) {
      const target = play.tutorialNext;
      play.tutorialNext = null;
      leaveRun();
      goLink(target);
      return;
    }
    const p = progressOf(play.level);
    if (!skipAvailable(p)) return;
    updateProgress(play.level, (q) => { q.skipped = true; });
    goNext();
  }

  // =============================================================================================== daily

  /** A JST day: dayIndex (board key, #N) and the JST calendar day (tells apart the days before DAILY_EPOCH, all dayIndex 0). */
  interface DayRef { dayIndex: number; jst: number }
  interface DayPick extends DayRef { level: DailyDef; n: number }

  function dayNow(): DayRef {
    const t = now();
    return { dayIndex: dayIndexAt(t), jst: jstDayNumber(t) };
  }

  function pickOn(ms: number): DayPick | null {
    if (data.dailyPool.length === 0) return null;
    try {
      const p = pickDaily(data.dailyPool, ms);
      return { level: p.level, dayIndex: p.dayIndex, n: p.n, jst: jstDayNumber(ms) };
    } catch {
      return null;
    }
  }

  function todayPick(): DayPick | null {
    return pickOn(now());
  }

  /**
   * The day the saved rack belongs to, while the Worker still takes its board: today, or yesterday until 02:00 JST
   * (a last ball that ends after 00:00, a tab left open overnight). Null otherwise (no rack, or too late).
   */
  function rackPick(dd: SaveV1['daily']): DayPick | null {
    const jst = rackDay(dd);
    const t = now();
    if (jst < 0 || !dailyDayOpen(jst, t)) return null;
    // Before DAILY_EPOCH every day is dayIndex 0, and the api tells the day of a daily run by its dayIndex alone: an
    // answer for yesterday's rack would be booked on today's. Only today's rack goes out then.
    if (jst !== jstDayNumber(t) && dd.dayIndex === dayIndexAt(t)) return null;
    const p = pickOn(jstDayStartMs(jst));
    return p && p.dayIndex === dd.dayIndex ? p : null;
  }

  /** An official daily ball is in play: consumed at tick 0 as a provisional red, not settled yet. */
  function dailyBallLive(): boolean {
    if (!play || !play.dailyOfficial || play.dailyBall < 0) return false;
    return state === 'RUNNING' || ((state === 'PAUSED' || state === 'NOTES' || state === 'LEADERBOARD') && underState === 'RUNNING');
  }

  /** A replay recorded under this build's simulation (an older one re-simulates to another result). */
  function replaySimOk(b64: string): boolean {
    return safe('decodeReplay', () => decodeReplay(b64urlDecode(b64)).h.sim === SIM_VERSION, false) === true;
  }

  /**
   * Moves the saved rack to `day` (a no-op on the same day). A rack of an earlier day is sent first while the Worker
   * still takes it: racks are otherwise only sent when they fill or on pagehide, so balls played just before 00:00 JST
   * would be wiped unsent. Never while a ball of the rack is in play (it settles into the rack it was taken from).
   */
  function rollDaily(day: DayRef): void {
    const dd = save().daily;
    if (rackIsOn(dd, day.dayIndex, day.jst) && dd.jstDay === day.jst && dd.balls.length === DAILY_BALLS) return;
    if (dailyBallLive()) return;
    if (dd.dayIndex >= 0 && !rackIsOn(dd, day.dayIndex, day.jst)) {
      const board = queueDailySubmit(false);
      if (board) flushDaily(board);
    }
    store.update((s) => { rolloverDaily(s.daily, day.dayIndex, day.jst); });
  }

  function dailyView(): DailyView | null {
    const pick = todayPick();
    if (!pick) return null;
    rollDaily(pick);
    let dd = save().daily;
    if (!rackIsOn(dd, pick.dayIndex, pick.jst)) {
      // a ball of yesterday's rack is still in play: show today's empty rack without touching the save
      dd = { ...dd, balls: dd.balls.slice() };
      rolloverDaily(dd, pick.dayIndex, pick.jst);
    }
    const boot = api?.lastBoot?.() ?? null;
    const key = dailyBoardKey(pick.dayIndex, data.hash(pick.level));
    const bd = boot && boot.daily.key === key ? boot.daily : null;
    const par = data.parSub(pick.level);
    const net = dailyNet && dailyNet.board === key ? dailyNet : null;
    const pct = net?.pct ?? (dd.bestSub !== null && bd ? topPercent(bd.hist, bd.cleared, dd.bestSub) : null);
    let gapMm: number | null = null;
    if (dd.bestReplay) {
      if (dailyGapCache?.replay !== dd.bestReplay) {
        const best = dd.bestReplay;
        dailyGapCache = { replay: best, gapMm: replaySimOk(best) ? safe('daily best gap', () => replayGapMm(pick.level, best), null) ?? null : null };
      }
      gapMm = dailyGapCache.gapMm;
    }
    const streak = currentStreak(dd, pick.dayIndex, pick.jst);
    const origin = shareOrigin(d.publicOrigin ?? import.meta.env.VITE_PUBLIC_ORIGIN, d.location === undefined ? safeLocation() : d.location);
    const view: DailyView = {
      dayIndex: pick.dayIndex, n: pick.n, level: pick.level, balls: dd.balls.slice(), bestSub: dd.bestSub, parSub: par,
      top: bd ? bd.top : null, rank: net?.rank ?? null, pct, streak, shareText: '',
    };
    // The UI owns the share wording (its snapshot test, §10.7); core's copy is the fallback.
    view.shareText = safe('dailyShareText', () => uiDailyShareText(view, origin, lang(), { gapMm }), '')
      || dailyShareText({ lang: lang(), n: pick.n, balls: dd.balls, bestSub: dd.bestSub, parSub: par, gapMm, pct, streak, origin });
    return view;
  }

  /** The run's exact minimum clearance (the sim's minD2 over every substep), in mm; null without walls. */
  function replayGapMm(level: LevelDef, b64: string): number | null {
    if (level.physics.walls.length === 0) return null;
    const res = simulateReplay(level.physics, decodeReplay(b64urlDecode(b64)).qs);
    return Number.isFinite(res.minD2) ? ballClearanceM(res.minD2) * 1000 : null;
  }

  function startDailyPlay(): void {
    const pick = todayPick();
    if (!pick) return;
    rollDaily(pick);
    const official = rackIsOn(save().daily, pick.dayIndex, pick.jst) && !rackFull(save().daily.balls);
    if (!official) ui.toast(ct('toast.dailyPractice'), 'info');
    openLevel(pick.level, { origin: 'daily', skipBriefing: true, force: true, dailyPractice: !official });
  }

  /**
   * The saved rack into the outbox (§7.9), under the board of the day it belongs to: also yesterday's until 02:00 JST,
   * when the Worker still takes it (a fifth ball that ends after 00:00, a rollover, a pagehide after midnight).
   * final = the rack just filled: toast and send at once. Returns the board when §7.9 says a send is due (the api
   * applies the same rule), else null.
   *
   * A ball still in play at a pagehide is not reported when counting it would fill the rack: 'tries 5' would make the
   * send final, and the ball's real result (it resumes when the page comes back) could then never follow.
   */
  function queueDailySubmit(final: boolean): string | null {
    if (!api) return null;
    const dd = save().daily;
    const pick = rackPick(dd);
    if (!pick) return null;
    let balls = dd.balls;
    if (!final && dailyBallLive() && rackFull(balls) && balls[play!.dailyBall] === 'fail') {
      balls = balls.slice();
      balls[play!.dailyBall] = null;
    }
    const used = ballsUsed(balls);
    if (used < 1) return null;
    let nTicks = 0;
    let device: PendingRun['device'] = play?.level.world === 0 ? play.lastRun?.device ?? 0 : 0;
    if (dd.bestReplay) {
      const h = safe('decodeReplay', () => decodeReplay(b64urlDecode(dd.bestReplay!)).h, null);
      // a best recorded under another simulation version is refused as badReplay: it still counts the player
      if (h && h.sim === SIM_VERSION) {
        nTicks = h.nTicks;
        device = h.device;
      }
    }
    const withReplay = dd.bestReplay !== null && nTicks > 0;
    const run: PendingRun = {
      board: dailyBoardKey(pick.dayIndex, data.hash(pick.level)), level: pick.level.id,
      replay: withReplay ? dd.bestReplay : null, t120: withReplay ? dd.bestSub : null,
      device, tries: used, balls: ballsString(balls), nTicks, queuedAt: now(),
    };
    if (dd.lastSentT120 !== null || dd.submitted !== 'none') run.prev = dd.lastSentT120;
    safe('api.enqueue', () => api.enqueue(run));
    if (final) {
      ui.toast(ct('toast.dailyDone'), 'info');
      flushDaily(run.board);
    }
    return dailySendDue({ ...dd, balls, bestSub: run.t120 }) ? run.board : null;
  }

  /**
   * An official ball ended after 00:00 JST: no ball can follow in its rack (the next start is practice), so the day
   * goes out now rather than at the next rollover or pagehide. A full rack was already sent by the final path.
   */
  function sendClosedRack(): void {
    const dd = save().daily;
    const day = dayNow();
    if (rackFull(dd.balls) || rackIsOn(dd, day.dayIndex, day.jst)) return;
    const board = queueDailySubmit(false);
    if (board) flushDaily(board);
  }

  /** Sends the daily run of `board` now ('dailyDone' is exempt from the 120 s interval); its rank / 上位 n% go to the hub. */
  function flushDaily(board: string): void {
    if (!api) return;
    const sent = safe('api.flush', () => api.flush('dailyDone'), null);
    void sent?.then((resp) => {
      const r = resp?.results.find((x) => x.board === board);
      if (!r || disposed || (r.status !== 'accepted' && r.status !== 'notBetter')) return;
      dailyNet = { board, rank: typeof r.rank === 'number' ? r.rank : null, pct: typeof r.pct === 'number' ? r.pct : null };
      const pick = state === 'DAILY_HUB' ? todayPick() : null;
      if (pick && dailyBoardKey(pick.dayIndex, data.hash(pick.level)) === board) {
        const view = dailyView();
        if (view) show({ id: 'daily', data: view });
      }
    }, () => {});
  }

  // =============================================================================================== net

  /**
   * The stored best of a level into the outbox (a non-PB clear or the boot reconcile, §7.9): the server keeps the
   * fastest time it knows, so the best is what counts the player. Needs a replay of the current board and simulation.
   */
  function enqueueStoredBest(level: LevelDef): void {
    if (!api) return;
    safe('enqueueStoredBest', () => {
      const p = progressOf(level);
      if (!p.bestReplay || p.bestSub === null || p.hash !== pbHash(level)) return;
      const h = decodeReplay(b64urlDecode(p.bestReplay)).h;
      if (h.sim !== SIM_VERSION) return;
      api.enqueue({
        board: levelBoardKey(level.id, data.hash(level)), level: level.id, replay: p.bestReplay, t120: p.bestSub,
        device: h.device, nTicks: h.nTicks, queuedAt: now(),
      });
    });
  }

  /**
   * Once per session, after the first boot: levels whose stored best the server does not count (yet), counts in
   * another histogram bin, or has not counted as AI-beaten are queued (lazy: they ride the next pagehide). Nothing is
   * sent here, and the api drops what the server would ignore. Never under lite / soft / READ_ONLY, and it never
   * fills the outbox so far that a queued run would be evicted.
   */
  function reconcileLevelSends(): void {
    if (levelSendsReconciled || !api?.enabled || api.lite || api.soft || api.readOnly) return;
    const boot = api.lastBoot?.() ?? null;
    if (!boot) return;
    levelSendsReconciled = true;
    for (const level of data.levels) {
      if (level.world === 0) continue;
      if (save().outbox.length >= OUTBOX_MAX - 2) break;
      const p = save().levels[level.id];
      if (!p || p.bestSub === null || !p.bestReplay || p.hash !== pbHash(level)) continue;
      const b = boot.boards[level.id];
      if (!b || b.key !== levelBoardKey(level.id, data.hash(level))) continue;
      const best = p.bestSub;
      const due = p.sentSub === undefined || (best < p.sentSub && levelBin(best) !== levelBin(p.sentSub)) || (best < b.par && !p.aiBeatenSent);
      if (due) enqueueStoredBest(level);
    }
  }

  function enqueueLevelRun(level: LevelDef, replay: string, score: number, res: RunResult): void {
    if (!api) return;
    const run: PendingRun = {
      board: levelBoardKey(level.id, data.hash(level)), level: level.id, replay, t120: score, device: res.device,
      nTicks: res.ticks, queuedAt: now(),
    };
    safe('api.enqueue', () => api.enqueue(run));
  }

  /** Rival = the record just above my PB (100th when outside the top 100), after 3 attempts, once per level per session (§7.6). */
  function maybeFetchRival(level: LevelDef): void {
    if (!api || !api.enabled || level.world === 0 || rivalFetched.has(level.id)) return;
    const p = progressOf(level);
    if (p.attempts < RIVAL_MIN_ATTEMPTS || p.bestSub === null) return;
    const boot = api.lastBoot?.() ?? null;
    const b = boot?.boards[level.id];
    const key = levelBoardKey(level.id, data.hash(level));
    if (!b || b.key !== key) return;
    rivalFetched.add(level.id);
    const pbSub = p.bestSub;
    /** The record just above my PB: its rank and the row the answer must be (a cached answer of an older board is
     *  not it); 'full': somewhere in 11..100, the full board tells. */
    type Pick = { rank: number; pidh?: string; t120: number } | 'full' | null;
    const pick = (top: readonly (readonly [string, number, number, ...number[]])[], cutoff: number | null): Pick => {
      const me = save().id.pidh;
      const faster = top.filter((r) => r[2] < pbSub && r[0] !== me);
      if (faster.length < top.length || top.length < 10) {
        const r = faster[faster.length - 1];
        return r ? { rank: faster.length, pidh: r[0], t120: r[2] } : null;
      }
      if (cutoff !== null && pbSub > cutoff) {
        const r = top[99];
        return r ? { rank: 100, pidh: r[0], t120: r[2] } : { rank: 100, t120: cutoff };
      }
      return 'full';
    };
    const fetchGhost = (w: { rank: number; pidh?: string; t120: number }): void => {
      void api.ghost(key, w.rank, { pidh: w.pidh, t120: w.t120 }).then((g) => {
        if (!g || disposed || g.t120 >= pbSub) return;
        const name = safe('displayName', () => displayName(g.nameSeed, g.pidh, lang()), '') || uiText('ghost.rival', undefined, lang());
        const tr = safe('rival ghost', () => trackFromReplay(level, g.replay, 'rival', name), null);
        if (tr && play?.level === level) ghosts.rival = tr;
      });
    };
    const first = pick(b.top, b.cutoff);
    if (first === null) return;
    if (first !== 'full') {
      fetchGhost(first);
      return;
    }
    void api.board(key).then((full) => {
      if (!full) return;
      const w = pick(full.top, full.cutoff);
      if (w !== null && w !== 'full') fetchGhost({ ...w, rank: Math.min(100, w.rank) });
    });
  }

  // =============================================================================================== input

  /**
   * Input commands. The input layer sends 'any' right after the specific command of the same key / button press
   * (Esc -> 'pause', 'any'). When that command already moved to another state, its 'any' is dropped: otherwise
   * Esc on the level select would go back to the title and straight out of it again, and N on the results would
   * skip the next level's briefing.
   */
  function handleCommand(c: Command): void {
    if (disposed || uiBackBusy) return;
    if (c === 'any') {
      if (pairedAny) {
        pairedAny = false;
        return;
      }
      commandInState(c);
      return;
    }
    const before = state;
    commandInState(c);
    // Esc / gamepad B never count as "any key" as well (Esc on the title does not start the game).
    if (state !== before || c === 'pause' || c === 'back') {
      pairedAny = true;
      queueMicrotask(() => {
        pairedAny = false;
      });
    }
  }

  function commandInState(c: Command): void {
    if (c === 'mute') return toggleMute();
    if (c === 'ghostCycle') return cycleGhosts();
    if (c === 'aiLine') return toggleAiLine();
    if (c === 'notes') return openNotes();
    if (c === 'rewind') return rewind(); // D3: practice R long-press (repeats every 300 ms while held)
    // Esc / P / gamepad Start in a menu is "back" (the UI handles Esc itself while focus is inside its layer;
    // this is the path for focus elsewhere and for the gamepad). A UI sub-screen on top goes first.
    if (c === 'pause' && MENU_STATES.has(state)) c = 'back';
    if ((c === 'back' || c === 'pause') && SUBSCREEN_HOSTS.has(state) && uiBack()) return;
    switch (state) {
      case 'TITLE':
        if ((c === 'any' || c === 'confirm') && !skinsOpen) titleStart();
        return;
      case 'BRIEFING':
        if (c === 'any' || c === 'confirm' || c === 'back') closeBriefing();
        return;
      case 'READY':
      case 'RUNNING':
        if (c === 'retry') retry();
        else if (c === 'pause') pause();
        else if (c === 'next' && state === 'READY') {
          // N in READY only advances when the next level is open (no accidental trip to the menu)
          const nxt = play ? nextLevel(play.level, data.levels) : null;
          if (play?.tutorialNext || play?.level.world === 0 || (nxt && isUnlocked(nxt))) goNext();
        }
        return;
      case 'CRASH_BEAT':
        if (c === 'any' || c === 'retry' || c === 'confirm') endCrashBeat();
        else if (c === 'pause') {
          endCrashBeat();
          pause();
        }
        return;
      case 'RESULTS':
        // Esc / ⏸ on the results card: to the level select (the ⏸ corner button reads 「面選択」 there)
        if (c === 'retry' || c === 'confirm') retry();
        else if (c === 'next') goNext();
        else if (c === 'back' || c === 'pause') goSelect();
        return;
      case 'PAUSED':
        if (c === 'pause' || c === 'back') resume();
        else if (c === 'retry') {
          resume();
          retry();
        }
        return;
      case 'DEMO':
        if (demoWall < DEMO_SKIP_GUARD_S) return;
        if (c === 'any' || c === 'confirm' || c === 'retry' || c === 'back' || c === 'pause') endDemo();
        return;
      case 'NOTES':
      case 'LEADERBOARD':
        if (c === 'back' || c === 'pause') resume();
        return;
      case 'DAILY_HUB':
        if (c === 'back') goSelect();
        else if (c === 'confirm' || c === 'retry') startDailyPlay();
        return;
      case 'LEVEL_SELECT':
        if (c === 'back') goTitle();
        return;
      default:
        return;
    }
  }

  /**
   * Pops a UI sub-screen (settings / about / board / notes) or runs the UI's own Escape for the screen it shows.
   * Prefers the UI's optional back() hook; without it, a synthetic Escape on the UI layer does the same (the layer
   * handles Escape and stops it there). Returns true when a sub-screen was open (the core state stays).
   */
  function uiBack(): boolean {
    const u = ui as UiLike;
    if (typeof u.back === 'function') return !!safe('ui.back', () => u.back!(), false);
    let yp: HTMLElement | null = null;
    try {
      yp = root.querySelector<HTMLElement>('.yp');
    } catch {
      return false;
    }
    const screen = yp?.dataset.screen ?? '';
    const layerEl = yp?.querySelector<HTMLElement>('.yp-layer') ?? null;
    if (!layerEl || !UI_SUB_SCREENS.has(screen)) return false;
    uiBackBusy = true; // a synthetic key that escapes the layer must not come back here as a command
    try {
      layerEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
    } catch {
      return false;
    } finally {
      uiBackBusy = false;
    }
    return true;
  }

  /**
   * D3: practice rewind by 5 s (R held / the HUD button) of a running practice run, also out of its crash beat
   * (hold R right after a crash: the run continues from 5 s before it).
   */
  function rewind(): void {
    if (!play || !session || !play.practice) return;
    const fromCrash = state === 'CRASH_BEAT' && afterCrash === 'ready';
    if (!liveRun() && !fromCrash) return;
    if (!session.rewind(5)) return;
    if (fromCrash) {
      beatLeft = 0;
      renderFx.clear();
      state = 'RUNNING';
    }
    loop.resetAccumulator();
    timeFx.clear();
    replayDriver = null;
    // the trail / particles / near-miss dimensions belong to the discarded future
    safe('renderer.resetFx', () => renderer.resetFx());
    emit({ t: 'rewind', ticks: session.ticks, phase: session.run.s.phase });
  }

  function payloadId(payload: unknown): string | null {
    if (typeof payload === 'string') return payload;
    if (payload && typeof payload === 'object') {
      const o = payload as { id?: unknown; levelId?: unknown; level?: { id?: unknown } };
      if (typeof o.id === 'string') return o.id;
      if (typeof o.levelId === 'string') return o.levelId;
      if (o.level && typeof o.level.id === 'string') return o.level.id;
    }
    return null;
  }

  function handleAction(a: UiAction | 'pause' | 'rewind' | 'back', payload?: unknown): void {
    if (disposed) return;
    // the title screen's "play" (select {from:'title'}) or any other start action (§9.4 TITLE -> READY(1-1) / LEVEL_SELECT)
    if (state === 'TITLE' && (a === 'retry' || a === 'resume' || a === 'next' || a === 'select' || (a === 'openLevel' && !payloadId(payload)))) {
      titleStart();
      return;
    }
    switch (a) {
      case 'retry':
        if (state === 'DAILY_HUB') startDailyPlay();
        else if (state === 'PAUSED') {
          resume();
          retry();
        } else if (state === 'BRIEFING') closeBriefing();
        else if (state === 'DEMO') endDemo();
        else if (state === 'CRASH_BEAT') endCrashBeat();
        else retry();
        return;
      case 'next':
        if (state === 'PAUSED') resume();
        goNext();
        return;
      case 'demo':
        if (state === 'PAUSED') resume();
        startDemo(false);
        return;
      case 'board': {
        // a UI sub-screen on top of the current one (the UI pops it itself); the core state does not change
        const key = typeof payload === 'string' && /^[LD]:/.test(payload) ? payload : boardKeyForView();
        if (!key) return;
        show({ id: 'board', key });
        return;
      }
      case 'share':
        return; // the UI shares from the results / daily data it already has (§7.13)
      case 'resume':
        if (state === 'BRIEFING') closeBriefing();
        else if (state === 'DEMO') endDemo();
        else resume();
        return;
      case 'practice':
        togglePractice(onFlag(payload));
        return;
      case 'select':
        goSelect(typeof payload === 'number' ? payload : undefined);
        return;
      case 'openLevel': {
        const id = payloadId(payload);
        const level = id ? data.level(id) : null;
        if (!level) return;
        if (level.world === 0) startDailyPlay();
        else openLevel(level, { origin: 'campaign' });
        return;
      }
      case 'openDaily':
        goDaily();
        return;
      case 'settingsChanged':
        if (payload && typeof payload === 'object') {
          store.update((s) => { Object.assign(s.settings, payload as Partial<SaveV1['settings']>); });
        }
        applySettings();
        return;
      case 'skip':
        skip();
        return;
      case 'rerollName':
        store.update((sv) => { sv.id.nameSeed = randomNameSeed(sv.id.nameSeed); });
        return;
      case 'assistAccept':
        if (play) {
          play.assist = onFlag(payload) ?? true;
          play.assistOffered = true;
          if (session && !session.started) session.assisted = play.assist;
        }
        return;
      case 'ghostCycle':
        cycleGhosts();
        return;
      case 'aiLine':
        toggleAiLine();
        return;
      case 'notes': {
        const w = payload && typeof payload === 'object' ? (payload as { world?: unknown }).world : undefined;
        openNotes(typeof w === 'number' ? w : undefined);
        return;
      }
      case 'mute':
        toggleMute();
        return;
      case 'reverseHint':
        if (ghosts.reverse) {
          ghosts.showReverse = !ghosts.showReverse;
          ui.toast(ct(ghosts.showReverse ? 'toast.reverseOn' : 'toast.reverseOff'), 'info');
        }
        return;
      case 'pause':
        if (state === 'PAUSED') resume();
        else if (state === 'RESULTS') goSelect();
        else if (state === 'CRASH_BEAT') {
          // ⏸ tapped during the beat: like Esc there, the beat ends and the menu opens over the next READY
          endCrashBeat();
          pause();
        } else pause();
        return;
      case 'rewind':
        rewind();
        return;
      case 'back':
        handleCommand('back');
        return;
      case 'replay':
        startReplay(payload);
        return;
      case 'raceGhost':
        raceGhost(payload);
        return;
    }
  }

  function boardKeyForView(): string | null {
    if (state === 'DAILY_HUB') {
      const pick = todayPick();
      return pick ? dailyBoardKey(pick.dayIndex, data.hash(pick.level)) : null;
    }
    if (!play) return null;
    return play.level.world === 0
      ? (() => {
        const pick = todayPick();
        return pick ? dailyBoardKey(pick.dayIndex, data.hash(pick.level)) : null;
      })()
      : levelBoardKey(play.level.id, data.hash(play.level));
  }

  function titleStart(): void {
    if (audio) safe('audio.unlock', () => audio.unlock());
    const l11 = data.level('1-1');
    if (l11 && !progressOf(l11).cleared) openLevel(l11, { origin: 'campaign', skipBriefing: true });
    else goSelect();
  }

  function closeBriefing(): void {
    if (!play) return;
    updateProgress(play.level, (p) => { p.briefed = true; });
    enterReady(false);
  }

  function endCrashBeat(): void {
    if (state !== 'CRASH_BEAT') return;
    beatLeft = 0;
    renderFx.clear();
    if (afterCrash === 'demo') startDemo(true);
    else if (afterCrash === 'daily') goDaily();
    else enterReady(true);
  }

  /** F1 / ? / the pause-menu button: the notes open as a UI sub-screen over the pause menu (the run is paused first). */
  function openNotes(world?: number): void {
    if (state === 'RUNNING' || state === 'READY') pause();
    show({ id: 'notes', world: world ?? (play && play.level.world > 0 ? play.level.world : 1) });
  }

  function onFlag(payload: unknown): boolean | undefined {
    if (payload && typeof payload === 'object' && typeof (payload as { on?: unknown }).on === 'boolean') return (payload as { on: boolean }).on;
    return undefined;
  }

  function togglePractice(on?: boolean): void {
    if (!play) return;
    play.practice = on ?? !play.practice;
    ui.toast(ct(play.practice ? 'toast.practiceOn' : 'toast.practiceOff'), 'info');
    if (state === 'PAUSED') resume();
    enterReady(true);
  }

  function toggleMute(): void {
    store.update((s) => { s.settings.muted = !s.settings.muted; });
    if (audio) safe('audio.setMuted', () => audio.setMuted(settings().muted));
  }

  function aiLineOn(): boolean {
    const v = settings().aiLine;
    if (v !== null && v !== undefined) return v;
    const w = play?.level.world ?? 1;
    return w === 0 ? true : w <= 2;
  }

  function toggleAiLine(): void {
    const next = !aiLineOn();
    store.update((s) => { s.settings.aiLine = next; });
    ui.toast(ct(next ? 'toast.aiLineOn' : 'toast.aiLineOff'), 'info');
  }

  function applySettings(): void {
    const s = settings();
    safe('setLang', () => setLang(s.lang === 'en' ? 'en' : 'ja'));
    // quality / reduced motion without a reload (renderer.init only took them once)
    const quality = s.quality === 'high' || s.quality === 'low' ? s.quality : 'auto';
    const rm = reducedMotion();
    if (quality !== renderOpts.quality || rm !== renderOpts.reducedMotion) {
      renderOpts.quality = quality;
      renderOpts.reducedMotion = rm;
      safe('renderer.setOptions', () => (renderer as Partial<RendererExtras>).setOptions?.({ quality, reducedMotion: rm }));
    }
    if (audio) {
      safe('audio.setVolume', () => audio.setVolume((s.volume ?? 80) / 100));
      safe('audio.setMuted', () => audio.setMuted(!!s.muted));
    }
    if (haptics) haptics.enabled = !!s.haptics;
    safe('input.setKeyboardMode', () => input.setKeyboardMode(s.keyboard === 'force' ? 'force' : 'speed'));
    safe('skins.apply', () => skins.apply());
  }

  /**
   * The skins sheet shows the look on the live title attract (§7.14). Over the title it is already running; opened from
   * a menu page (the settings over the level select or the daily hub) the attract runs behind the sheet and the page's
   * state comes back when the sheet closes. The UI never offers the sheet over a run, the pause menu or a results card.
   */
  function skinsAttract(open: boolean, sheetTop?: number): void {
    skinsOpen = open;
    const top = open && typeof sheetTop === 'number' && Number.isFinite(sheetTop) ? Math.round(sheetTop) : null;
    if (top !== skinsTop) {
      skinsTop = top;
      if (layout) safe('renderer.setLayout', () => renderer.setLayout(skinsSheetLayout(layout!, skinsTop)));
    }
    if (open) {
      if (skinsHost || (state !== 'LEVEL_SELECT' && state !== 'DAILY_HUB')) return;
      const lvl = data.level(TITLE_LEVEL) ?? data.levels[0];
      if (!lvl) return;
      skinsHost = state;
      state = 'TITLE';
      prepareLevel(lvl);
      session?.retry();
      ghosts = noGhosts();
      ghosts.ai = data.track(lvl, 'ai');
      titleTime = 0;
      safe('renderer.resetFx', () => renderer.resetFx());
    } else if (skinsHost) {
      if (state === 'TITLE') {
        state = skinsHost;
        ghosts = noGhosts();
      }
      skinsHost = null;
    }
  }

  // =============================================================================================== UI context

  function briefingData(level: LevelDef): GhostSummary | null {
    const ai = data.ghostJson(level, 'ai');
    const sum = data.summaryOf(level);
    const calm = data.track(level, 'calm') ?? data.track(level, 'ai');
    if (!ai && !sum) return null;
    return {
      parSub: data.parSub(level), planT: sum?.planT ?? ai?.planT ?? 0, peakF: sum?.peakF ?? ai?.peakF ?? 0,
      minGapMm: sum?.minGapMm ?? ai?.minGapMm ?? NaN, pumps: sum?.pumps ?? ai?.pumps ?? 0,
      calmPath: calm ? ballPath(calm) : new Float32Array(0),
    };
  }

  function demoInfo(level: LevelDef): DemoInfo | null {
    const calm = data.track(level, 'calm') ?? data.track(level, 'ai');
    if (!calm) return null;
    const sum = data.summaryOf(level);
    const ai = data.ghostJson(level, calm.kind as 'calm' | 'ai');
    return {
      hz: 60, aiF: calm.f, meF: play?.level === level && play.lastTrack ? play.lastTrack.f : null,
      aiGapMm: ai?.minGapMm ?? sum?.minGapMm ?? null, aiPeakF: ai?.peakF ?? sum?.peakF ?? 0, Fmax: level.physics.Fmax,
    };
  }

  function compareTracks(r: ResultsData): CompareTracks | null {
    const ai = data.track(r.level, 'ai');
    const me = play?.level === r.level ? play.lastTrack : null;
    if (!ai && !me) return null;
    return { hz: 60, me: channels(me), ai: channels(ai) };
  }

  function pauseInfo(): Partial<PauseInfo> {
    const p = play ? progressOf(play.level) : null;
    return {
      practiceAvailable: !!p && (p.fails > 0 || p.cleared),
      practice: !!play?.practice,
      skipAvailable: !!play && (!!play.tutorialNext || skipAvailable(p ?? undefined)),
      assistOffered: !!play?.assistOffered,
      assist: !!play?.assist,
      reverseHint: !!ghosts.reverse,
      ghostSet: ghostSetIndex() as 0 | 1 | 2 | 3 | 4,
      aiLine: aiLineOn(),
      muted: !!settings().muted,
    };
  }


  // =============================================================================================== frame

  const rf: RenderFrame = {
    alpha: 0, prev: { x: 0, bx: 0, by: 0, mode: Mode.Taut, T: 0, F: 0 }, cur: { x: 0, bx: 0, by: 0, mode: Mode.Taut, T: 0, F: 0 },
    L: 1, ghosts: shownPoses, targetX: null, F: 0, Fmax: 40, saturated: false, near: null, holdFrac: 0, ampDeg: 0,
    reqDeg: null, nextWall: null, timeScale: 1, status: Status.Ready, showAiLine: true, showMargin: true,
  };
  const nearObj = { wall: -1, gapMm: 0, px: 0, py: 0 };
  const hud: HudState = {
    timeSub: 0, running: false, F: 0, Fmax: 40, aiF: null, saturated: false, ampDeg: 0, restDeg: 3, T: 0, Tmax: null,
    nearGapMm: null, offline: true, mode: 'campaign', hint: null, dailyBalls: null,
  };
  /** AudioEngine.update() parameters, reused every frame (timeScale: D7, optional on the engine side). */
  const audioParams: Parameters<AudioEngine['update']>[0] & { timeScale: number } = {
    running: false, v: 0, F: 0, Fmax: 40, saturated: false, ballSpeed: 0, panX: 0, timeScale: 1,
  };

  /** The 「オフライン」 chip: no server, but not while the first boot is still on its way (up to 3 s). */
  function offline(): boolean {
    return !(api?.enabled ?? false) && !(api?.booting ?? false);
  }

  function hudMode(): HudState['mode'] {
    if (state === 'DEMO') return 'demo';
    if (!play) return 'campaign';
    if (play.practice) return 'practice';
    if (play.level.world === 0) return play.dailyOfficial ? 'daily' : 'practice';
    if (play.origin === 'challenge') return 'challenge';
    return 'campaign';
  }

  function onFrame(alpha: number, dtReal: number): void {
    if (disposed) return;
    safe('frame', () => frame(alpha, dtReal));
  }

  function frame(alpha: number, dtReal: number): void {
    pairedAny = false; // the 'any' of a key press arrives in the same event as its command, never a frame later
    const age = freshFx ? 0 : dtReal;
    freshFx = false;
    timeFx.update(age);
    renderFx.update(age);
    const base = play?.practice && (state === 'READY' || state === 'RUNNING') ? PRACTICE_SPEED : 1;
    loop.timeScale = base * timeFx.scale();

    // beats (wall clock)
    if (state === 'CRASH_BEAT') {
      beatLeft -= age;
      if (beatLeft <= 0) endCrashBeat();
    } else if (state === 'SUCCESS_BEAT') {
      beatLeft -= age;
      if (beatLeft <= 0) {
        if (play?.tutorialNext && play.level.id === '1-1') {
          cardStampToNews();
          const k = play.tutorialNext.kind;
          ui.toast(ct(k === 'daily' ? 'toast.tutorialDoneDaily' : k === 'level' ? 'toast.tutorialDoneLevel' : 'toast.tutorialDone'), 'info');
          goNext();
        } else {
          goResults();
        }
      }
    } else if (state === 'DEMO' && demoTrack) {
      demoWall += dtReal;   // the skip guard (commands of the input manager) also runs in the replay viewer
      if (viewer) {
        // The replay viewer holds on the Success frame (the hold completes) and waits for 戻る / 勝負.
        demoTime = Math.min(demoTime + dtReal * DEMO_SPEED, viewer.end);
        viewerPhases();
      } else {
        demoTime += dtReal * DEMO_SPEED;
        if (demoTime > showEnd(demoTrack, DEMO_TAIL_S)) endDemo();
      }
    } else if (state === 'TITLE' && ghosts.ai) {
      titleTime += dtReal;
      if (titleTime > showEnd(ghosts.ai, TITLE_TAIL_S)) {
        titleTime = 0;
        safe('renderer.resetFx', () => renderer.resetFx()); // the attract loops: fresh trail, camera snaps back
      }
    }

    storageNotice();
    draw(alpha, dtReal);
  }

  /**
   * The store fell back to memory (quota, private mode): say so once. Checked every calm frame, because the
   * store writes with a throttle and a failing write (e.g. the one after a results screen) is found later.
   */
  function storageNotice(): void {
    if (!store.takeStorageNotice) return;
    if (state === 'RUNNING' || state === 'CRASH_BEAT' || state === 'SUCCESS_BEAT' || state === 'DEMO' || state === 'BOOT') return;
    if (safe('store.takeStorageNotice', () => store.takeStorageNotice!(), false)) ui.toast(ct('toast.storage'), 'warn');
  }

  function draw(alpha: number, dtReal: number): void {
    if (!session) return;
    const level = session.level;
    const phys = level.physics;
    const s = session.run.s;

    // ghosts (the AI demo / a ranked replay drives the player's own crane; its ghost rides on it only for the tag; the
    // replay viewer races the AI par ghost alongside)
    if (state === 'DEMO' && demoTrack) {
      shown.length = 0;
      shownPoses.length = 0;
      poseAt(demoTrack, demoTime, demoPose);
      demoPose.label = viewer ? viewer.name : aiLabel(demoTrack.label, lang());
      shownPoses.push(demoPose);
      if (viewer?.ai) {
        poseAt(viewer.ai, demoTime, poses[0]!);
        poses[0]!.label = labelOf(viewer.ai);
        shownPoses.push(poses[0]!);
      }
    } else if (state === 'TITLE') {
      shown.length = 0;
      shownPoses.length = 0;
      if (ghosts.ai) {
        poseAt(ghosts.ai, titleTime, poses[0]!);
        poses[0]!.label = aiLabel(ghosts.ai.label, lang());
        shownPoses.push(poses[0]!);
      }
    } else {
      updateGhostPoses(ghostTime(alpha));
    }

    rf.alpha = liveRun() ? alpha : 1;
    rf.prev = session.run.prev;
    rf.cur = session.run.cur;
    if (state === 'DEMO' && demoTrack) {
      poseSnapFrom(demoPose, forceAt(demoTrack, demoTime), demoCur);
      rf.prev = demoCur;
      rf.cur = demoCur;
    } else if (state === 'TITLE' && ghosts.ai) {
      // the attract drives the crane itself with the AI's run, so the tall follow camera keeps it in view
      poseSnapFrom(poses[0]!, forceAt(ghosts.ai, titleTime), demoCur);
      rf.prev = demoCur;
      rf.cur = demoCur;
    }
    rf.L = phys.L;
    rf.ghosts = shownPoses;
    rf.targetX = state === 'READY' || state === 'RUNNING' ? steadyX ?? lastFrame?.targetX ?? null : null;
    rf.F = s.F;
    rf.Fmax = phys.Fmax;
    rf.saturated = session.saturated();
    const gap = session.nearGapMm();
    if (gap !== null && s.near.wall >= 0) {
      nearObj.wall = s.near.wall;
      nearObj.gapMm = gap;
      nearObj.px = s.near.px;
      nearObj.py = s.near.py;
      rf.near = nearObj;
    } else {
      rf.near = null;
    }
    rf.holdFrac = session.holdFrac();
    rf.ampDeg = session.ampDeg();
    rf.reqDeg = session.reqDeg();
    rf.nextWall = session.nextWall();
    // a show at ×0.5 (demo, replay): the trail's 0.1 s strobe and the particles run on sim time
    rf.timeScale = state === 'DEMO' ? DEMO_SPEED : loop.timeScale * renderFx.scale();
    rf.status = s.status;
    rf.showAiLine = aiLineOn();
    rf.showMargin = rf.showAiLine;
    const showTrack = state === 'DEMO' ? demoTrack : state === 'TITLE' ? ghosts.ai : null;
    const showT = state === 'DEMO' ? demoTime : titleTime;
    if (showTrack) {
      // the demo / attract is the AI's run: Running (trail, off-screen arrow, live goal) and Success once its
      // hold completes; it drives the force bar and HUD from the AI's force
      rf.status = showStatus(showTrack, showT);
      rf.holdFrac = showHoldFrac(showTrack, showT);
      rf.F = demoCur.F;
      // the replay viewer: the trolley's red lamp is the player's (not the finished run's under the results card)
      if (viewer) rf.saturated = trackSaturated(showTrack, showT, phys.Fmax);
      rf.targetX = null;
      rf.near = null;
      rf.reqDeg = null;
      rf.nextWall = null;
    }
    safe('renderer.draw', () => renderer.draw(rf, dtReal));

    // HUD
    const aiShown = shown.find((g) => g.track.kind === 'ai');
    const fin = session.result();
    // the clock: running substeps; after a success the final time (the 0.5 s hold is not part of it, §4.6). A show's
    // clock stops on its finish time when the hold starts (it never runs on through the hold and jumps back).
    const showSub = demoTrack ? Math.round(demoTime * 120) : 0;
    hud.timeSub = state === 'DEMO' && demoTrack
      ? (demoTrack.finishSub !== null && Number.isFinite(demoTrack.finishSub) ? Math.min(showSub, demoTrack.finishSub) : showSub)
      : fin && fin.status === Status.Success && fin.score !== null ? fin.score
        : session.started ? s.substep : 0;
    hud.running = state === 'RUNNING';
    hud.F = rf.F;
    hud.Fmax = phys.Fmax;
    // the force bar's AI mark: the AI demo's own force; in the replay viewer the AI par ghost's (not the player's)
    hud.aiF = state === 'DEMO' && demoTrack
      ? (viewer ? (viewer.ai ? forceAt(viewer.ai, demoTime) : null) : forceAt(demoTrack, demoTime))
      : aiShown ? forceAt(aiShown.track, ghostTime(alpha)) : null;
    hud.saturated = rf.saturated;
    hud.ampDeg = rf.ampDeg;
    hud.restDeg = phys.restDeg;
    hud.T = s.T;
    hud.Tmax = phys.egg ? phys.egg.Tmax : null;
    hud.nearGapMm = gap;
    hud.offline = offline();
    hud.mode = hudMode();
    hud.hint = state === 'READY' ? hintLine : null;
    hud.dailyBalls = play?.level.world === 0 && play.dailyOfficial ? save().daily.balls.slice() : null;
    if (state !== 'TITLE' && state !== 'LEVEL_SELECT' && state !== 'DAILY_HUB') {
      const snapshot: HudState = { ...hud, anchors: hudAnchors() };
      safe('ui.hud', () => ui.hud(snapshot));
    }

    if (audio) {
      const running = state === 'RUNNING';
      let panX = 0;
      if (layout && layout.w > 0) {
        const p = safe('worldToScreen', () => renderer.worldToScreen(s.bx, s.by), null);
        if (p) panX = Math.max(-1, Math.min(1, (p.x / layout.w) * 2 - 1));
      }
      // D7: the sim time scale (practice x0.5, near-miss slow-mo) so the hold riser follows slowed time
      audioParams.running = running;
      audioParams.v = s.v;
      audioParams.F = running ? s.F : 0;
      audioParams.Fmax = phys.Fmax;
      audioParams.saturated = running && rf.saturated;
      audioParams.ballSpeed = running ? Math.hypot(s.bvx, s.bvy) : 0;
      audioParams.panX = panX;
      audioParams.timeScale = state === 'DEMO' ? DEMO_SPEED : loop.timeScale;
      safe('audio.update', () => audio.update(audioParams));
    }
  }

  /**
   * Screen anchors of the world-following HUD meters (§9.3: swing meter under the trolley, required-angle arc,
   * gap gauge, hold ring). Computed after renderer.draw() so they follow this frame's (shaken) camera and the
   * same interpolated pose the renderer drew.
   */
  function hudAnchors(): HudAnchors | null {
    if (!session || !layout || state === 'DEMO') return null;
    const a = rf.alpha;
    const x = rf.prev.x + (rf.cur.x - rf.prev.x) * a;
    const bx = rf.prev.bx + (rf.cur.bx - rf.prev.bx) * a;
    const by = rf.prev.by + (rf.cur.by - rf.prev.by) * a;
    const L = session.level.physics.L;
    const pivot = safe('worldToScreen', () => renderer.worldToScreen(x, RAIL_Y), null);
    const ball = safe('worldToScreen', () => renderer.worldToScreen(bx, by), null);
    const low = safe('worldToScreen', () => renderer.worldToScreen(x, RAIL_Y - L), null);
    if (!pivot || !ball || !low) return null;
    const pxPerM = Math.hypot(low.x - pivot.x, low.y - pivot.y) / L;
    if (!(pxPerM > 0) || !Number.isFinite(pxPerM + pivot.x + pivot.y + ball.x + ball.y)) return null;
    const w = rf.nextWall !== null ? session.level.physics.walls[rf.nextWall] : undefined;
    return {
      pivot: { x: pivot.x, y: pivot.y }, ball: { x: ball.x, y: ball.y }, pxPerM,
      slack: rf.cur.mode === Mode.Slack, holdFrac: rf.holdFrac, reqDeg: rf.reqDeg,
      reqDir: w && (w.x0 + w.x1) / 2 < x ? -1 : 1,
    };
  }

  // =============================================================================================== test hooks

  function debugState(): AppDebugState {
    const s = session?.run.s ?? null;
    const lvl = play?.level ?? null;
    return {
      state,
      level: lvl?.id ?? session?.level.id ?? null,
      mode: play ? hudMode() : null,
      tutorial: !!play?.tutorialNext,
      status: s ? s.status : null,
      ticks: session?.ticks ?? 0,
      substep: s?.substep ?? 0,
      timeScale: loop.timeScale,
      paused: loop.paused,
      ghosts: (state === 'TITLE' || state === 'DEMO' ? shownPoses.map((p) => p.kind) : setTracks().map((t) => t.kind)),
      ghostSet: ghostSetIndex(),
      hint: hintLine,
      offline: offline(),
      dailyBalls: lvl && lvl.world === 0 ? save().daily.balls.slice() : null,
      last: lastDebug,
      bestSub: lvl ? (lvl.world === 0 ? save().daily.bestSub : progressOf(lvl).bestSub) : null,
      events: eventCount,
      challengeHash: ghosts.challenge ? challengeHash : null,
      pose: s ? { x: s.x, v: s.v, th: s.th, bx: s.bx, by: s.by } : null,
      replay: viewer ? {
        key: viewer.p.key, rank: viewer.p.rank, pidh: viewer.p.pidh, t120: viewer.p.t120, score: viewer.p.res.score,
        stateHash: viewer.p.stateHash, source: viewer.p.source, kind: viewer.p.kind, t: demoTime,
      } : null,
      picked: ghosts.picked && ghosts.pickedPidh ? { pidh: ghosts.pickedPidh, kind: ghosts.picked.kind } : null,
    };
  }

  function command(c: string, payload?: unknown): void {
    // split at the first colon only: 'openLevel:d:17' -> ['openLevel', 'd:17']
    const colon = c.indexOf(':');
    const name = colon < 0 ? c : c.slice(0, colon);
    const arg = colon < 0 ? undefined : c.slice(colon + 1);
    const cmds: Command[] = ['retry', 'pause', 'next', 'confirm', 'back', 'ghostCycle', 'aiLine', 'mute', 'notes', 'rewind', 'any'];
    if ((cmds as string[]).includes(name) && arg === undefined && payload === undefined) {
      handleCommand(name as Command);
      return;
    }
    if (name === 'openLevel') {
      // test hook: open any level, locked or not (E2E opens 1-2 on a fresh save)
      const level = data.level(String(arg ?? payloadId(payload) ?? ''));
      if (!level) return;
      if (level.world === 0 && !isToday(level)) openLevel(level, { origin: 'daily', force: true, skipBriefing: true, dailyPractice: true });
      else if (level.world === 0) startDailyPlay();
      else openLevel(level, { origin: 'campaign', force: true, skipBriefing: true });
      return;
    }
    handleAction(name as UiAction, arg ?? payload);
  }

  async function playReplay(levelId: string, b64: string): Promise<PlayReplayResult> {
    const level = data.level(levelId);
    if (!level) throw new Error(`playReplay: unknown level ${levelId}`);
    const { qs } = decodeReplay(b64urlDecode(b64));
    if (!play || play.level !== level || (state !== 'READY' && state !== 'RUNNING')) {
      openLevel(level, { origin: level.world === 0 ? 'daily' : 'campaign', skipBriefing: true, force: true, dailyPractice: level.world === 0 && !isToday(level) });
      if (state === 'BRIEFING') closeBriefing();
    } else {
      enterReady(true);
    }
    replayDriver = { qs, i: 0 };
    const tickCount = qs.length;
    for (let i = 0; i < tickCount + 1 && (state === 'READY' || state === 'RUNNING'); i++) stepPlay();
    replayDriver = null;
    const res = session?.result() ?? null;
    const out: PlayReplayResult = {
      status: session?.status() ?? Status.Ready, score: res?.score ?? null, ticks: session?.ticks ?? 0, state,
    };
    // let the beat finish in real time (the frame loop drives it)
    const t0 = Date.now();
    while ((state === 'SUCCESS_BEAT' || state === 'CRASH_BEAT') && Date.now() - t0 < 5000) {
      await new Promise((r) => setTimeout(r, 30));
      if (!loop.running) onFrame(0, 0.03);
    }
    out.state = state;
    return out;
  }

  // =============================================================================================== API

  return {
    bus,
    state: () => state,
    debugState,
    command,
    playReplay,
    advance(dt: number) {
      loop.advance(dt);
    },
    toScreen(x: number, y: number) {
      const r = renderer as Renderer & { worldToScreenBase?(x: number, y: number): { x: number; y: number } };
      return safe('toScreen', () => (r.worldToScreenBase ? r.worldToScreenBase(x, y) : r.worldToScreen(x, y)), null) ?? null;
    },
    dispose() {
      disposed = true;
      safe('api.onResults', () => stopResults?.());
      loop.stop();
      try {
        document.removeEventListener('visibilitychange', onVisibility);
        window.removeEventListener('pagehide', onPageHide);
        window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('hashchange', onHashChange);
        motionQuery?.removeEventListener?.('change', onMotionPref);
      } catch {
        // not a browser
      }
      safe('input.dispose', () => input.dispose());
      safe('renderer.dispose', () => renderer.dispose());
    },
  };
}

// ----------------------------------------------------------------------------------------------- default wiring

function forwardingContext(get: () => UiContext | null): UiContext {
  const fwd = <K extends keyof UiContext>(k: K): UiContext[K] =>
    ((...args: unknown[]) => {
      const c = get();
      const f = c?.[k] as unknown as ((...a: unknown[]) => unknown) | undefined;
      return typeof f === 'function' ? f(...args) : null;
    }) as unknown as UiContext[K];
  return {
    get store() { return get()?.store ?? null; },
    get levels() { return get()?.levels; },
    get summary() { return get()?.summary; },
    get origin() { return get()?.origin; },
    boot: fwd('boot'), fetchBoard: fwd('fetchBoard'), daily: fwd('daily'), unlocked: fwd('unlocked'), briefing: fwd('briefing'),
    demo: fwd('demo'), compare: fwd('compare'), aiPath: fwd('aiPath'), pause: fwd('pause'), replayAvail: fwd('replayAvail'),
    loadReplay: fwd('loadReplay'),
    skins: fwd('skins'), skinPreview: fwd('skinPreview'), skinsShown: fwd('skinsShown'),
  } as UiContext;
}

function defaultDeps(given: Partial<AppDeps>, sink: { current: UiContext | null }): Partial<AppDeps> {
  const out: Partial<AppDeps> = {};
  const data = given.data ?? createGameData();
  out.data = data;
  out.now = given.now ?? (() => Date.now());
  const store = given.store ?? createStore({ levelHashes: Object.fromEntries(data.levels.map((l) => [l.id, progressHash(data.hash(l))])) });
  out.store = store;
  const st = store.data().settings;
  try {
    setLang(st.lang === 'en' ? 'en' : 'ja');
  } catch {
    // i18n not ready
  }
  if (!given.api && given.api !== null) {
    try {
      out.api = createApi(store);
    } catch (e) {
      console.warn('[yurapita] api unavailable', e);
      out.api = null;
    }
  }
  if (!given.ui) out.ui = (createUI as unknown as (ctx?: UiContext) => UI)(forwardingContext(() => sink.current));
  if (!given.renderer) out.renderer = createRenderer();
  if (!given.input) out.input = createInputManager();
  if (given.audio === undefined) {
    try {
      out.audio = createAudioEngine({ volume: (st.volume ?? 80) / 100, muted: !!st.muted });
    } catch (e) {
      console.warn('[yurapita] audio unavailable', e);
      out.audio = null;
    }
  }
  if (given.haptics === undefined) {
    try {
      out.haptics = createHaptics({ enabled: !!st.haptics });
    } catch {
      out.haptics = null;
    }
  }
  return out;
}

/** Helpers exported for tests. */
export const __test = { emptyRack, getLang };
