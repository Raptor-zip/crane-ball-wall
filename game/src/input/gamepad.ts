// Gamepad API: left stick X -> velocity, buttons -> commands (GAME_DESIGN.md §3.3). Owner: O4.
//
// v_cmd = cap * sign(a) * ((|a| - 0.10) / 0.90)^1.6 with cap 4.0 m/s (LB held: fine, cap 1.0 m/s,
// so the whole stick travel is available for the slow speed). The D-pad left/right is digital, so it
// uses the keyboard ramp (0.4 up / 0.8 down per tick, fine 0.2 up to 0.5 m/s, keyboard.ts) instead of
// jumping to full speed; the stick wins while it is outside the dead zone. Egg levels (R10) lower the
// caps (setCaps from the manager: stick 2.0 / LB 0.5, D-pad 2.0 / 0.5), so the stick keeps its whole travel.
// Buttons (standard mapping): A confirm, B back, Y ghostCycle, Start pause, Back/View retry, LB fine.
// Button presses are polled from sample() and, while a pad is connected, from requestAnimationFrame so
// menus (where the game does not tick) still get them. No allocation per poll.
import { SERVO } from './servo';
import { KEY_RAMP, SpeedRamp } from './keyboard';
import type { Command } from './types';

export const PAD = { deadZone: 0.10, curve: 1.6 } as const;
/** Standard-mapping button indices. */
export const PAD_BTN = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9, LEFT: 14, RIGHT: 15 } as const;
const BUTTON_CMD: ReadonlyArray<readonly [number, Command]> = [
  [PAD_BTN.A, 'confirm'],
  [PAD_BTN.B, 'back'],
  [PAD_BTN.Y, 'ghostCycle'],
  [PAD_BTN.START, 'pause'],
  [PAD_BTN.BACK, 'retry'],
];

/** §3.3 stick curve: dead zone 0.10, exponent 1.6, scaled to cap (4.0 m/s, fine 1.0). */
export function stickToVelocity(a: number, cap: number = SERVO.vCap): number {
  if (!Number.isFinite(a)) return 0;
  const m = Math.min(1, Math.abs(a));
  if (m <= PAD.deadZone) return 0;
  return Math.sign(a) * cap * Math.pow((m - PAD.deadZone) / (1 - PAD.deadZone), PAD.curve);
}

export interface GamepadTick {
  /** Stick outside the dead zone, D-pad held, or the D-pad ramp still braking. */
  engaged: boolean;
  /** Velocity command [m/s]. */
  v: number;
  /** LB held. */
  fine: boolean;
}

export interface GamepadSource {
  /** Read the stick and buttons once (call once per 60 Hz tick). The returned object is reused. */
  poll(): GamepadTick;
  onCommand(cb: (c: Command) => void): void;
  /** Movement started on the pad (stick left the dead zone): the pad takes control. */
  onMoveStart(cb: () => void): void;
  /**
   * Speed caps [m/s]: full stick deflection = cap (LB: stickFine); the D-pad ramp goes to cap (LB: dpadFine).
   * Defaults 4.0 / 1.0 / 0.5; egg levels 2.0 / 0.5 / 0.5.
   */
  setCaps(cap: number, stickFine: number, dpadFine: number): void;
  dispose(): void;
}

type PadList = ArrayLike<Gamepad | null>;

function defaultPads(): PadList {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  if (!nav || typeof nav.getGamepads !== 'function') return [];
  try {
    return nav.getGamepads() ?? [];
  } catch {
    return []; // blocked by a permissions policy
  }
}

const pressed = (b: GamepadButton | undefined): boolean => !!b && (b.pressed || b.value > 0.5);

export function createGamepadSource(getPads: () => PadList = defaultPads, win: Window | null = typeof window !== 'undefined' ? window : null): GamepadSource {
  const cmdCbs: ((c: Command) => void)[] = [];
  const moveCbs: (() => void)[] = [];
  const prevButtons = new Map<number, boolean[]>(); // per pad index, reused (no allocation per poll)
  const dpad = new SpeedRamp();
  const out: GamepadTick = { engaged: false, v: 0, fine: false };
  let wasEngaged = false;
  let capStick: number = SERVO.vCap, capStickFine: number = SERVO.vCapFine;
  let raf = 0;
  let disposed = false;

  const emit = (c: Command): void => {
    for (const cb of cmdCbs) cb(c);
  };

  function pollButtons(pads: PadList): void {
    for (let i = 0; i < pads.length; i++) {
      const p = pads[i];
      if (!p || !p.connected) continue;
      let prev = prevButtons.get(p.index);
      if (!prev) prevButtons.set(p.index, (prev = []));
      let anyEdge = false;
      const n = p.buttons.length;
      for (let b = 0; b < n; b++) {
        const now = pressed(p.buttons[b]);
        if (now && !prev[b]) {
          anyEdge = true;
          for (const [idx, cmd] of BUTTON_CMD) if (idx === b) emit(cmd);
        }
        prev[b] = now;
      }
      prev.length = n;
      if (anyEdge) emit('any');
    }
  }

  function frame(): void {
    raf = 0;
    if (disposed) return;
    const pads = getPads();
    pollButtons(pads);
    let any = false;
    for (let i = 0; i < pads.length; i++) if (pads[i]?.connected) any = true;
    if (any && win) raf = win.requestAnimationFrame(frame);
  }
  const startRaf = (): void => {
    if (!raf && !disposed && win && typeof win.requestAnimationFrame === 'function') raf = win.requestAnimationFrame(frame);
  };
  const onConnected = (): void => startRaf();
  win?.addEventListener('gamepadconnected', onConnected);

  return {
    poll(): GamepadTick {
      const pads = getPads();
      pollButtons(pads);
      let a = 0, dir = 0, fine = false, connected = false;
      for (let i = 0; i < pads.length; i++) {
        const p = pads[i];
        if (!p || !p.connected) continue;
        connected = true;
        const ax = p.axes.length > 0 ? p.axes[0] : 0;
        if (Math.abs(ax) > Math.abs(a)) a = ax;
        const l = pressed(p.buttons[PAD_BTN.LEFT]), r = pressed(p.buttons[PAD_BTN.RIGHT]);
        if (l !== r && dir === 0) dir = l ? -1 : 1;
        if (pressed(p.buttons[PAD_BTN.LB])) fine = true;
      }
      if (connected) startRaf();
      const cap = fine ? capStickFine : capStick;
      let v: number;
      let engaged: boolean;
      if (Math.abs(a) > PAD.deadZone) {
        dpad.reset(); // the stick takes over from the D-pad at once
        v = stickToVelocity(a, cap);
        engaged = v !== 0;
      } else {
        v = dpad.step(dir as -1 | 0 | 1, fine);
        engaged = dir !== 0 || dpad.u !== 0;
      }
      if (engaged && !wasEngaged) for (const cb of moveCbs) cb();
      wasEngaged = engaged;
      out.engaged = engaged;
      out.v = v;
      out.fine = fine;
      return out;
    },
    onCommand(cb) {
      cmdCbs.push(cb);
    },
    onMoveStart(cb) {
      moveCbs.push(cb);
    },
    setCaps(cap, stickFine, dpadFine) {
      const ok = (x: number, dflt: number): number => (Number.isFinite(x) && x >= 0 ? x : dflt);
      capStick = ok(cap, SERVO.vCap);
      capStickFine = ok(stickFine, SERVO.vCapFine);
      dpad.setCaps(capStick, ok(dpadFine, KEY_RAMP.capFine / KEY_RAMP.perMps));
    },
    dispose() {
      disposed = true;
      if (raf && win) win.cancelAnimationFrame(raf);
      raf = 0;
      win?.removeEventListener('gamepadconnected', onConnected);
      cmdCbs.length = 0;
      moveCbs.length = 0;
      prevButtons.clear();
    },
  };
}
