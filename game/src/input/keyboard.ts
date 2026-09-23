// Keyboard velocity ramp, key taps, direct force and command keys (GAME_DESIGN.md §3.3, Appendix A, R10). Owner: O4.
//
// Speed mode (default): ←/→ or A/D ramp the velocity command towards ±4.0 m/s by 0.2 m/s per tick
// (20 ticks = 0.33 s to full speed; was 0.4 m/s per tick, too twitchy to calm a swing with); releasing (or the opposite key) ramps it back to 0 by 0.8 m/s per tick
// (5 ticks, dead-man brake). Shift or Z: fine, cap 0.5 m/s (R10; was 1.0), ramp up 0.2 m/s per tick.
// Egg levels lower the full-speed cap to 2.0 m/s (setCaps from the manager, servo.ts FRAGILE).
// The ramp runs in integer units of 0.1 m/s so the tick counts are exact (no float drift).
// Holding the position after the stop is the manager's job (manager.ts: from the tick the ramp hits 0
// the hold point follows the braking trolley and stays where it comes to rest, D1).
//
// Key taps (R10, keyboard parity with the deck's fine positioning): a movement key released within
// KEY_TAP.maxTicks ticks (150 ms) with no other movement key moves the hold point by ±5 cm (Shift/Z: ±1 cm)
// instead of a velocity burst. When the trolley is (nearly) at rest, a fresh press opens a tap window:
// the step is reported on the first tick (the manager moves the hold point at once, so the trolley starts
// moving without any added latency) and the velocity ramp waits KEY_TAP.windowTicks ticks (117 ms).
// Still held after that, the ramp starts from the trolley's current speed (no brake before it); released
// within maxTicks after all, the 1-2 tick burst is cancelled (snap) and the hold point stays the step target.
// A press while the trolley moves (braking, dragged, swung hard) ramps at once exactly as before.
//
// Force mode: ←/→ = ±Fmax, with Shift/Z ±0.25 Fmax, 0 when nothing is held (no taps).
// Practice mode (setPractice(true), §3.5, D3): R is timed instead of firing on key-down. Held for
// REWIND_KEY.holdMs it sends 'rewind' (then again every repeatMs); released earlier it sends 'retry'
// on key-up. Wall-clock timers, so the long press works at ×0.5 and while the sim is not ticking.
import type { Command } from './types';

/** Ramp constants in units of 0.1 m/s (Appendix A: 0.2 / 0.8 / 0.2 m/s per tick (up was 0.4 before the playtest); caps 4.0 / 0.5, fine lowered by R10). */
export const KEY_RAMP = { up: 2, down: 8, upFine: 2, cap: 40, capFine: 5, perMps: 10 } as const;
/**
 * Key taps (R10, see the header):
 * - stepM / stepFineM: hold-point step of a tap [m] (Shift/Z held at the press: fine).
 * - windowTicks: ramp delay of a press from rest (7 ticks = 117 ms, within the 120 ms latency budget).
 * - maxTicks: a press that at most this many ticks saw (9 = 150 ms) is a tap.
 * - restV: |trolley v| below this counts as (nearly) at rest [m/s]; a held trolley tugged by a 45° swing
 *   moves at about 0.16 m/s, so taps still work while the ball settles.
 * - staleMs: a tap no tick saw (down and up between two ticks) is dropped if the next tick comes later
 *   than this after the key-up (keys pressed in a pause menu must not move the trolley on resume).
 */
export const KEY_TAP = { stepM: 0.05, stepFineM: 0.01, windowTicks: 7, maxTicks: 9, restV: 0.3, staleMs: 100 } as const;
/** Direct force mode: Shift/Z scales the force to this fraction of Fmax. */
export const KEY_FORCE_FINE = 0.25;
/** Practice-mode R long press (D3): first 'rewind' after holdMs, then one every repeatMs while held. */
export const REWIND_KEY = { holdMs: 300, repeatMs: 300 } as const;

/** The velocity ramp of §3.3 as a pure state machine (one step per 60 Hz tick). */
export class SpeedRamp {
  /** Current command in units of 0.1 m/s (integer). */
  u = 0;
  /** Caps in units of 0.1 m/s (setCaps; egg levels lower the full-speed cap). */
  cap: number = KEY_RAMP.cap;
  capFine: number = KEY_RAMP.capFine;

  get v(): number {
    return this.u / KEY_RAMP.perMps; // exact decimal (e.g. 1.2, not 1.2000000000000002)
  }

  /** Advance one tick towards dir * cap. Returns the new command in m/s. */
  step(dir: -1 | 0 | 1, fine: boolean): number {
    const want = dir * (fine ? this.capFine : this.cap);
    const u = this.u;
    if (u === want) return this.v;
    if (u !== 0 && (want === 0 || Math.sign(want) !== Math.sign(u))) {
      // Braking towards 0 (release or the opposite key): stop at 0 this tick.
      const d = Math.min(Math.abs(u), KEY_RAMP.down);
      this.u = u - Math.sign(u) * d;
    } else if (Math.abs(want) > Math.abs(u)) {
      // Accelerating (same sign or from rest).
      const d = Math.min(Math.abs(want - u), fine ? KEY_RAMP.upFine : KEY_RAMP.up);
      this.u = u + Math.sign(want) * d;
    } else {
      // Same sign but above the (fine) cap: come down at the brake rate.
      const d = Math.min(Math.abs(u - want), KEY_RAMP.down);
      this.u = u - Math.sign(u) * d;
    }
    return this.v;
  }

  /**
   * Continue from the trolley's speed v in direction dir (floored to 0.1 m/s, 0 when it moves the other
   * way, at most the cap): a ramp that starts under a moving trolley does not brake it first.
   */
  seed(dir: -1 | 0 | 1, v: number, fine: boolean): void {
    if (dir === 0 || !Number.isFinite(v)) return;
    const n = Math.floor(dir * v * KEY_RAMP.perMps + 1e-9);
    this.u = n > 0 ? dir * Math.min(fine ? this.capFine : this.cap, n) : 0;
  }

  /** Speed caps in m/s (whole 0.1 m/s units). A command above a lowered cap comes down at the brake rate. */
  setCaps(cap: number, capFine: number): void {
    const units = (mps: number, dflt: number): number => (Number.isFinite(mps) && mps >= 0 ? Math.round(mps * KEY_RAMP.perMps) : dflt);
    this.cap = units(cap, KEY_RAMP.cap);
    this.capFine = Math.min(this.cap, units(capFine, KEY_RAMP.capFine));
  }

  reset(): void {
    this.u = 0;
  }
}

export interface KeyboardTick {
  /** A movement key is held, or (speed mode) the ramp has not reached 0 yet. */
  engaged: boolean;
  /** Speed mode velocity command [m/s]. */
  v: number;
  /** Force mode force [N]. */
  f: number;
  /** Shift or Z held. */
  fine: boolean;
  /** Speed mode: hold-point step [m] of a tap to apply on this tick (±KEY_TAP.stepM or stepFineM), else 0. */
  step: number;
  /** Speed mode: the tap window is open (key held, ramp delayed, v = 0): hold the stepped target. */
  stepping: boolean;
  /** Speed mode: a tap released just after its ramp had started: the burst was cancelled, hold the step target. */
  snap: boolean;
}

export interface KeyboardSource {
  /**
   * Advance one 60 Hz tick (ramps, taps) and report the state (a reused object). Fmax is used by the force
   * mode. rest: the trolley is (nearly) at rest, so a fresh press opens a tap window (default false: no
   * taps); v: the trolley velocity, where a delayed ramp starts from.
   */
  tick(Fmax: number, rest?: boolean, v?: number): KeyboardTick;
  /** Direction currently held (-1 / 0 / +1, most recently pressed key wins). */
  dir(): -1 | 0 | 1;
  fineHeld(): boolean;
  mode(): 'speed' | 'force';
  setMode(m: 'speed' | 'force'): void;
  /** Speed-mode caps in m/s (default 4.0 / 0.5; egg levels 2.0 / 0.5). */
  setCaps(cap: number, capFine: number): void;
  /**
   * Ramp back to 0 and forget taps (new run). Held keys stay held, so a held arrow starts the next run at
   * once (a press no tick has seen yet still opens its tap window in the new run).
   */
  resetRamp(): void;
  /** Forget every held key (window blur, tab hidden). A timed practice R press is dropped (no command). */
  releaseAll(): void;
  /** Practice mode: R long press = 'rewind', short press = 'retry' on key-up. Off cancels a timed R press. */
  setPractice(on: boolean): void;
  practice(): boolean;
  /** Movement key pressed (fresh press): used by the manager to decide which device is in control. */
  onMovePress(cb: () => void): void;
  onCommand(cb: (c: Command) => void): void;
  dispose(): void;
}

/** Tap states: none, pressed (no tick saw it yet), window (step applied, ramp delayed), ramping (can still snap). */
const TAP_NONE = 0, TAP_NEW = 1, TAP_WINDOW = 2, TAP_RAMP = 3;

const LEFT = new Set(['ArrowLeft', 'KeyA']);
const RIGHT = new Set(['ArrowRight', 'KeyD']);
const NO_ANY = new Set([
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight',
  'CapsLock', 'Tab', 'ContextMenu', 'NumLock', 'ScrollLock', 'Fn', 'FnLock', 'OSLeft', 'OSRight',
]);

/** Physical key id: e.code, or something equivalent derived from e.key when code is missing. */
export function keyCode(e: KeyboardEvent): string {
  if (e.code && e.code !== 'Unidentified') return e.code;
  const k = e.key ?? '';
  if (k.length === 1) {
    if (/[a-z]/i.test(k)) return 'Key' + k.toUpperCase();
    if (k === ' ') return 'Space';
    if (k === '/' || k === '?') return 'Slash';
    return k;
  }
  return k === 'Esc' ? 'Escape' : k === 'Left' ? 'ArrowLeft' : k === 'Right' ? 'ArrowRight' : k;
}

/**
 * Letter meaning of the key (layout aware). Falls back to the physical key only when the layout gives
 * no Latin letter for it: under an IME (key 'Process'), for an unidentified key, or on a non-Latin
 * layout (e.g. Cyrillic 'к' on KeyR). Punctuation and digits never fall back, so the AZERTY ',' key
 * (physical KeyM) is not 'mute'.
 */
function letter(e: KeyboardEvent): string {
  const k = e.key ?? '';
  if (k.length === 1 && /[a-z]/i.test(k)) return k.toLowerCase();
  if (!(k === 'Process' || k === 'Unidentified' || k === '' || (k.length === 1 && /\p{L}/u.test(k)))) return '';
  const c = keyCode(e);
  return c.startsWith('Key') && c.length === 4 ? c.slice(3).toLowerCase() : '';
}

/** Movement direction of a key: arrows (also the numpad arrows with NumLock off) and A / D (physical). */
function moveDir(e: KeyboardEvent, c: string): -1 | 0 | 1 {
  if (LEFT.has(c) || e.key === 'ArrowLeft' || e.key === 'Left') return -1;
  if (RIGHT.has(c) || e.key === 'ArrowRight' || e.key === 'Right') return 1;
  return 0;
}

/** The §3.3 command of a key press, or null. */
export function commandOfKey(e: KeyboardEvent): Command | null {
  const c = keyCode(e);
  if (c === 'Backspace') return 'retry';
  if (c === 'Enter' || c === 'NumpadEnter' || c === 'Space') return 'confirm';
  if (c === 'Escape') return 'pause';
  if (c === 'F1' || e.key === '?' || (c === 'Slash' && e.shiftKey)) return 'notes';
  switch (letter(e)) {
    case 'r': return 'retry';
    case 'n': return 'next';
    case 'p': return 'pause';
    case 'g': return 'ghostCycle';
    case 'h': return 'aiLine';
    case 'm': return 'mute';
    default: return null;
  }
}

function isFineKey(e: KeyboardEvent): boolean {
  const c = keyCode(e);
  return c === 'ShiftLeft' || c === 'ShiftRight' || c === 'Shift' || letter(e) === 'z';
}

function elementOf(t: EventTarget | null): Element | null {
  return t && typeof (t as Element).closest === 'function' ? (t as Element) : null;
}

/** Typing into a form field: the game ignores the key entirely. */
function isEditable(t: EventTarget | null): boolean {
  const el = elementOf(t);
  if (!el) return false;
  return !!el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
}

/** Enter / Space on a focused control is the browser's (it clicks it). */
function isClickable(t: EventTarget | null): boolean {
  const el = elementOf(t);
  return !!el && !!el.closest('button, a[href], summary, [role="button"], [role="menuitem"], [role="tab"], [role="link"]');
}

/**
 * Is the key's target inside a UI region that can actually scroll on this axis (a long notes page, a
 * horizontal level pager)? Then Space / ←→ keep their scrolling default (§3.5: menus fully keyboard
 * operable). The game view itself never scrolls (overflow hidden), so in play nothing changes.
 */
function inScrollable(t: EventTarget | null, axis: 'x' | 'y'): boolean {
  let el = elementOf(t);
  const doc = el?.ownerDocument;
  const view = doc?.defaultView;
  if (!doc || !view) return false;
  while (el && el !== doc.body && el !== doc.documentElement) {
    const over = axis === 'y' ? el.scrollHeight > el.clientHeight + 1 : el.scrollWidth > el.clientWidth + 1;
    if (over) {
      const cs = view.getComputedStyle(el);
      const o = axis === 'y' ? cs.overflowY : cs.overflowX;
      if (o === 'auto' || o === 'scroll') return true;
    }
    el = el.parentElement;
  }
  return false;
}

export function createKeyboardSource(win: Window = window): KeyboardSource {
  const ramp = new SpeedRamp();
  let mode: 'speed' | 'force' = 'speed';
  let left = false, right = false;
  let lastDir: -1 | 0 | 1 = 0;
  let shift = false, zKey = false;
  let practice = false;
  let rCode: string | null = null;  // physical key of the practice R press being timed
  let rLong = false;                // that press has sent 'rewind' (it will never send 'retry')
  let rTimer: number | null = null;
  // Tap tracking (R10, see the header). Only the press that started with no movement key held can be a tap.
  let tap = TAP_NONE;
  let tapDir: -1 | 1 = 1;
  let tapFine = false;              // Shift / Z held at the press: a 1 cm step
  let tapTicks = 0;                 // ticks that saw this press
  let lateStep = 0;                 // taps no tick saw (down and up between two ticks): applied on the next tick
  let lateAt = 0;                   // wall clock of the last such key-up
  let snapNext = false;             // a tap released after its ramp started: cancel the burst on the next tick
  let seedNext = false;             // a tap window broken by another key: that ramp starts from the trolley speed
  const moveCbs: (() => void)[] = [];
  const cmdCbs: ((c: Command) => void)[] = [];

  const emit = (c: Command): void => {
    for (const cb of cmdCbs) cb(c);
  };

  function cancelR(): void {
    if (rTimer !== null) win.clearTimeout(rTimer);
    rTimer = null;
    rCode = null;
    rLong = false;
  }
  function beginR(code: string): void {
    cancelR(); // a previous press whose key-up was lost
    rCode = code;
    rTimer = win.setTimeout(fireRewind, REWIND_KEY.holdMs);
  }
  function fireRewind(): void {
    rTimer = null;
    if (rCode === null) return;
    const first = !rLong;
    rLong = true;
    emit('rewind');
    if (first) emit('any');
    // A listener may have left practice or disposed us: only re-arm while the press is still ours.
    if (rCode !== null && rTimer === null) rTimer = win.setTimeout(fireRewind, REWIND_KEY.repeatMs);
  }
  const dir = (): -1 | 0 | 1 => (left && right ? lastDir : left ? -1 : right ? 1 : 0);
  const fineHeld = (): boolean => shift || zKey;
  const now = (): number => {
    const perf = win.performance;
    return perf && typeof perf.now === 'function' ? perf.now() : Date.now();
  };
  const tapSize = (fine: boolean): number => (fine ? KEY_TAP.stepFineM : KEY_TAP.stepM);

  function clearTaps(): void {
    tap = TAP_NONE;
    lateStep = 0;
    snapNext = seedNext = false;
  }
  /** A fresh movement key press (speed mode). anyHeld: a movement key was already down. */
  function notePress(d: -1 | 1, anyHeld: boolean): void {
    if (tap === TAP_WINDOW) seedNext = true;
    if (anyHeld) {
      tap = TAP_NONE; // another movement key is involved: neither press is a tap
      return;
    }
    tap = TAP_NEW;
    tapDir = d;
    tapFine = fineHeld();
    tapTicks = 0;
  }
  /** The key of the tracked press went up. */
  function noteRelease(): void {
    if (tapTicks <= KEY_TAP.maxTicks) {
      if (tap === TAP_NEW) {
        lateStep += tapDir * tapSize(tapFine);
        lateAt = now();
      } else if (tap === TAP_RAMP) {
        snapNext = true;
      } // TAP_WINDOW: the step is already applied and the manager keeps holding it
    }
    tap = TAP_NONE;
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    if (isEditable(e.target)) return;
    shift = !!e.shiftKey;
    if (e.ctrlKey || e.metaKey || e.altKey) return; // browser shortcuts (Ctrl+R reload etc.)
    const c = keyCode(e);
    if (isFineKey(e)) {
      if (c.startsWith('Shift')) shift = true;
      else zKey = true;
      if (!e.repeat) emitAnyFor(e, c);
      return;
    }
    const d = moveDir(e, c);
    if (d !== 0) {
      if (!inScrollable(e.target, 'x')) e.preventDefault();
      if (e.repeat) return;
      const anyHeld = left || right;
      if (d < 0) left = true;
      else right = true;
      lastDir = d;
      if (mode === 'speed') notePress(d, anyHeld);
      for (const cb of moveCbs) cb();
      emit('any');
      return;
    }
    const cmd = commandOfKey(e);
    if (cmd === 'confirm' && isClickable(e.target)) return;
    if (cmd) {
      // Space scroll, Backspace history, F1 help, '/' quick find (Escape keeps exiting fullscreen).
      if (cmd !== 'pause' && !(c === 'Space' && inScrollable(e.target, 'y'))) e.preventDefault();
      if (e.repeat) return;
      if (cmd === 'retry' && practice && c !== 'Backspace') {
        beginR(c); // R in practice: 'retry' on a short key-up, 'rewind' when held (D3)
        return;
      }
      emit(cmd);
      emit('any');
      return;
    }
    if (!e.repeat) emitAnyFor(e, c);
  };

  function emitAnyFor(e: KeyboardEvent, c: string): void {
    if (NO_ANY.has(c) || c === 'Shift' || c === 'Control' || c === 'Alt' || c === 'Meta') return;
    if (/^F\d+$/.test(c) || c.startsWith('Audio') || c.startsWith('Media') || c.startsWith('Browser')) return;
    if (c === 'Unidentified' || c === '' || e.key === 'Dead') return;
    emit('any');
  }

  const onKeyUp = (e: KeyboardEvent): void => {
    const c = keyCode(e);
    if (rCode !== null && c === rCode) {
      const short = !rLong;
      cancelR();
      if (short) {
        emit('retry');
        emit('any');
      }
    }
    shift = c.startsWith('Shift') ? false : !!e.shiftKey;
    if (letter(e) === 'z' || c === 'KeyZ') zKey = false;
    const d = moveDir(e, c);
    if (d !== 0 && tap !== TAP_NONE && d === tapDir) noteRelease();
    if (d < 0) {
      left = false;
      if (right) lastDir = 1;
    } else if (d > 0) {
      right = false;
      if (left) lastDir = -1;
    }
  };

  const releaseAll = (): void => {
    left = right = shift = zKey = false;
    lastDir = 0;
    clearTaps();
    cancelR();
  };
  const onBlur = (): void => releaseAll();

  win.addEventListener('keydown', onKeyDown);
  win.addEventListener('keyup', onKeyUp);
  win.addEventListener('blur', onBlur);

  // reused: no allocation per tick
  const out: KeyboardTick = { engaged: false, v: 0, f: 0, fine: false, step: 0, stepping: false, snap: false };
  return {
    tick(Fmax: number, rest = false, v = 0): KeyboardTick {
      const d = dir();
      const fine = fineHeld();
      out.fine = fine;
      out.step = 0;
      out.stepping = false;
      out.snap = false;
      if (mode === 'force') {
        ramp.reset();
        clearTaps();
        out.engaged = d !== 0;
        out.v = 0;
        out.f = d === 0 ? 0 : d * (fine ? KEY_FORCE_FINE : 1) * Fmax;
        return out;
      }
      const vNow = Number.isFinite(v) ? v : 0;
      if (lateStep !== 0) {
        if (rest && ramp.u === 0 && now() - lateAt <= KEY_TAP.staleMs) out.step = lateStep;
        lateStep = 0;
      }
      if (snapNext) {
        snapNext = false;
        ramp.reset();
        out.snap = true;
      }
      if (seedNext) {
        seedNext = false;
        if (ramp.u === 0) ramp.seed(d, vNow, fine);
      }
      if (tap !== TAP_NONE) {
        tapTicks++;
        if (tap === TAP_NEW) {
          if (rest && ramp.u === 0) {
            tap = TAP_WINDOW;
            out.step += tapDir * tapSize(tapFine);
          } else {
            tap = TAP_NONE; // pressed while the trolley moves: a plain velocity press (a short one is a burst)
          }
        }
        if (tap === TAP_WINDOW && tapTicks > KEY_TAP.windowTicks) {
          tap = TAP_RAMP; // still held: the ramp starts now, from the trolley speed
          ramp.seed(tapDir, vNow, fine);
        }
        if (tap === TAP_RAMP && tapTicks > KEY_TAP.maxTicks) tap = TAP_NONE; // a hold, no longer a tap
      }
      out.stepping = tap === TAP_WINDOW;
      out.v = out.stepping ? 0 : ramp.step(d, fine);
      out.engaged = d !== 0 || ramp.u !== 0;
      out.f = 0;
      return out;
    },
    dir,
    fineHeld,
    mode: () => mode,
    setMode(m) {
      mode = m;
      ramp.reset();
      clearTaps();
    },
    setCaps(cap, capFine) {
      ramp.setCaps(cap, capFine);
    },
    resetRamp() {
      ramp.reset();
      lateStep = 0;
      snapNext = seedNext = false;
      // A window or ramp of the old run: the key counts as held (the next run ramps at once).
      if (tap !== TAP_NEW) tap = TAP_NONE;
    },
    releaseAll,
    setPractice(on) {
      practice = on;
      if (!on) cancelR();
    },
    practice: () => practice,
    onMovePress(cb) {
      moveCbs.push(cb);
    },
    onCommand(cb) {
      cmdCbs.push(cb);
    },
    dispose() {
      win.removeEventListener('keydown', onKeyDown);
      win.removeEventListener('keyup', onKeyUp);
      win.removeEventListener('blur', onBlur);
      moveCbs.length = 0;
      cmdCbs.length = 0;
      releaseAll();
    },
  };
}
