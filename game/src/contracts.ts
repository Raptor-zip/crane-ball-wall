// Cross-module contracts (GAME_DESIGN.md §10.3, §10.4). Owner: O3.
// Re-exports ONLY. To change a type, edit its defining module (e.g. src/sim/level.ts);
// breaking changes need agreement of every consumer (spec update).

// ---- sim (O1) ----
export { SIM_VERSION } from './sim/constants';
export type {
  WallDef, ZoneDef, EggDef, LevelPhysics, SplitDef, ResearchSeed, FallbackStep,
  LevelDef, LevelsFile, DailyDef, DailyPoolFile,
} from './sim/level';
export { levelHash, validateLevel } from './sim/level';
export { Mode, Status, CrashKind, createRun, resetRun, copyState, restoreState, stepTick, forceOfQ } from './sim/run';
export type { CrashInfo, NearInfo, SimState, PoseSnap, Run } from './sim/run';
export { Ev, SimEvents } from './sim/events';
export { sincos, atan2k } from './sim/detmath';
export { DeviceTag, ReplayFlag, encodeReplay, decodeReplay, simulateReplay, rankedScore } from './sim/replay';
export type { ReplayHeader, ReplayResult, ReplayRecorder } from './sim/replay';
export { b64urlEncode, b64urlDecode } from './sim/b64';
export { ballClearanceM, levelFacts } from './sim/display';
export type { LevelFacts } from './sim/display';

// ---- event bus (O3) ----
export type { GameEvent, Medal, BadgeId } from './core/bus';

// ---- input (O4) ----
export type { Intent, InputFrame, Command, RailMapper, InputManager } from './input/types';
export type { ServoTuning } from './input/servo';
export { SERVO, servoQ } from './input/servo';

// ---- render (O5) ----
export type { Rect, Layout, GhostKind, GhostPose, RenderFrame, Renderer } from './render/renderer';

// ---- audio (O6) ----
export type { AudioEngine } from './audio/engine';
export type { Haptics } from './audio/haptics';

// ---- UI (O7) ----
export type {
  HudState, Screen, GhostSummary, ResultsData, DailyView, BoardRow, UiAction, UiElements, UI,
} from './ui/ui';
export { fmtLevelText } from './ui/i18n/format';

// ---- store (O8) ----
export type { LevelProgress, SaveV1, Store } from './store/save';

// ---- net (O8) ----
export type { PendingRun } from './net/outbox';
export type { Api } from './net/api';
export type {
  BootResponse, SubmitRequest, SubmitResponse, GhostResponse, BoardResponse,
} from './shared/api';

// ---- ghosts (O3) ----
export type { GhostTrack, AiGhostJson } from './core/ghosts';
export { trackFromAiGhost, trackFromReplay, reversed, poseAt } from './core/ghosts';
