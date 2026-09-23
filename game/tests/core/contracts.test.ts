// M0: src/contracts.ts re-exports every §10.3 / §10.4 type and value. Owner: O3 (written at M0).
// Type-level half: the `import type` list below fails `npm run typecheck` if a type goes missing.
import { describe, expect, it } from 'vitest';
import * as C from '../../src/contracts';
import type {
  // sim
  WallDef, ZoneDef, EggDef, LevelPhysics, SplitDef, ResearchSeed, FallbackStep, LevelDef, LevelsFile, DailyDef, DailyPoolFile,
  CrashInfo, NearInfo, SimState, PoseSnap, Run, ReplayHeader, ReplayResult, ReplayRecorder, LevelFacts,
  // bus
  GameEvent, Medal, BadgeId,
  // input
  Intent, InputFrame, Command, RailMapper, InputManager, ServoTuning,
  // render
  Rect, Layout, GhostKind, GhostPose, RenderFrame, Renderer,
  // audio
  AudioEngine, Haptics,
  // ui
  HudState, Screen, GhostSummary, ResultsData, DailyView, BoardRow, UiAction, UiElements, UI,
  // store / net
  LevelProgress, SaveV1, Store, PendingRun, Api, BootResponse, SubmitRequest, SubmitResponse, GhostResponse, BoardResponse,
  // ghosts
  GhostTrack, AiGhostJson,
} from '../../src/contracts';

/** Compile-time only: every contract type must be importable. */
export type AllContractTypes = [
  WallDef, ZoneDef, EggDef, LevelPhysics, SplitDef, ResearchSeed, FallbackStep, LevelDef, LevelsFile, DailyDef, DailyPoolFile,
  CrashInfo, NearInfo, SimState, PoseSnap, Run, ReplayHeader, ReplayResult, ReplayRecorder, LevelFacts,
  GameEvent, Medal, BadgeId,
  Intent, InputFrame, Command, RailMapper, InputManager, ServoTuning,
  Rect, Layout, GhostKind, GhostPose, RenderFrame, Renderer,
  AudioEngine, Haptics,
  HudState, Screen, GhostSummary, ResultsData, DailyView, BoardRow, UiAction, UiElements, UI,
  LevelProgress, SaveV1, Store, PendingRun, Api, BootResponse, SubmitRequest, SubmitResponse, GhostResponse, BoardResponse,
  GhostTrack, AiGhostJson,
];

describe('contracts (§10.3, §10.4)', () => {
  it('exports the enums with the spec values at runtime', () => {
    expect([C.Mode.Taut, C.Mode.Slack]).toEqual([0, 1]);
    expect([C.Status.Ready, C.Status.Running, C.Status.Success, C.Status.Crash, C.Status.Timeout]).toEqual([0, 1, 2, 3, 4]);
    expect([C.CrashKind.Ball, C.CrashKind.String, C.CrashKind.Beam, C.CrashKind.Floor, C.CrashKind.Egg]).toEqual([1, 2, 3, 4, 5]);
    expect([C.Ev.Snap, C.Ev.SlackBegin, C.Ev.StopHit, C.Ev.WallCross, C.Ev.Apex, C.Ev.HoldBegin,
      C.Ev.HoldReset, C.Ev.PhaseDone, C.Ev.Success, C.Ev.Crash, C.Ev.Timeout]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect([C.DeviceTag.Unknown, C.DeviceTag.Touch, C.DeviceTag.Mouse, C.DeviceTag.Keyboard, C.DeviceTag.Gamepad, C.DeviceTag.Mixed])
      .toEqual([0, 1, 2, 3, 4, 5]);
    expect([C.ReplayFlag.Assisted, C.ReplayFlag.Practice, C.ReplayFlag.DirectForce]).toEqual([1, 2, 4]);
  });

  it('exports the constants of §10.4', () => {
    expect(C.SIM_VERSION).toBe(1);
    expect(C.SERVO).toEqual({ kx: 5.0, kvPerKg: 20 / 3, vCap: 4.0, vCapFine: 1.0, assistKa: 3.0 });
    expect(C.forceOfQ(127, 40)).toBe(40);
    expect(C.forceOfQ(-127, 6)).toBe(-6);
  });

  it('exports every function of §10.4', () => {
    const fns = [
      'createRun', 'resetRun', 'copyState', 'restoreState', 'stepTick', 'forceOfQ', 'ballClearanceM', 'levelFacts',
      'sincos', 'atan2k', 'levelHash', 'validateLevel', 'encodeReplay', 'decodeReplay', 'b64urlEncode', 'b64urlDecode',
      'simulateReplay', 'servoQ', 'fmtLevelText', 'trackFromAiGhost', 'trackFromReplay', 'reversed', 'poseAt',
    ];
    const exported = C as unknown as Record<string, unknown>;
    expect(fns.filter((f) => typeof exported[f] !== 'function')).toEqual([]);
  });

  it('SimEvents is a fixed 64-slot buffer', () => {
    const ev = new C.SimEvents();
    for (let i = 0; i < 70; i++) ev.push(C.Ev.Apex, i, i, 0, 0);
    expect(ev.n).toBe(64);
    expect(ev.kind.length).toBe(64);
    ev.clear();
    expect(ev.n).toBe(0);
  });
});
