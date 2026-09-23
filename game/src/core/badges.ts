// Badges and trick toasts from sim events (GAME_DESIGN.md §7.3). Owner: O3.
// Display-side code: may use Math.acos / cos (never feeds back into the simulation).
import type { BadgeId } from './bus';
import type { LevelDef } from '../sim/level';
import { Ev, type SimEvents } from '../sim/events';
import { Mode, type SimState } from '../sim/run';
import { BALL_R, G } from '../sim/constants';

export type TrickId = 'brakeFling' | 'windUp' | 'resonancePump' | 'chaseDamp' | 'endSlam' | 'snap';
export const TRICK_IDS: readonly TrickId[] = ['brakeFling', 'windUp', 'resonancePump', 'chaseDamp', 'endSlam', 'snap'];

export interface BadgeTracker {
  /** Tricks detected this tick (each at most once per run). The array is reused: read it before the next call. */
  onTick(s: SimState, ev: SimEvents): readonly TrickId[];
  /** Badges earned by a successful run; firstAttempt = this was the first counted attempt on the level (一発). */
  badgesOnSuccess(s: SimState, firstAttempt: boolean): BadgeId[];
  reset(): void;
}

// Thresholds (§7.3)
export const KAMIHITOE_GAP_M = 0.005;
export const HASHIDON_SPEED = 1.5;
export const PASHI_J = 1.0;
export const BURANKO_RISES = 3;
export const BURANKO_DEG = 20;
export const BRAKE_WINDOW_TICKS = 36;   // 0.6 s
export const BRAKE_DROP = 1.5;          // m/s
export const WINDUP_BACK = 0.2;         // m
export const CHASE_LOOKBACK_TICKS = 90; // 1.5 s
export const CHASE_AMP_DEG = 15;        // lead decision D6 (the spec's 8 deg fired on ordinary settles)
export const CHASE_MOVE = 0.02;         // m
const RING = 128;                        // > CHASE_LOOKBACK_TICKS

const RAD = 180 / Math.PI;

/** Swing amplitude from the pendulum energy: acos(clamp(cos th - L w^2 / (2g), -1, 1)) in degrees (HUD meter, §9.3). */
export function amplitudeDeg(th: number, w: number, L: number): number {
  const c = Math.cos(th) - (L * w * w) / (2 * G);
  return Math.acos(Math.max(-1, Math.min(1, c))) * RAD;
}

export function createBadgeTracker(level: LevelDef): BadgeTracker {
  const L = level.physics.L;
  const startX = level.physics.startX;
  const gentleN = level.badges?.gentleN ?? null;

  const rx = new Float64Array(RING);
  const rv = new Float64Array(RING);
  const ra = new Float64Array(RING);
  let n = 0;                    // ticks pushed
  let lastAmp = 0;
  let minX = startX;
  let firstForwardSeen = false;
  let apexLast = -1;
  let apexRises = 0;
  let stopFast = false;
  let snapBig = false;
  let pumped = false;
  const found = new Set<TrickId>();

  const at = (back: number): number => (n - 1 - back + RING * 4) % RING; // index of the sample `back` ticks ago

  const tricks: TrickId[] = [];
  const found1 = (t: TrickId): void => {
    if (!found.has(t)) {
      found.add(t);
      tricks.push(t);
    }
  };

  const maxSpeedDrop = (window: number): number => {
    const len = Math.min(window + 1, n);
    let runMax = 0;
    let drop = 0;
    for (let back = len - 1; back >= 0; back--) {
      const sp = Math.abs(rv[at(back)]!);
      if (sp > runMax) runMax = sp;
      else if (runMax - sp > drop) drop = runMax - sp;
    }
    return drop;
  };

  /**
   * 追いかけ減衰 (§7.3, D6): within the 1.5 s before HoldBegin the swing was >= 15 deg at some sample, and the
   * trolley moved >= 2 cm between that sample and the hold (it chased the ball to kill the swing).
   * The earliest qualifying sample of the window is used: it gives the widest movement window.
   */
  const chaseDamped = (): boolean => {
    const len = Math.min(CHASE_LOOKBACK_TICKS + 1, n);
    let from = -1;
    for (let back = len - 1; back >= 0; back--) {
      if (ra[at(back)]! >= CHASE_AMP_DEG) {
        from = back;
        break;
      }
    }
    if (from < 0) return false;
    let lo = Infinity;
    let hi = -Infinity;
    for (let back = 0; back <= from; back++) {
      const x = rx[at(back)]!;
      if (x < lo) lo = x;
      if (x > hi) hi = x;
    }
    return hi - lo >= CHASE_MOVE;
  };

  return {
    onTick(s, ev) {
      tricks.length = 0;
      if (s.mode === Mode.Taut) lastAmp = amplitudeDeg(s.th, s.w, L);
      const i = n % RING;
      rx[i] = s.x;
      rv[i] = s.v;
      ra[i] = lastAmp;
      n++;

      for (let k = 0; k < ev.n; k++) {
        const kind = ev.kind[k]!;
        const a = ev.a[k]!;
        const b = ev.b[k]!;
        const c = ev.c[k]!;
        if (kind === Ev.WallCross && b === 1) {
          if (maxSpeedDrop(BRAKE_WINDOW_TICKS) >= BRAKE_DROP) found1('brakeFling');
          if (!firstForwardSeen) {
            firstForwardSeen = true;
            if (minX <= startX - WINDUP_BACK) found1('windUp');
          }
        } else if (kind === Ev.StopHit) {
          if (b >= HASHIDON_SPEED) {
            stopFast = true;
            if (c === 1) found1('endSlam');
          }
        } else if (kind === Ev.Snap) {
          if (a >= PASHI_J) {
            snapBig = true;
            found1('snap');
          }
        } else if (kind === Ev.Apex) {
          const amp = Math.abs(a) * RAD;
          apexRises = apexLast >= 0 && amp > apexLast ? apexRises + 1 : 0;
          apexLast = amp;
          if (apexRises >= BURANKO_RISES && amp >= BURANKO_DEG) {
            pumped = true;
            found1('resonancePump');
          }
        } else if (kind === Ev.HoldBegin) {
          if (chaseDamped()) found1('chaseDamp');
        }
      }
      if (!firstForwardSeen && s.x < minX) minX = s.x;
      return tricks;
    },

    badgesOnSuccess(s, firstAttempt) {
      const out: BadgeId[] = [];
      if (Number.isFinite(s.minD2) && Math.sqrt(s.minD2) - BALL_R < KAMIHITOE_GAP_M) out.push('kamihitoe');
      if (firstAttempt) out.push('ippatsu');
      if (stopFast) out.push('hashidon');
      if (snapBig) out.push('pashi');
      if (pumped) out.push('buranko');
      if (gentleN !== null && s.peakF <= gentleN + 1e-9) out.push('yasashisa');
      return out;
    },

    reset() {
      n = 0;
      lastAmp = 0;
      minX = startX;
      firstForwardSeen = false;
      apexLast = -1;
      apexRises = 0;
      stopFast = false;
      snapBig = false;
      pumped = false;
      found.clear();
      tricks.length = 0;
    },
  };
}
