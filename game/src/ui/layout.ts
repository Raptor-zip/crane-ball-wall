// wide / tall layout computation (GAME_DESIGN.md §3.3, lead decision D10). Owner: O7.
//
// tall (portrait phones), from the top:
//   HUD band      safeTop + 56 px   ↺ | level | ⏸
//   status row    48 px             READY chips, practice rewind, egg tension, mode chip, daily rack, offline
//   HUD panel     40..72 px         the scoreboard (AI par | clock + split delta | PB), or the READY hint
//                                   (status row + panel form the "dock"; an empty status row gives its room to the panel)
//   play area     the 3D camera's frame: y in [-0.05, 1.55] of a ~2.1 m follow window (D10: 2.0-2.3 m)
//   bench band    56 px, still the 3D view: the bench front under the floor (ruler); HUD toasts sit here
//   deck          force bar, control surface (the rest)
// Layout contract for the renderer: `hudTop` is the bottom of the HUD (band + status row + panel), `bench` the band
// at the bottom of the scene, and the play area is [hudTop, scene.y + scene.h - bench]. Its height is sized from the
// width so that a 2.1-2.3 m window fills it with the gantry beam right under the HUD; there is no empty paper above
// the gantry any more (D10). The bench band and the deck share the old 2D mini rail's 72 px: 56 px of bench (a one-line
// toast fits under the floor's front edge) and 16 px more drag surface.
import type { Layout } from '../render/renderer';

/** HUD band height in CSS px (§9.2, §9.3), before the top safe-area inset. wide: hudTop = HUD_BAND + safeTop. */
export const HUD_BAND = 56;
/** tall: the status row under the band (READY chips, mode chip, daily rack). Holds 44 px touch targets. */
export const TALL_STATUS_H = 48;
/** tall: the HUD panel under the status row (READY hint / scoreboard), preferred and minimum height. */
export const TALL_PANEL_H = 72;
export const TALL_PANEL_MIN = 40;
/**
 * tall: the camera frame (y in [-0.05, 1.55], §9.2) of a follow window W metres wide is FRAME_K · w / W px tall
 * (FOV 24°, pitch 6°, yaw 4°; measured on src/render/camera.ts's tall fit: 1.584..1.587 at 320..430 px widths).
 */
export const TALL_FRAME_K = 1.586;
/** tall: preferred follow window, and the widest / narrowest window the play area is sized for (D10: 2.0-2.3 m). */
export const TALL_WINDOW_M = 2.1;
export const TALL_WINDOW_MAX = 2.3;
export const TALL_WINDOW_MIN = 2.0;
/** tall: how far the window may widen (tablets, nearly square windows) before the HUD panel gives up room. */
export const TALL_WINDOW_FLOOR = 2.8;
/**
 * tall: the bench band plus the deck (everything under the play area) never gets less than max(DECK_MIN_PX, 34 % of
 * the height) nor (when avoidable) more than 46 %.
 */
export const DECK_MIN_PX = 200;
export const DECK_MIN_FRAC = 0.34;
/**
 * tall, short screens (iPhone SE Safari 375x548, 360x560): bench + deck give up to 24 px of that minimum (down to
 * max(DECK_HARD_MIN_PX, 32 %)) before the HUD panel goes under TALL_PANEL_MIN, where the scoreboard no longer fits and
 * would run over the ghost tags at the top of the play area.
 */
export const DECK_HARD_MIN_PX = 176;
export const DECK_HARD_MIN_FRAC = 0.32;
export const DECK_MAX_FRAC = 0.46;
/**
 * tall: the bench band at the bottom of the scene, under the floor (the camera frames the play area above it). Just
 * enough bench front for a one-line HUD toast under the floor's front edge at any text size (ui.ts toastArea).
 */
export const TALL_BENCH_H = 56;
/** Deck contents from the top (§3.3): the force bar, then the control surface. */
export const DECK_FORCE_H = 8;

/** Play-area height (CSS px) that a follow window of `windowM` metres fills at width `w`. */
export function tallPlayH(w: number, windowM: number): number {
  return Math.ceil((TALL_FRAME_K * w) / windowM);
}

/**
 * tall when h / w >= 1.25 (scene on top, deck below, proportions above); wide otherwise (full-screen scene, HUD in
 * the corners, hudTop = HUD band). `safeTop` is env(safe-area-inset-top) in CSS px; hudTop includes it.
 */
export function computeLayout(w: number, h: number, dpr: number, safeTop = 0): Layout {
  const W = Math.max(1, Math.round(w));
  const H = Math.max(1, Math.round(h));
  const d = Math.min(Math.max(dpr || 1, 1), 2);
  const safe = Math.max(0, Math.round(safeTop || 0));
  if (H / W >= 1.25) {
    const top0 = safe + HUD_BAND + TALL_STATUS_H;
    const deckMin = Math.max(DECK_MIN_PX, Math.round(H * DECK_MIN_FRAC));
    const deckMax = Math.round(H * DECK_MAX_FRAC);
    let panel = TALL_PANEL_H;
    let play = tallPlayH(W, TALL_WINDOW_M);
    const playMin = tallPlayH(W, TALL_WINDOW_MAX);
    const playMax = tallPlayH(W, TALL_WINDOW_MIN);
    // The bench band and the deck share what the play area leaves (the deck limits below cover both).
    const deckOf = (): number => H - top0 - panel - play;
    // Short screens: give up panel room first, then zoom out to the widest phone window (2.3 m), further on tablets
    // and nearly square windows (2.8 m), then a little deck room, and only then below the panel minimum.
    const playFloor = tallPlayH(W, TALL_WINDOW_FLOOR);
    if (deckOf() < deckMin) panel -= Math.min(deckMin - deckOf(), panel - TALL_PANEL_MIN);
    if (deckOf() < deckMin) play -= Math.min(deckMin - deckOf(), Math.max(0, play - playMin));
    if (deckOf() < deckMin) play -= Math.min(deckMin - deckOf(), Math.max(0, play - playFloor));
    const deckHard = Math.min(deckMin, Math.max(DECK_HARD_MIN_PX, Math.round(H * DECK_HARD_MIN_FRAC)));
    if (deckOf() < deckHard) panel -= Math.min(deckHard - deckOf(), panel);
    if (deckOf() < deckHard) play = Math.max(1, H - top0 - panel - deckHard);
    // Long screens: a bigger play area (down to a 2.0 m window) before the deck grows past 46 %.
    if (deckOf() > deckMax) play += Math.min(deckOf() - deckMax, Math.max(0, playMax - play));
    const hudTop = top0 + panel;
    const sceneH = Math.min(H - 1, hudTop + play + TALL_BENCH_H);
    return {
      kind: 'tall', w: W, h: H, dpr: d,
      scene: { x: 0, y: 0, w: W, h: sceneH },
      deck: { x: 0, y: sceneH, w: W, h: H - sceneH },
      hudTop,
      bench: Math.max(0, Math.min(TALL_BENCH_H, sceneH - hudTop - 1)),
    };
  }
  return { kind: 'wide', w: W, h: H, dpr: d, scene: { x: 0, y: 0, w: W, h: H }, deck: null, hudTop: HUD_BAND + safe };
}

/** tall: height of the HUD panel (the part of hudTop under the band and the status row). 0 in wide. */
export function tallPanelH(l: Layout, safeTop = 0): number {
  if (l.kind !== 'tall') return 0;
  return Math.max(0, l.hudTop - Math.max(0, Math.round(safeTop || 0)) - HUD_BAND - TALL_STATUS_H);
}

export function sameLayout(a: Layout, b: Layout): boolean {
  return a.kind === b.kind && a.w === b.w && a.h === b.h && a.dpr === b.dpr && a.hudTop === b.hudTop
    && a.scene.h === b.scene.h && (a.bench ?? 0) === (b.bench ?? 0);
}
