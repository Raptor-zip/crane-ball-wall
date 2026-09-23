// Layout detection (§3.3) and the tall proportions of lead decision D10. Owner: O7.
//   tall (h / w >= 1.25): band + status row + panel (hudTop), then a play area sized for a 2.1-2.3 m follow window
//   (the camera frame of y in [-0.05, 1.55] is TALL_FRAME_K * w / W px tall), then the bench band (the bottom of the
//   3D view) and the deck (together >= 34 %, <= 46 %).
//   wide: full-screen scene, no deck, hudTop = the 56 px band.
import { describe, expect, it } from 'vitest';
import {
  computeLayout, DECK_HARD_MIN_FRAC, DECK_HARD_MIN_PX, DECK_MIN_PX, HUD_BAND, TALL_BENCH_H, TALL_FRAME_K, TALL_PANEL_H, TALL_PANEL_MIN,
  TALL_STATUS_H, TALL_WINDOW_M, sameLayout, tallPanelH, tallPlayH,
} from '../../src/ui/layout';

/** The follow-window width that exactly fills the play area of a tall layout (the scene above the bench band). */
const windowOf = (l: ReturnType<typeof computeLayout>): number => (TALL_FRAME_K * l.w) / (l.scene.h - l.hudTop - (l.bench ?? 0));
/** Everything under the play area: the bench band (3D view) and the deck. */
const lowerOf = (l: ReturnType<typeof computeLayout>): number => l.deck!.h + (l.bench ?? 0);

describe('computeLayout', () => {
  it('390x844 phone portrait: HUD, a 2.1 m play area right under it, the deck below (D10)', () => {
    const l = computeLayout(390, 844, 3);
    expect(l.kind).toBe('tall');
    expect(l.dpr).toBe(2);
    expect(l.hudTop).toBe(HUD_BAND + TALL_STATUS_H + TALL_PANEL_H);
    expect(l.bench).toBe(TALL_BENCH_H);
    expect(l.scene).toEqual({ x: 0, y: 0, w: 390, h: l.hudTop + tallPlayH(390, TALL_WINDOW_M) + TALL_BENCH_H });
    expect(l.deck).toEqual({ x: 0, y: l.scene.h, w: 390, h: 844 - l.scene.h });
    expect(windowOf(l)).toBeCloseTo(2.1, 1);
    // The old 62 / 38 split left ~40 % of the 3D view as empty paper above the gantry; now the deck gets that room.
    expect(lowerOf(l) / 844).toBeGreaterThan(0.4);
    expect(lowerOf(l) / 844).toBeLessThanOrEqual(0.46);
    // No 2D mini rail in the deck any more (the deck was 373 px with it): of its 72 px, the 3D view's bench band took
    // TALL_BENCH_H and the drag surface under the force bar the rest.
    expect(TALL_BENCH_H).toBeLessThan(72);
    expect(l.deck!.h).toBe(373 - TALL_BENCH_H);
  });

  it('1280x720 and 844x390 are wide with a full-screen scene and no deck', () => {
    for (const [w, h] of [[1280, 720], [844, 390]] as const) {
      const l = computeLayout(w, h, 1);
      expect(l.kind).toBe('wide');
      expect(l.scene).toEqual({ x: 0, y: 0, w, h });
      expect(l.deck).toBeNull();
      expect(l.bench ?? 0).toBe(0);
      expect(l.hudTop).toBe(HUD_BAND);
    }
  });

  it('switches exactly at h / w = 1.25', () => {
    expect(computeLayout(400, 500, 1).kind).toBe('tall');
    expect(computeLayout(400, 499, 1).kind).toBe('wide');
  });

  it('adds the top safe-area inset to the HUD (tall and wide)', () => {
    expect(computeLayout(390, 844, 1, 47).hudTop).toBe(computeLayout(390, 844, 1, 0).hudTop + 47);
    expect(computeLayout(844, 390, 1, 20).hudTop).toBe(HUD_BAND + 20);
    expect(tallPanelH(computeLayout(390, 844, 1, 47), 47)).toBe(TALL_PANEL_H);
  });

  it('phones from 320 px to 430 px: window 2.0-2.3 m, panel >= 40 px, deck 34-46 %, rects tile the screen', () => {
    const phones: [number, number, number][] = [
      [320, 568, 0], [320, 640, 0], [360, 640, 0], [360, 740, 0], [360, 800, 0], [375, 667, 0], [375, 812, 44],
      [390, 664, 0], [390, 844, 0], [390, 844, 47], [393, 852, 59], [412, 915, 0], [414, 896, 44], [430, 932, 59],
    ];
    for (const [w, h, safe] of phones) {
      const l = computeLayout(w, h, 2, safe);
      const tag = `${w}x${h}+${safe}`;
      expect(l.kind, tag).toBe('tall');
      expect(l.scene.y + l.scene.h, tag).toBe(l.deck!.y);
      expect(l.deck!.y + l.deck!.h, tag).toBe(h);
      const win = windowOf(l);
      expect(win, tag).toBeGreaterThanOrEqual(1.99);
      expect(win, tag).toBeLessThanOrEqual(w <= 320 && h <= 568 ? 2.45 : 2.31);
      expect(l.hudTop - safe - HUD_BAND - TALL_STATUS_H, tag).toBeGreaterThanOrEqual(TALL_PANEL_MIN);
      expect(l.bench, tag).toBe(TALL_BENCH_H);
      expect(lowerOf(l), tag).toBeGreaterThanOrEqual(Math.min(200, 0.34 * h) - 1);
      expect(lowerOf(l) / h, tag).toBeLessThanOrEqual(0.465);
    }
  });

  it('short phones (iPhone SE Safari 375x548, 360x560, 320x568): the panel keeps its minimum, the deck gives up <= 24 px', () => {
    // Under 40 px the scoreboard ran over the ghost tags at the top of the play area (release review ui-7).
    for (const [w, h] of [[375, 548], [360, 560], [320, 568], [375, 553], [414, 600]] as const) {
      const l = computeLayout(w, h, 2);
      const tag = `${w}x${h}`;
      expect(l.kind, tag).toBe('tall');
      expect(tallPanelH(l), tag).toBeGreaterThanOrEqual(TALL_PANEL_MIN);
      expect(lowerOf(l), tag).toBeGreaterThanOrEqual(Math.max(DECK_HARD_MIN_PX, Math.round(h * DECK_HARD_MIN_FRAC)));
      expect(lowerOf(l), tag).toBeGreaterThanOrEqual(DECK_MIN_PX - 24);
      expect(l.scene.h + l.deck!.h, tag).toBe(h);
    }
    // Only a screen too short even for that gives up panel room (and never goes under the hard deck floor).
    const tiny = computeLayout(320, 480, 2);
    expect(tallPanelH(tiny)).toBeLessThan(TALL_PANEL_MIN);
    expect(lowerOf(tiny)).toBeGreaterThanOrEqual(DECK_HARD_MIN_PX);
  });

  it('portrait tablets zoom out instead of squeezing the deck', () => {
    const l = computeLayout(768, 1024, 2);
    expect(l.kind).toBe('tall');
    expect(lowerOf(l) / 1024).toBeGreaterThanOrEqual(0.335);
    // zoomed out well past the 2.1 m phone window (2.29 m here), within the 2.8 m tablet floor
    expect(windowOf(l)).toBeGreaterThan(2.25);
    expect(windowOf(l)).toBeLessThanOrEqual(2.8);
  });

  it('sameLayout notices a new split even when w / h / hudTop stay the same', () => {
    const a = computeLayout(390, 844, 2);
    expect(sameLayout(a, computeLayout(390, 844, 2))).toBe(true);
    expect(sameLayout(a, { ...a, scene: { ...a.scene, h: a.scene.h + 1 } })).toBe(false);
  });
});
