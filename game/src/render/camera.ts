// Wide (fixed) and tall (follow) cameras (GAME_DESIGN.md §9.2, lead decision D10). Owner: O5.
//
// PerspectiveCamera, vertical FOV 24 deg, looking down 6 deg, yaw 4 deg.
//   wide: fixed framing; x in wideX (or [rail0 - 0.3, rail1 + 0.3]), y in [-0.35, 1.6] fitted into
//         the scene rect below the HUD band. The finger band (floor cross-section) is the bottom.
//   tall (D10): the play area is [hudTop, scene bottom - layout.bench] (O7 sizes it from the width so that a
//         2.0-2.3 m window fills it; the HUD sits above it, and the layout's bench band under it shows the bench
//         front under the floor, where O7 puts the HUD toasts). The frame y in TALL_Y = [-0.05, 1.55] at the ball plane
//         (floor edge .. gantry beam plus one row of ghost tags) fills the play area exactly, which sets
//         the scale; the window width W = scene.w / ppm follows (~2.06 m on a 390x844 phone: ball ~22 px
//         instead of 18). W never drops below the level's minimum (tallWindowFor: 2.0 m, 4-1 2.3 m); when
//         that leaves spare height, a bench-front band (up to 0.35 m, with the ruler) grows under the floor
//         and anything beyond that is left above the beam.
//         The focus looks ahead toward the current goal: the window centre is the goal, clamped so the
//         trolley and the ball stay FOLLOW_MARGIN inside (lookAheadFocus, aimed one spring lag ahead of
//         the trolley's motion), followed with a critically damped spring (time constant 0.25 s) and a
//         hard FOLLOW_KEEP limit. The deck mapping (§3.3) does not depend on this camera.
// `base` is the unshaken camera (used by the rail mapper); `view` = base + shake is rendered.
import { Euler, MathUtils, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import type { Layout } from './renderer';
import { Z_FLOOR_FRONT } from './scene';

export const FOV = 24;
export const PITCH_DEG = 6;
export const YAW_DEG = 4;
export const WIDE_Y: [number, number] = [-0.35, 1.6];
export const FOLLOW_TAU = 0.25;
/** Tall frame at the ball plane: the floor edge up to the beam with one row of ghost tags above it. */
export const TALL_Y: readonly [number, number] = [-0.05, 1.55];
/** Narrowest tall window [m] (D10: 2.0-2.3 m) and the widest one a level may ask for. */
export const TALL_WINDOW_MIN = 2.0;
export const TALL_WINDOW_MAX = 2.3;
/** The spec's default portrait window (§9.2); a level's `view.portraitWindow` is scaled by 2.1 / this. */
export const SPEC_PORTRAIT_WINDOW = 2.6;
/** Spare height in tall first becomes a bench-front band under the floor (ruler), up to this [m]. */
export const TALL_BENCH_MAX = 0.35;
/** The look-ahead keeps the trolley and the ball this far inside the tall window [m]. */
export const FOLLOW_MARGIN = 0.35;
/** Hard limit while the spring catches up: trolley and ball centres at least this far inside [m]. */
export const FOLLOW_KEEP = 0.16;
/**
 * The follow spring lags a target moving at v by 2 * tau * v; the renderer aims that far ahead of the
 * trolley's motion (capped) so the look-ahead survives a dash.
 */
export const FOLLOW_LEAD_MAX = 0.9;
/** How far the tall window may leave the wide x range to keep the ball in view (4-2 swings to 3.4 m) [m]. */
export const FOLLOW_OVERSHOOT = 0.25;

/**
 * Minimum tall window of a level [m]: TALL_WINDOW_MIN, or its `view.portraitWindow` (spec metres, 2.6
 * default) scaled to D10's 2.1 m default, within [TALL_WINDOW_MIN, TALL_WINDOW_MAX] (4-1: 3.0 -> 2.3).
 */
export function tallWindowFor(portraitWindow?: number): number {
  if (typeof portraitWindow !== 'number' || !Number.isFinite(portraitWindow) || portraitWindow <= 0) return TALL_WINDOW_MIN;
  return MathUtils.clamp(portraitWindow * (2.1 / SPEC_PORTRAIT_WINDOW), TALL_WINDOW_MIN, TALL_WINDOW_MAX);
}

/**
 * Tall focus with look-ahead (D10): as close to the goal as possible while the trolley (x) and the ball
 * (bx) stay `margin` inside a window of width W. When both cannot fit, their midpoint.
 */
export function lookAheadFocus(x: number, bx: number, goalX: number, W: number, margin = FOLLOW_MARGIN): number {
  const lo = Math.max(x, bx) + margin - W / 2;
  const hi = Math.min(x, bx) - margin + W / 2;
  if (!(lo <= hi)) return (x + bx) / 2;
  return MathUtils.clamp(Number.isFinite(goalX) ? goalX : (x + bx) / 2, lo, hi);
}

export interface CameraRig {
  readonly base: PerspectiveCamera;
  readonly view: PerspectiveCamera;
  readonly kind: 'wide' | 'tall';
  /** Scene rect size in CSS px + the HUD band height overlapping it. */
  setViewport(l: Layout): void;
  /** Level framing: horizontal range [X0, X1] and the level's minimum tall window width (tallWindowFor()). */
  setLevel(xRange: [number, number], minWindowW: number): void;
  /** Tall follow window width [m] actually shown (scene width / px per metre). */
  readonly windowW: number;
  /**
   * Tall: follow the focus (x of the rail); snap = jump without smoothing. keepLo..keepHi (optional) must
   * stay FOLLOW_KEEP inside the window whatever the spring does: the camera is pushed rigidly if needed.
   */
  follow(focusX: number, dt: number, snap: boolean, keepLo?: number, keepHi?: number): void;
  /** Applies shake to `view` (metres in the view plane, degrees of roll). */
  applyShake(ox: number, oy: number, rollDeg: number): void;
  /** CSS px per metre at the ball plane (z = 0). */
  pxPerM(): number;
  /** Screen-aligned height at depth z for a world height h at z = 0 (camera-ray projection). */
  projectY(h: number, z: number): number;
  /** Visible x range at y = 0.6, z = 0 for the base camera (cached until the camera moves). */
  visibleX(): readonly [number, number];
  /** Visible x range on the line (y, z) for the base camera. */
  visibleXAt(y: number, z: number): [number, number];
}

const DEG = Math.PI / 180;

export function createCamera(): CameraRig {
  const base = new PerspectiveCamera(FOV, 1, 0.05, 60);
  const view = new PerspectiveCamera(FOV, 1, 0.05, 60);
  const q = new Quaternion().setFromEuler(new Euler(-PITCH_DEG * DEG, -YAW_DEG * DEG, 0, 'YXZ'));
  const qInv = q.clone().invert();
  const right = new Vector3(1, 0, 0).applyQuaternion(q);
  const up = new Vector3(0, 1, 0).applyQuaternion(q);
  const fwd = new Vector3(0, 0, -1).applyQuaternion(q);
  base.quaternion.copy(q);
  view.quaternion.copy(q);

  let kind: 'wide' | 'tall' = 'wide';
  let w = 1, h = 1, band = 56, benchPx = 0;
  let X: [number, number] = [-1.3, 3.5];
  let Wmin = TALL_WINDOW_MIN;
  let W = 2.1;
  const home = new Vector3(0, 0.8, 6); // camera position for focusX = homeFocus
  let homeFocus = 1.1;
  let focus = 1.1, focusV = 0;
  let ppm = 200;
  const tmp = new Vector3(), tmp2 = new Vector3();

  const ndc = (C: Vector3, P: Vector3, out: { x: number; y: number }): void => {
    tmp.copy(P).sub(C).applyQuaternion(qInv);
    const t = Math.tan((FOV * DEG) / 2);
    out.x = tmp.x / -tmp.z / (t * (w / h));
    out.y = tmp.y / -tmp.z / t;
  };

  /** Moves C so the points' NDC bbox fits [tx0,tx1]x[ty0,ty1] (centred, or bottom-anchored). */
  const fit = (pts: Vector3[], tx0: number, tx1: number, ty0: number, ty1: number, anchor: 'center' | 'bottom', C: Vector3): void => {
    const centroid = new Vector3();
    for (const p of pts) centroid.add(p);
    centroid.multiplyScalar(1 / pts.length);
    C.copy(centroid).addScaledVector(fwd, -7);
    const o = { x: 0, y: 0 };
    const t = Math.tan((FOV * DEG) / 2);
    for (let it = 0; it < 60; it++) {
      let bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity;
      for (const p of pts) {
        ndc(C, p, o);
        bx0 = Math.min(bx0, o.x); bx1 = Math.max(bx1, o.x);
        by0 = Math.min(by0, o.y); by1 = Math.max(by1, o.y);
      }
      const s = Math.max((bx1 - bx0) / (tx1 - tx0), (by1 - by0) / (ty1 - ty0));
      const d = tmp2.copy(centroid).sub(C).dot(fwd);
      const dx = (tx0 + tx1) / 2 - (bx0 + bx1) / 2;
      const dy = anchor === 'center' ? (ty0 + ty1) / 2 - (by0 + by1) / 2 : ty0 - by0;
      C.addScaledVector(right, -dx * d * t * (w / h));
      C.addScaledVector(up, -dy * d * t);
      C.addScaledVector(fwd, -d * (s - 1));
      if (Math.abs(s - 1) < 1e-6 && Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) break;
    }
  };

  const place = (C: Vector3): void => {
    base.position.copy(C);
    base.updateMatrixWorld(true);
    view.position.copy(C);
    view.quaternion.copy(q);
    view.updateMatrixWorld(true);
  };

  const measurePpm = (): void => {
    const o0 = { x: 0, y: 0 }, o1 = { x: 0, y: 0 };
    const cx = kind === 'tall' ? focus : (X[0] + X[1]) / 2;
    ndc(base.position, new Vector3(cx - 0.5, 0.6, 0), o0);
    ndc(base.position, new Vector3(cx + 0.5, 0.6, 0), o1);
    ppm = Math.abs(o1.x - o0.x) * 0.5 * w;
  };

  const refit = (): void => {
    const hudFrac = Math.min(0.45, Math.max(0, band / h));
    const top = 1 - 2 * hudFrac;
    if (kind === 'wide') {
      const pts = [
        new Vector3(X[0], WIDE_Y[1], 0), new Vector3(X[1], WIDE_Y[1], 0),
        new Vector3(X[0], WIDE_Y[0], Z_FLOOR_FRONT), new Vector3(X[1], WIDE_Y[0], Z_FLOOR_FRONT),
      ];
      fit(pts, -1, 1, -1, top, 'center', home);
      homeFocus = (X[0] + X[1]) / 2;
      focus = homeFocus;
      place(home);
    } else {
      // 1) The frame fills the play area vertically -> the scale, and W = scene width / ppm.
      const cx = (X[0] + X[1]) / 2;
      const topT = 1 - 2 * Math.min(0.8, Math.max(0, band / h));
      // The layout's bench band at the bottom is not part of the play area (the bench front fills it).
      const botT = Math.min(topT - 0.2, -1 + (2 * benchPx) / h);
      const keepFocus = focus;
      homeFocus = focus = cx;
      const run = (pts: Vector3[]): void => {
        fit(pts, -1, 1, botT, topT, 'bottom', home);
        place(home);
        measurePpm();
      };
      const yTop = new Vector3(cx, TALL_Y[1], 0);
      run([yTop, new Vector3(cx, TALL_Y[0], 0)]);
      const Wv = w / Math.max(1e-6, ppm);
      if (Number.isFinite(Wv) && Wv >= Wmin * 0.999) {
        W = Wv;
      } else {
        // 2) Too narrow: hold the level's minimum window; spare height becomes a bench band under the floor.
        W = Wmin;
        const side = [new Vector3(cx - W / 2, 0.6, 0), new Vector3(cx + W / 2, 0.6, 0)];
        run([...side, yTop, new Vector3(cx, TALL_Y[0], 0)]);
        const o = { x: 0, y: 0 };
        ndc(base.position, yTop, o);
        const spare = ((topT - o.y) * h) / 2 / Math.max(1e-6, ppm);
        const bench = Math.max(0, Math.min(TALL_BENCH_MAX, spare * 0.98));
        if (bench > 0.005) run([...side, yTop, new Vector3(cx, TALL_Y[0] - bench, 0)]);
        W = w / Math.max(1e-6, ppm);
      }
      focus = clampFocus(keepFocus);
      place(tmp2.copy(home).setX(home.x + (focus - homeFocus)));
      measurePpm();
      return;
    }
    measurePpm();
  };

  // visibleX cache (recomputed only when the base camera moved or the viewport changed).
  const visCache: [number, number] = [0, 0];
  let visKeyX = NaN, visKeyW = NaN, visKeyH = NaN;
  const ndcOut = { x: 0, y: 0 };
  /** x on the line (y, z) that the base camera sees at NDC x = target (bisection; NDC x is monotonic in x). */
  const solveEdge = (target: number, y: number, z: number): number => {
    const C = base.position;
    let lo = C.x - 20, hi = C.x + 20;
    for (let i = 0; i < 50; i++) {
      const mid = (lo + hi) / 2;
      ndc(C, tmp2.set(mid, y, z), ndcOut);
      if (ndcOut.x < target) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  };

  const clampFocus = (f: number): number => {
    const lo = X[0] + W / 2 - FOLLOW_OVERSHOOT, hi = X[1] - W / 2 + FOLLOW_OVERSHOOT;
    return lo > hi ? (X[0] + X[1]) / 2 : MathUtils.clamp(f, lo, hi);
  };

  return {
    base, view,
    get kind() { return kind; },
    get windowW() { return W; },
    setViewport(l) {
      kind = l.kind;
      w = Math.max(1, l.scene.w);
      h = Math.max(1, l.scene.h);
      band = Math.max(0, l.hudTop - l.scene.y);
      benchPx = l.kind === 'tall' ? Math.max(0, l.bench ?? 0) : 0;
      base.aspect = view.aspect = w / h;
      base.updateProjectionMatrix();
      view.updateProjectionMatrix();
      refit();
    },
    setLevel(xRange, minWindowW) {
      X = [xRange[0], xRange[1]];
      Wmin = Number.isFinite(minWindowW) && minWindowW > 0 ? minWindowW : TALL_WINDOW_MIN;
      focus = clampFocus(focus);
      focusV = 0;
      refit();
    },
    follow(target, dt, snap, keepLo, keepHi) {
      if (kind !== 'tall') return;
      // A non-finite target would poison the spring state for good: hold the camera instead.
      if (!Number.isFinite(target)) return;
      const tgt = clampFocus(target);
      if (snap) {
        focus = tgt;
        focusV = 0;
      } else if (dt > 0) {
        const wn = 1 / FOLLOW_TAU;
        const y = focus - tgt;
        const e = Math.exp(-wn * dt);
        const k = (focusV + wn * y) * dt;
        focus = tgt + (y + k) * e;
        focusV = (focusV - wn * k) * e;
      }
      if (keepLo !== undefined && keepHi !== undefined && Number.isFinite(keepLo) && Number.isFinite(keepHi)) {
        const lo = keepHi + FOLLOW_KEEP - W / 2, hi = keepLo - FOLLOW_KEEP + W / 2;
        if (lo <= hi) {
          const f0 = focus;
          focus = clampFocus(MathUtils.clamp(focus, lo, hi));
          // Pushed: drop the spring velocity that pointed the wrong way.
          if (focus !== f0 && dt > 0 && Math.sign(focusV) !== Math.sign(focus - f0)) focusV = 0;
        }
      }
      place(tmp2.copy(home).setX(home.x + (focus - homeFocus)));
    },
    applyShake(ox, oy, rollDeg) {
      view.position.copy(base.position).addScaledVector(right, ox).addScaledVector(up, oy);
      view.quaternion.copy(q);
      if (rollDeg !== 0) view.rotateZ(rollDeg * DEG);
      view.updateMatrixWorld(true);
    },
    pxPerM: () => ppm,
    projectY(hh, z) {
      const C = base.position;
      const t = (C.z - z) / C.z;
      return C.y + (hh - C.y) * t;
    },
    visibleX() {
      const C = base.position;
      if (visKeyX !== C.x || visKeyW !== w || visKeyH !== h) {
        visKeyX = C.x;
        visKeyW = w;
        visKeyH = h;
        visCache[0] = solveEdge(-1, 0.6, 0);
        visCache[1] = solveEdge(1, 0.6, 0);
      }
      return visCache;
    },
    visibleXAt(y, z) {
      return [solveEdge(-1, y, z), solveEdge(1, y, z)];
    },
  };
}
