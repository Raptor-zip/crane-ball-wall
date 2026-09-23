// Input contract (GAME_DESIGN.md §10.4 "入力"). Owner: O4.
import type { LevelPhysics } from '../sim/level';
import type { SimState } from '../sim/run';
import type { DeviceTag } from '../sim/replay';
import type { Layout } from '../render/renderer';

/**
 * What a device wants (§3.1). The servo (servo.ts) turns it into the quantised force q.
 * - idle:     hold the last target (InputFrame.targetX; the current x when null). The anti-sway
 *             assist (§3.6) only acts on idle frames.
 * - target:   go to x (clamped to rail ± 0.30 m).
 * - velocity: trolley velocity command in m/s (keyboard ramps, gamepad stick).
 * - force:    direct force in N (keyboard "direct force" setting).
 */
export type Intent =
  | { kind: 'idle' } | { kind: 'target'; x: number } | { kind: 'velocity'; v: number } | { kind: 'force'; f: number };
/**
 * One 60 Hz input sample.
 * - fine:    fine mode (v_cap 1.0 m/s): tall-deck fine band gesture, Shift/Z, gamepad LB.
 * - device:  the devices that produced movement input since resetForRun, accumulated
 *            (Unknown before any, Mixed once two kinds were used). Write the value of the
 *            last sampled frame of a run into the replay header.
 * - targetX: the current position target / hold point (target ring, tether);
 *            null while a velocity or force intent drives the trolley or no target was set yet.
 */
export interface InputFrame { intent: Intent; fine: boolean; device: DeviceTag; targetX: number | null }
/**
 * Commands (§3.3 key table, gamepad buttons, right click). 'any' follows every fresh key press
 * (not auto-repeat, not bare modifiers), primary pointer press on the scene/deck and gamepad button
 * press, AFTER the specific command if there is one (e.g. R -> 'retry', 'any'). The core uses it
 * for "any input" transitions (title, crash beat, demo skip).
 * 'confirm' = Enter / Space / gamepad A ("retry on the results card, OK in menus"); it is not sent
 * while focus is on a button or link (the browser clicks it instead).
 * 'rewind' = practice mode only (setPractice(true), §3.5, lead decision D3): holding R for
 * REWIND_KEY.holdMs (300 ms) sends 'rewind', 'any', then 'rewind' again every REWIND_KEY.repeatMs
 * while R stays down; such a long press never sends 'retry'. In practice mode a short R press sends
 * 'retry', 'any' on key-up instead of key-down. Backspace, right click and gamepad Back stay
 * immediate retries in every mode.
 */
export type Command =
  | 'retry' | 'pause' | 'next' | 'confirm' | 'back' | 'ghostCycle' | 'aiLine' | 'mute' | 'notes' | 'rewind' | 'any';
/** Implemented by O5 (render/mapper.ts). */
export interface RailMapper { screenToRailX(clientX: number, clientY: number): number | null }
export interface InputManager {
  /** (Re)binds to the current elements; call again on every layout change (resets the clutch, keeps the target). */
  attach(scene: HTMLElement, deck: HTMLElement | null, mapper: RailMapper, layout: Layout): void;
  setLevel(phys: LevelPhysics): void;
  resetForRun(startX: number): void;           // clears the target
  /**
   * Once per 60 Hz tick. A state whose substep counter went backwards without a resetForRun (the
   * practice rewind restored an older state) re-anchors the hold point at the restored trolley x,
   * so the trolley brakes to rest there instead of racing back to the pre-rewind target.
   */
  sample(s: SimState): InputFrame;
  onCommand(cb: (c: Command) => void): void;
  setKeyboardMode(m: 'speed' | 'force'): void;
  /**
   * Practice mode on/off (§3.5, D3): enables the R long-press 'rewind'. Call it whenever the
   * practice flag of the current play changes, and with false when leaving play (title, menus).
   * Turning it off while R is down cancels that press (neither 'retry' nor 'rewind').
   */
  setPractice(on: boolean): void;
  dispose(): void;
}
