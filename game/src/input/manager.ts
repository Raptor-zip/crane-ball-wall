// Combines pointer / keyboard / gamepad into one InputFrame per tick (GAME_DESIGN.md §3.3, §3.6). Owner: O4.
//
// Arbitration: every device that is currently pushing (finger or mouse button down, movement key
// held or its ramp still braking, stick outside the dead zone) is a candidate; the one whose push
// started last wins. When nobody pushes, the trolley holds the last target:
//   - pointer: the target stays where the finger left it (crane-game cursor); the frame becomes
//     'idle' once the target has not changed for 15 ticks (§3.6).
//   - keyboard / gamepad (speed): on the tick the velocity command reaches 0 the intent switches to
//     {kind:'target', x: trolley x} (§3.3) and is 'idle' afterwards (key speed command 0, §3.6).
//     Stop latch (lead decision D1): while the trolley is still braking in its direction of travel,
//     the hold point follows it, so the trolley holds where it comes to rest (3 s cap). The velocity
//     loop lags the 0.08 s ramp and a weak F_max cannot brake quickly, so holding the x of the stop
//     tick itself would pull the trolley back against its own brake: 9-22 cm on 40 N levels and
//     0.6-2.7 m on the 6 N level 3-1 (measured in src/sim; tests/input/servo_sim.test.ts).
//     Option createInputManager({ stopLatch: false }) keeps that literal hold, for comparisons only
//     (dev/input-demo.html ?latch=0); the game always uses the latch.
//   - keyboard in direct-force mode: force 0 while nothing is held (§3.3).
//   - keyboard taps (R10, keyboard.ts): a press from (near) rest moves the hold point by ±5 cm (Shift/Z
//     ±1 cm) from the current hold point (the target, else the trolley x) at once: 'target' frames while
//     the key is held within the tap window, then the hold like any keyboard stop ('idle'). Taps keep
//     counting as "at rest" while the trolley still travels to a tap target, so quick taps add up.
//
// Fragile cargo (R10): setLevel passes the level's speed caps (servo.ts speedCap: 2.0 / 0.5 m/s on egg
// levels) to the keyboard ramp and the gamepad, so their commands never exceed what the servo allows.
//
// Practice rewind (§3.5, D3): the keyboard sends 'rewind' on an R long press while setPractice(true).
// Whoever rewinds (that command or the HUD button), sample() sees the substep counter go backwards
// and re-anchors: the hold point becomes the restored trolley x (latched like a key stop when the
// restored trolley travels at ≥ 0.3 m/s), a clutch drag in progress continues from there, a held key
// keeps driving. Without this the trolley would race back to the pre-rewind target.
import { clampTarget, speedCap } from './servo';
import { KEY_RAMP, KEY_TAP, createKeyboardSource, type KeyboardSource } from './keyboard';
import { createGamepadSource, type GamepadSource } from './gamepad';
import { createPointerSource, type PointerSource } from './pointer';
import type { LevelPhysics } from '../sim/level';
import type { SimState } from '../sim/run';
import type { DeviceTag } from '../sim/replay';
import type { Layout } from '../render/renderer';
import type { Command, InputFrame, InputManager, Intent, RailMapper } from './types';

/** DeviceTag values (§3.3); local so that input only depends on sim types (§10.2). */
const TAG = { Unknown: 0, Touch: 1, Mouse: 2, Keyboard: 3, Gamepad: 4, Mixed: 5 } as const;
/** A target unchanged for this many ticks makes the frame 'idle' (§3.6). */
export const IDLE_AFTER_TICKS = 15;
/**
 * Stop latch after a keyboard / gamepad stop (D1, see the header). The hold point follows the trolley
 * while it still moves in its direction of travel faster than minV (REST_V); maxTicks is only a
 * safety net (3 s: a 6 N trolley needs about 2 s to brake from 4 m/s). After a practice rewind the
 * latch starts only if the restored trolley travels at rewindMinV or more: slower motion is just the
 * swing tugging a held trolley, and following it would drift the hold point away from the restored x.
 */
export const STOP_LATCH = { minV: 0.05, rewindMinV: 0.3, maxTicks: 180 } as const;

type Source = 'none' | 'pointer' | 'keyboard' | 'gamepad';

export interface InputManagerOptions {
  /** Window to listen on (tests). */
  win?: Window;
  /** navigator.getGamepads replacement (tests). */
  getPads?: () => ArrayLike<Gamepad | null>;
  /**
   * The stop latch (D1) is always on in the game. false = hold the literal x of the stop tick (§3.3
   * wording), which springs back on weak plants; for comparisons in tests and the input demo only.
   */
  stopLatch?: boolean;
}

export interface InputDebug {
  active: Source;
  targetX: number | null;
  latching: boolean;
  /** The hold point comes from keyboard taps (R10). */
  tapHold: boolean;
  practice: boolean;
  keyV: number;
  drag: ReturnType<PointerSource['info']>;
  keyboardMode: 'speed' | 'force';
}

/** The InputManager of §10.4 plus a read-only debug view (dev/input-demo.html). */
export interface InputManagerImpl extends InputManager {
  debug(): InputDebug;
}

export function createInputManager(opts: InputManagerOptions = {}): InputManagerImpl {
  const win = opts.win ?? window;
  const latchOn = opts.stopLatch ?? true;
  const cmdCbs: ((c: Command) => void)[] = [];
  const emit = (c: Command): void => {
    for (const cb of cmdCbs) {
      try {
        cb(c);
      } catch (err) {
        console.error(err); // one bad listener must not swallow the other commands
      }
    }
  };

  let phys: LevelPhysics | null = null;
  let targetX: number | null = null;
  let fine = false;
  let lastX = 0;
  let seq = 0, kbSeq = 0, padSeq = 0, ptrSeq = 0;
  let active: Source = 'none';
  let forceHold = false;       // keyboard force mode was last in control: F = 0 when released
  let latchDir = 0, latchTicks = 0;
  let lastSub = -1;            // substep counter of the last sampled state (rewind detection)
  let prevTarget: number | null = null;
  let unchanged = 0;
  let devices = 0;             // bit mask of DeviceTag values used since resetForRun
  let lastKeyV = 0;
  let tapHold = false;         // the hold point was set by keyboard taps (R10): further presses are taps too
  let tapTarget: number | null = null; // the last tap's hold point (a snap returns to it)
  let padArmed = true;         // a stick overridden by another device must return to the dead zone first

  const clampX = (x: number): number => (phys ? clampTarget(x, phys) : x);
  const mark = (d: DeviceTag): void => {
    devices |= 1 << d;
  };
  function deviceTag(): DeviceTag {
    let n = 0, last = 0;
    for (let d = TAG.Touch; d <= TAG.Gamepad; d++) {
      if (devices & (1 << d)) {
        n++;
        last = d;
      }
    }
    return (n === 0 ? TAG.Unknown : n === 1 ? last : TAG.Mixed) as DeviceTag;
  }

  const keyboard: KeyboardSource = createKeyboardSource(win);
  const gamepad: GamepadSource = createGamepadSource(opts.getPads, win);
  const pointer: PointerSource = createPointerSource({
    baseTarget: () => targetX ?? lastX,
    rail: () => phys?.rail ?? null,
    clampTarget: clampX,
    begin(_device, f) {
      ptrSeq = ++seq;
      active = 'pointer';
      fine = f;
      forceHold = false;
      latchDir = 0;
      tapHold = false;
      // The device is tagged on the first real move (setTarget): a touch that never moves drives nothing.
      if (targetX === null) targetX = clampX(lastX); // grabbing never makes the target jump
    },
    setTarget(x, device) {
      if (active !== 'pointer') {
        ptrSeq = ++seq;
        active = 'pointer';
      }
      mark(device);
      targetX = x;
      latchDir = 0;
      tapHold = false;
    },
    command: emit,
  }, win);

  keyboard.onMovePress(() => {
    kbSeq = ++seq;
  });
  keyboard.onCommand(emit);
  gamepad.onMoveStart(() => {
    padSeq = ++seq;
  });
  gamepad.onCommand(emit);

  // Clutch resets and releases the browser does not report as key-ups / pointer-ups.
  const onOrientation = (): void => pointer.endDrag();
  const onBlur = (): void => {
    keyboard.releaseAll();
    pointer.endDrag();
  };
  const doc = win.document;
  const onVisibility = (): void => {
    if (doc.visibilityState === 'hidden') onBlur();
  };
  win.addEventListener('orientationchange', onOrientation);
  const orient = win.screen?.orientation;
  orient?.addEventListener?.('change', onOrientation);
  win.addEventListener('blur', onBlur);
  doc?.addEventListener('visibilitychange', onVisibility);

  /**
   * Holds at the trolley x and starts a latch: the hold point follows the trolley while it keeps
   * moving in direction sign(v). Returns the new target.
   */
  function latchAt(x: number, v: number): number {
    const t = clampX(x);
    targetX = t;
    latchDir = latchOn && Math.abs(v) > STOP_LATCH.minV ? Math.sign(v) : 0;
    latchTicks = 0;
    return t;
  }
  /** One latch tick: follow the trolley while it still moves in the latch direction (else the latch ends). */
  function followLatch(x: number, v: number): void {
    if (latchDir !== 0 && v * latchDir > STOP_LATCH.minV && latchTicks < STOP_LATCH.maxTicks) {
      targetX = clampX(x);
      latchTicks++;
    } else {
      latchDir = 0;
    }
  }
  /** The state was rewound (practice): hold at the restored trolley x instead of the stale target. */
  function rebaseAfterRewind(x: number, v: number): void {
    tapHold = false;
    tapTarget = null;
    if (forceHold) return; // direct force holds nothing (F = 0 when released)
    // A finger still down steers from here (no latch under it); a slow trolley is held at x exactly.
    latchAt(x, pointer.dragging() || Math.abs(v) < STOP_LATCH.rewindMinV ? 0 : v);
    pointer.rebase();
  }

  function sample(s: SimState): InputFrame {
    const x = Number.isFinite(s.x) ? s.x : lastX;
    const v = Number.isFinite(s.v) ? s.v : 0;
    lastX = x;
    const sub = s.substep;
    if (sub < lastSub) rebaseAfterRewind(x, v); // time went backwards without resetForRun: rewound
    if (Number.isFinite(sub)) lastSub = sub;

    // Ticks since the target last changed (pointer events land between ticks).
    if (targetX === prevTarget) unchanged++;
    else {
      unchanged = 0;
      prevTarget = targetX;
    }

    // (Nearly) at rest, or still travelling to a tap target: a fresh key press is a tap candidate (R10).
    const kb = keyboard.tick(phys?.Fmax ?? 0, tapHold || Math.abs(v) < KEY_TAP.restV, v);
    const pad = gamepad.poll();
    lastKeyV = kb.v;
    const kbTap = kb.step !== 0 || kb.stepping; // the keyboard moves / holds the hold point this tick

    let winner: Source = 'none', best = -1;
    if ((kb.engaged || kbTap) && kbSeq > best) { winner = 'keyboard'; best = kbSeq; }
    if (pad.engaged && padArmed && padSeq > best) { winner = 'gamepad'; best = padSeq; }
    if (pointer.dragging() && ptrSeq > best) { winner = 'pointer'; best = ptrSeq; }
    if (active === 'pointer' && winner !== 'pointer' && winner !== 'none') pointer.endDrag();
    // A resting stick that drifts just past the dead zone must not grab control back when the
    // device that overrode it lets go.
    if (!pad.engaged) padArmed = true;
    else if (winner !== 'gamepad') padArmed = false;

    let intent: Intent;
    let frameFine = fine;
    if (winner === 'keyboard' && kbTap) {
      // Key tap (R10): step the hold point from where it is (the target, else the trolley x) and hold it
      // while the tap window is open (the velocity ramp is delayed or the key is already up).
      active = 'keyboard';
      mark(TAG.Keyboard as DeviceTag);
      frameFine = kb.fine;
      forceHold = false;
      latchDir = 0;
      if (kb.step !== 0) {
        tapTarget = clampX((targetX ?? x) + kb.step);
        targetX = tapTarget;
        tapHold = true;
      }
      intent = targetX === null ? { kind: 'idle' } : { kind: 'target', x: targetX };
    } else if (winner === 'keyboard' || winner === 'gamepad') {
      active = winner;
      targetX = null;
      latchDir = 0;
      tapHold = false;
      if (winner === 'keyboard') {
        mark(TAG.Keyboard as DeviceTag);
        frameFine = kb.fine;
        forceHold = keyboard.mode() === 'force';
        intent = forceHold ? { kind: 'force', f: kb.f } : { kind: 'velocity', v: kb.v };
      } else {
        mark(TAG.Gamepad as DeviceTag);
        frameFine = pad.fine;
        forceHold = false;
        intent = { kind: 'velocity', v: pad.v };
      }
    } else if ((active === 'keyboard' || active === 'gamepad') && winner === 'none') {
      frameFine = active === 'keyboard' ? kb.fine : pad.fine;
      if (forceHold) {
        intent = { kind: 'force', f: 0 };
      } else if (kb.snap && active === 'keyboard' && tapTarget !== null) {
        // A tap released just after its ramp had started: the burst is cancelled, back to the tap target.
        targetX = tapTarget;
        tapHold = true;
        latchDir = 0;
        intent = { kind: 'target', x: targetX };
      } else if (targetX === null) {
        // The tick the velocity command reached 0: target the trolley x of this moment (§3.3), then
        // let the hold point follow the trolley until it has braked to rest (stop latch, D1).
        intent = { kind: 'target', x: latchAt(x, v) };
      } else {
        followLatch(x, v);
        intent = { kind: 'idle' }; // key speed command is 0 (§3.6)
      }
    } else {
      // Pointer in control (dragging or not) or nothing used yet: hold the target. A latch here only
      // comes from a rewind (rebaseAfterRewind) and never runs under a finger.
      if (latchDir !== 0) followLatch(x, v);
      intent = targetX === null || unchanged >= IDLE_AFTER_TICKS ? { kind: 'idle' } : { kind: 'target', x: targetX };
    }
    return { intent, fine: frameFine, device: deviceTag(), targetX };
  }

  return {
    attach(scene: HTMLElement, deck: HTMLElement | null, mapper: RailMapper, layout: Layout) {
      pointer.bind(scene, deck, mapper, layout);
    },
    setLevel(p: LevelPhysics) {
      phys = p;
      if (targetX !== null) targetX = clampX(targetX);
      // Fragile cargo (R10): the digital ramps and the stick scale to the level's caps.
      const cap = speedCap(p, false), capFine = speedCap(p, true);
      const keyFine = Math.min(capFine, KEY_RAMP.capFine / KEY_RAMP.perMps);
      keyboard.setCaps(cap, keyFine);
      gamepad.setCaps(cap, capFine, keyFine);
    },
    resetForRun(startX: number) {
      targetX = null;
      prevTarget = null;
      unchanged = 0;
      fine = pointer.info()?.fine ?? false; // a finger still down in the fine band stays fine
      latchDir = 0;
      lastSub = -1;
      forceHold = false;
      tapHold = false;
      tapTarget = null;
      active = 'none';
      devices = 0;
      lastX = startX;
      keyboard.resetRamp();
      pointer.rebase(); // a finger that is still down keeps steering, from the new start
    },
    sample,
    onCommand(cb: (c: Command) => void) {
      cmdCbs.push(cb);
    },
    setKeyboardMode(m: 'speed' | 'force') {
      keyboard.setMode(m);
      if (active === 'keyboard') forceHold = m === 'force';
    },
    setPractice(on: boolean) {
      keyboard.setPractice(!!on);
    },
    dispose() {
      keyboard.dispose();
      gamepad.dispose();
      pointer.dispose();
      win.removeEventListener('orientationchange', onOrientation);
      orient?.removeEventListener?.('change', onOrientation);
      win.removeEventListener('blur', onBlur);
      doc?.removeEventListener('visibilitychange', onVisibility);
      cmdCbs.length = 0;
    },
    debug(): InputDebug {
      return {
        active, targetX, latching: latchDir !== 0, tapHold, practice: keyboard.practice(), keyV: lastKeyV, drag: pointer.info(),
        keyboardMode: keyboard.mode(),
      };
    },
  };
}
