// Segment/point vs wall-slab distances (GAME_DESIGN.md §4.5). Owner: O1.
//
// A wall is the slab x0 <= x <= x1, y <= h standing on the floor (ballwall/geometry.py).
// Everything is compared squared (no sqrt, §4.3). In segSlabDist2 the only division is the
// closest-point parameter t = dot/len2; the *Entry helper (display contact points only) also divides.
import type { WallDef } from './level';

/** Scratch 2-vector written by the *Closest / *Entry helpers. */
export interface Vec2 { x: number; y: number }

/** Squared distance between point (px,py) and the slab (0 inside). */
export function pointSlabDist2(px: number, py: number, wall: WallDef): number {
  let dx = 0;
  if (px < wall.x0) dx = wall.x0 - px;
  else if (px > wall.x1) dx = px - wall.x1;
  const dy = py > wall.h ? py - wall.h : 0;
  return dx * dx + dy * dy;
}

/** Squared distance between point (cx,cy) and segment (ax,ay)-(bx,by). */
export function pointSegDist2(cx: number, cy: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = 0;
  if (len2 > 0) {
    t = ((cx - ax) * dx + (cy - ay) * dy) / len2;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
  }
  const ex = ax + t * dx - cx;
  const ey = ay + t * dy - cy;
  return ex * ex + ey * ey;
}

/**
 * True when the segment meets the slab (touching a top corner counts): inside the overlap of the
 * segment's x range and [x0, x1], the lowest y of the segment (linear in x, so at an end of the
 * overlap) is <= h. Division free.
 */
export function segHitsSlab(ax: number, ay: number, bx: number, by: number, wall: WallDef): boolean {
  let lx = ax;
  let ly = ay;
  let rx = bx;
  let ry = by;
  if (bx < ax) {
    lx = bx;
    ly = by;
    rx = ax;
    ry = ay;
  }
  if (rx < wall.x0 || lx > wall.x1) return false;
  const h = wall.h;
  const dx = rx - lx;
  if (dx === 0) return (ly < ry ? ly : ry) <= h;
  const xa = lx > wall.x0 ? lx : wall.x0;
  const xb = rx < wall.x1 ? rx : wall.x1;
  // y(xq) <= h  <=>  (ly - h)*dx + (ry - ly)*(xq - lx) <= 0   (dx > 0)
  const base = (ly - h) * dx;
  const dy = ry - ly;
  return base + dy * (xa - lx) <= 0 || base + dy * (xb - lx) <= 0;
}

/** Squared distance between segment (ax,ay)-(bx,by) and the slab x0<=x<=x1, y<=h. 0 when they intersect. */
export function segSlabDist2(ax: number, ay: number, bx: number, by: number, wall: WallDef): number {
  if (segHitsSlab(ax, ay, bx, by, wall)) return 0;
  // Convex slab and a segment that misses it: the minimum is at a segment end point or at a top corner.
  let d = pointSlabDist2(ax, ay, wall);
  const db = pointSlabDist2(bx, by, wall);
  if (db < d) d = db;
  const d0 = pointSegDist2(wall.x0, wall.h, ax, ay, bx, by);
  if (d0 < d) d = d0;
  const d1 = pointSegDist2(wall.x1, wall.h, ax, ay, bx, by);
  if (d1 < d) d = d1;
  return d;
}

/**
 * Liang-Barsky: the first point of segment A->B inside the slab, written to out. Returns false when
 * the segment misses the slab (then out is untouched). Used for display contact points only.
 */
export function segSlabEntry(ax: number, ay: number, bx: number, by: number, wall: WallDef, out: Vec2): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  let t0 = 0;
  let t1 = 1;
  // p*t <= q for: x >= x0, x <= x1, y <= h
  for (let k = 0; k < 3; k++) {
    let p: number;
    let q: number;
    if (k === 0) {
      p = -dx;
      q = ax - wall.x0;
    } else if (k === 1) {
      p = dx;
      q = wall.x1 - ax;
    } else {
      p = dy;
      q = wall.h - ay;
    }
    if (p === 0) {
      if (q < 0) return false;
    } else if (p < 0) {
      const r = q / p;
      if (r > t0) t0 = r;
    } else {
      const r = q / p;
      if (r < t1) t1 = r;
    }
    if (t0 > t1) return false;
  }
  out.x = ax + t0 * dx;
  out.y = ay + t0 * dy;
  return true;
}

/** Closest slab point to (px,py), written to out; returns the squared distance. */
export function pointSlabClosest(px: number, py: number, wall: WallDef, out: Vec2): number {
  const cx = px < wall.x0 ? wall.x0 : px > wall.x1 ? wall.x1 : px;
  const cy = py > wall.h ? wall.h : py;
  out.x = cx;
  out.y = cy;
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy;
}

/**
 * segSlabDist2 that also writes the slab point closest to the segment into out
 * (for an intersecting segment: the point where A->B enters the slab). The returned value is
 * bit-identical to segSlabDist2.
 */
export function segSlabClosest(ax: number, ay: number, bx: number, by: number, wall: WallDef, out: Vec2): number {
  if (segHitsSlab(ax, ay, bx, by, wall)) {
    if (!segSlabEntry(ax, ay, bx, by, wall, out)) pointSlabClosest(bx, by, wall, out);
    return 0;
  }
  let d = pointSlabDist2(ax, ay, wall);
  let which = 0;
  const db = pointSlabDist2(bx, by, wall);
  if (db < d) {
    d = db;
    which = 1;
  }
  const d0 = pointSegDist2(wall.x0, wall.h, ax, ay, bx, by);
  if (d0 < d) {
    d = d0;
    which = 2;
  }
  const d1 = pointSegDist2(wall.x1, wall.h, ax, ay, bx, by);
  if (d1 < d) {
    d = d1;
    which = 3;
  }
  if (which === 0) pointSlabClosest(ax, ay, wall, out);
  else if (which === 1) pointSlabClosest(bx, by, wall, out);
  else {
    out.x = which === 2 ? wall.x0 : wall.x1;
    out.y = wall.h;
  }
  return d;
}

// ---- array forms for the stepper ----------------------------------------------------------------
// V8 boxes every double that crosses a call boundary it did not inline (a fresh HeapNumber per argument
// and return value). The stepper therefore hands segments over in a Float64Array, gets the results back in
// one, and these two functions call nothing, so no double ever crosses a call boundary on the hot path.
// They compute exactly what segSlabClosest / segHitsSlab compute (same operations, same order).

/** segSlabClosest for seg = [ax, ay, bx, by]: writes [d2, closest x, closest y] to out. Calls nothing. */
export function segSlabClosestA(seg: Float64Array, wall: WallDef, out: Float64Array): void {
  const ax = seg[0]!;
  const ay = seg[1]!;
  const bx = seg[2]!;
  const by = seg[3]!;
  const x0 = wall.x0;
  const x1 = wall.x1;
  const h = wall.h;
  if (segHitsSlabA(seg, wall)) {
    // entry point of A->B into the slab (Liang-Barsky, as segSlabEntry), else the slab point closest to B
    const dx = bx - ax;
    const dy = by - ay;
    let t0 = 0;
    let t1 = 1;
    let ok = true;
    for (let k = 0; k < 3 && ok; k++) {
      const p = k === 0 ? -dx : k === 1 ? dx : dy;
      const q = k === 0 ? ax - x0 : k === 1 ? x1 - ax : h - ay;
      if (p === 0) {
        if (q < 0) ok = false;
      } else if (p < 0) {
        const r = q / p;
        if (r > t0) t0 = r;
      } else {
        const r = q / p;
        if (r < t1) t1 = r;
      }
      if (t0 > t1) ok = false;
    }
    out[0] = 0;
    if (ok) {
      out[1] = ax + t0 * dx;
      out[2] = ay + t0 * dy;
    } else {
      out[1] = bx < x0 ? x0 : bx > x1 ? x1 : bx;
      out[2] = by > h ? h : by;
    }
    return;
  }
  // end point A
  let ex = 0;
  if (ax < x0) ex = x0 - ax;
  else if (ax > x1) ex = ax - x1;
  let ey = ay > h ? ay - h : 0;
  let d = ex * ex + ey * ey;
  let which = 0;
  // end point B
  ex = 0;
  if (bx < x0) ex = x0 - bx;
  else if (bx > x1) ex = bx - x1;
  ey = by > h ? by - h : 0;
  const db = ex * ex + ey * ey;
  if (db < d) {
    d = db;
    which = 1;
  }
  // the two top corners against the segment
  const sx = bx - ax;
  const sy = by - ay;
  const len2 = sx * sx + sy * sy;
  for (let k = 0; k < 2; k++) {
    const cx = k === 0 ? x0 : x1;
    let t = 0;
    if (len2 > 0) {
      t = ((cx - ax) * sx + (h - ay) * sy) / len2;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
    }
    const fx = ax + t * sx - cx;
    const fy = ay + t * sy - h;
    const dc = fx * fx + fy * fy;
    if (dc < d) {
      d = dc;
      which = 2 + k;
    }
  }
  out[0] = d;
  if (which === 0) {
    out[1] = ax < x0 ? x0 : ax > x1 ? x1 : ax;
    out[2] = ay > h ? h : ay;
  } else if (which === 1) {
    out[1] = bx < x0 ? x0 : bx > x1 ? x1 : bx;
    out[2] = by > h ? h : by;
  } else {
    out[1] = which === 2 ? x0 : x1;
    out[2] = h;
  }
}

/** segHitsSlab for seg = [ax, ay, bx, by]. Calls nothing. */
export function segHitsSlabA(seg: Float64Array, wall: WallDef): boolean {
  const ax = seg[0]!;
  const ay = seg[1]!;
  const bx = seg[2]!;
  const by = seg[3]!;
  let lx = ax;
  let ly = ay;
  let rx = bx;
  let ry = by;
  if (bx < ax) {
    lx = bx;
    ly = by;
    rx = ax;
    ry = ay;
  }
  if (rx < wall.x0 || lx > wall.x1) return false;
  const h = wall.h;
  const dx = rx - lx;
  if (dx === 0) return (ly < ry ? ly : ry) <= h;
  const xa = lx > wall.x0 ? lx : wall.x0;
  const xb = rx < wall.x1 ? rx : wall.x1;
  const base = (ly - h) * dx;
  const dy = ry - ly;
  return base + dy * (xa - lx) <= 0 || base + dy * (xb - lx) <= 0;
}
