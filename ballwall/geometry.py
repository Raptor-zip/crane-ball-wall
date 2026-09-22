"""Clearance between the ball / string and the walls.

A wall is a slab x0 <= x <= x1, y <= h (it stands on the floor, so only the
top face and the two side faces matter).

* `sdf_smooth`   : smooth signed distance used as an NLP constraint (casadi).
* `ball_clearance`, `string_clearance` : exact values used to verify a
  simulated trajectory (numpy, vectorised over time samples).
"""

from __future__ import annotations

import numpy as np

from .params import Scene, Wall


def sdf_smooth(px, py, cx, hw, h, lib, eps=1e-3):
    """Smoothed signed distance from (px, py) to a semi-infinite slab."""
    sabs = lambda a: lib.sqrt(a * a + eps * eps)
    smax = lambda a, b: 0.5 * (a + b + sabs(a - b))
    smin = lambda a, b: 0.5 * (a + b - sabs(a - b))
    qx = sabs(px - cx) - hw
    qy = py - h
    outside = lib.sqrt(smax(qx, 0) ** 2 + smax(qy, 0) ** 2 + eps * eps)
    inside = smin(smax(qx, qy), 0)
    return outside + inside


def sdf(px, py, wall: Wall):
    """Exact signed distance from points to the slab (negative inside)."""
    qx = np.abs(px - wall.cx) - wall.hw
    qy = py - wall.h
    outside = np.hypot(np.maximum(qx, 0), np.maximum(qy, 0))
    inside = np.minimum(np.maximum(qx, qy), 0)
    return outside + inside


def ball_clearance(bx, by, wall: Wall, r: float):
    """Gap between the ball surface and the wall (negative = penetration)."""
    return sdf(bx, by, wall) - r


def _point_segment_dist(cx, cy, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = ((cx - ax) * dx + (cy - ay) * dy) / np.maximum(dx * dx + dy * dy, 1e-300)
    t = np.clip(t, 0.0, 1.0)
    return np.hypot(ax + t * dx - cx, ay + t * dy - cy)


def string_clearance(ax, ay, bx, by, wall: Wall):
    """Exact distance between segment A-B and the slab.

    Negative values give how far the segment dips below the wall top inside
    the wall's x-range (penetration depth).  For a non-intersecting segment
    the minimum distance to a convex slab is attained at a segment endpoint
    or at one of the slab's two top corners.
    """
    ax, ay, bx, by = map(np.asarray, (ax, ay, bx, by))
    dx = bx - ax
    # y of the segment at the two wall faces, restricted to the segment span
    lo = np.minimum(ax, bx)
    hi = np.maximum(ax, bx)
    xa = np.clip(wall.x0, lo, hi)
    xb = np.clip(wall.x1, lo, hi)
    overlap = (hi >= wall.x0) & (lo <= wall.x1)
    safe_dx = np.where(np.abs(dx) < 1e-12, 1.0, dx)
    y_at = lambda xq: np.where(np.abs(dx) < 1e-12, np.minimum(ay, by), ay + (by - ay) * (xq - ax) / safe_dx)
    y_min = np.minimum(y_at(xa), y_at(xb))
    penetration = np.where(overlap & (y_min < wall.h), y_min - wall.h, np.inf)

    d = np.minimum(sdf(ax, ay, wall), sdf(bx, by, wall))
    for cx in (wall.x0, wall.x1):
        d = np.minimum(d, _point_segment_dist(cx, wall.h, ax, ay, bx, by))
    return np.where(np.isfinite(penetration), penetration, d)


def clearances(x, th, scene: Scene, L: float):
    """Per-wall ball and string clearances for trajectories x(t), th(t)."""
    bx, by = scene.ball_pos(x, th, L, np)
    ay = np.full_like(x, scene.rail_y)
    ball = np.stack([ball_clearance(bx, by, w, scene.ball_r) for w in scene.walls])
    string = np.stack([string_clearance(x, ay, bx, by, w) for w in scene.walls])
    return ball, string
