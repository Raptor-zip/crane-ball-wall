// navigator.vibrate wrapper (GAME_DESIGN.md §9.5 "振動" column, §3.5). Owner: O6.
//
// Vibration only happens where navigator.vibrate exists (Android etc.), when enabled in the settings, and
// only after the page has had a user activation (otherwise Chrome blocks the call and logs an intervention).
import type { GameEvent } from '../core/bus';
import { CELEBRATION_DELAY_S } from './sfx';

export interface Haptics { enabled: boolean; fire(pattern: number | number[]): void }

/** What createHaptics returns: the §10.4 contract plus the §9.5 event mapping. */
export interface HapticsExt extends Haptics {
  /** Whether this device can vibrate at all (settings show the toggle only then, §3.5). */
  readonly supported: boolean;
  /** Fires the §9.5 pattern for a game event, if it has one. */
  fx(e: GameEvent): void;
  /** Stops any running pattern. */
  cancel(): void;
}

export interface HapticsOptions {
  enabled?: boolean;
  /** Injected vibrate (tests). Default: navigator.vibrate when present. */
  vibrate?: (pattern: number | number[]) => boolean;
  /** Injected activation check (tests). Default: navigator.userActivation.hasBeenActive when present. */
  activated?: () => boolean;
  /** Clock in ms (tests). Default: performance.now. */
  now?: () => number;
}

/** Gap between the success pulse and the crown pattern, so the crown buzz lands with the fanfare. */
const CROWN_GAP_MS = Math.round(CELEBRATION_DELAY_S * 1000) - 20;

/**
 * StopHit also fires for the slow bumps of a cart resting against an end stop (0.01..0.35 m/s, once per swing;
 * see src/sim/events.ts). Core drops those below 0.1 m/s (D5); the ones above would still buzz once per swing,
 * so only real hits vibrate. ('slack', which D5 adds for a hit that leaves the string slack, has no pattern.)
 */
export const STOP_HAPTIC_MIN_SPEED = 0.5;

/**
 * §9.5: saturation start 6 ms; near miss < 20 mm 8 ms; Snap with J ≥ 0.5 10 ms; StopHit 15 ms (from
 * STOP_HAPTIC_MIN_SPEED); Success 20 ms; first crown [20,30,20,30,60] (played with the fanfare, after the success
 * pulse); Crash [30,40,30].
 */
export function hapticPatternFor(e: GameEvent): number | number[] | null {
  switch (e.t) {
    case 'saturate': return e.on ? 6 : null;
    case 'cross': return e.gapMm < 20 ? 8 : null;
    case 'snap': return e.J >= 0.5 ? 10 : null;
    case 'stop': return e.speed >= STOP_HAPTIC_MIN_SPEED ? 15 : null;
    case 'success': return e.firstCrown ? [20, CROWN_GAP_MS, 20, 30, 20, 30, 60] : 20;
    case 'crash': return [30, 40, 30];
    default: return null;
  }
}

/** Short pulses closer than this are merged (keeps rapid snaps / hits from turning into a continuous buzz). */
const MIN_PULSE_GAP_MS = 45;

export function createHaptics(opts: HapticsOptions = {}): HapticsExt {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  const vibrate =
    opts.vibrate ?? (nav && typeof nav.vibrate === 'function' ? (p: number | number[]) => nav.vibrate(p) : null);
  const activated =
    opts.activated ?? (() => (nav && nav.userActivation ? nav.userActivation.hasBeenActive : true));
  const now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  let last = -Infinity;
  let busyUntil = -Infinity;

  const call = (p: number | number[]): void => {
    if (!vibrate) return;
    try {
      vibrate(p);
    } catch {
      // Some browsers throw on invalid patterns or in iframes; vibration is never essential.
    }
  };

  const h: HapticsExt = {
    enabled: opts.enabled ?? true,
    supported: vibrate !== null,
    fire(pattern: number | number[]): void {
      if (!h.enabled || !vibrate || !activated()) return;
      const t = now();
      if (typeof pattern === 'number') {
        if (!(pattern > 0)) return;
        // Do not cut a running multi-pulse pattern with a tiny pulse, and do not machine-gun tiny pulses.
        if (t < busyUntil || t - last < MIN_PULSE_GAP_MS) return;
        last = t;
        call(Math.round(pattern));
        return;
      }
      const p = pattern.map((x) => Math.max(0, Math.round(x)));
      if (p.length === 0) return;
      last = t;
      busyUntil = t + p.reduce((a, b) => a + b, 0);
      call(p);
    },
    fx(e: GameEvent): void {
      if (e.t === 'retry' || e.t === 'ready' || e.t === 'levelLoaded') {
        if (now() < busyUntil) h.cancel();
        return;
      }
      const p = hapticPatternFor(e);
      if (p !== null) h.fire(p);
    },
    cancel(): void {
      busyUntil = -Infinity;
      if (vibrate && activated()) call(0);
    },
  };
  return h;
}
