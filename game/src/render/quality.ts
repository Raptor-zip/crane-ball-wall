// DPR / shadow auto-adjust (GAME_DESIGN.md §9.7). Owner: O5.
//
// high : DPR up to 2, PCF shadows, never downgrades.
// low  : DPR 1.0, blob shadows.
// auto : phones start at DPR 1.5 with blob shadows; desktops at DPR <= 2 with shadows. If frames
//        stay above 20 ms for 2 s, drop to DPR 1.0 and switch shadows off (once).

export type QualitySetting = 'auto' | 'high' | 'low';
export interface QualityState { dpr: number; shadows: boolean }

export interface QualityGovernor {
  /** Feed one frame time; returns the (possibly changed) state. */
  sample(frameMs: number): QualityState;
  readonly state: QualityState;
  /** Device pixel ratio of the display (re-read on layout changes). */
  setDeviceDpr(dpr: number): void;
}

export function isPhoneLike(): boolean {
  try {
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    const small = Math.min(screen.width, screen.height) < 600;
    return coarse || small;
  } catch {
    return false;
  }
}

export function createQualityGovernor(setting: QualitySetting, phone = isPhoneLike(), deviceDpr = 1): QualityGovernor {
  let dev = deviceDpr;
  let degraded = setting === 'low';
  let slowFor = 0;
  let ema = 16.7;
  const state: QualityState = { dpr: 1, shadows: false };
  const apply = (): void => {
    if (setting === 'low' || degraded) {
      state.dpr = 1;
      state.shadows = false;
    } else if (setting === 'high') {
      state.dpr = Math.min(dev, 2);
      state.shadows = true;
    } else {
      state.dpr = Math.min(dev, phone ? 1.5 : 2);
      state.shadows = !phone;
    }
  };
  apply();
  return {
    state,
    setDeviceDpr(d) {
      dev = d > 0 ? d : 1;
      apply();
    },
    sample(ms) {
      if (setting !== 'auto' || degraded) return state;
      if (!(ms > 0) || ms > 250) return state; // tab switches and hitches are not a trend
      ema += (ms - ema) * 0.2;
      slowFor = ema > 20 ? slowFor + ms / 1000 : 0;
      if (slowFor >= 2) {
        degraded = true;
        apply();
      }
      return state;
    },
  };
}
