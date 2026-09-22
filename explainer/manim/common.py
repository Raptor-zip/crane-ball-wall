"""Shared look and timing for the explainer's Manim scenes.

NarratedScene paces a scene on the narration: `self.cue(i)` waits until line
i of the scene starts (timeline.json, written by explainer/tts.py), and
`self.finish()` pads the clip to the scene's length, so every clip lines up
with its audio in Remotion.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from manim import (DOWN, LEFT, ORIGIN, RIGHT, UP, Circle, Line, MathTex, Rectangle, RoundedRectangle, Scene,
                   Text, TracedPath, ValueTracker, VGroup, VMobject, config, linear)

HERE = Path(__file__).resolve().parent
EXPL = HERE.parent
ROOT = EXPL.parent
DATA = EXPL / "data"
TIMELINE = json.loads((EXPL / "remotion" / "public" / "timeline.json").read_text())

config.background_color = "#101318"
config.tex_template.add_to_preamble(r"\usepackage{amsmath}\usepackage{bm}")

BG = "#101318"
PANEL = "#1a1f27"
TEXT = "#e8e6e3"
MUTED = "#8b929c"
GRID = "#2a313b"
BALL = "#ef4444"
TROLLEY = "#3b82f6"
STRING = "#cbd5e1"
FORCE = "#f59e0b"
BRICK = "#b4533a"
MORTAR = "#5b3326"
FLOOR = "#4b4338"
RAIL = "#6b7280"
OK = "#22c55e"
ANGLE = "#38bdf8"
PUMP = "#a78bfa"
FONT = "Noto Sans CJK JP"

# keep content inside this box: Remotion draws the chapter tag above and subtitles below
SAFE_TOP, SAFE_BOTTOM = 3.25, -2.55


def jp(s: str, size: float = 30, color: str = TEXT, weight: str = "NORMAL", **kw) -> Text:
    return Text(s, font=FONT, font_size=size, color=color, weight=weight, **kw)


def tex(s: str, size: float = 40, color: str = TEXT, **kw) -> MathTex:
    return MathTex(s, font_size=size, color=color, **kw)


def card(mob, pad=0.3, color=PANEL, stroke=GRID):
    box = RoundedRectangle(corner_radius=0.15, width=mob.width + 2 * pad, height=mob.height + 2 * pad,
                           fill_color=color, fill_opacity=1, stroke_color=stroke, stroke_width=1.5)
    box.move_to(mob)
    return VGroup(box, mob)


def traj(mission: str, preset: str) -> dict:
    d = json.loads((ROOT / "out" / mission / preset / "trajectory.json").read_text())
    return {k: np.asarray(d[k]) for k in ("t", "x", "theta", "F")} | {"t_plan": d["meta"]["t_plan"]}


def data(name: str) -> dict:
    return json.loads((DATA / f"{name}.json").read_text())


class NarratedScene(Scene):
    sid: str = ""

    def setup(self):
        tl = next(s for s in TIMELINE if s["id"] == self.sid)
        self.starts = [ln["start"] for ln in tl["lines"]]
        self.ends = [ln["end"] for ln in tl["lines"]]
        self.total = tl["duration"]

    @property
    def now(self) -> float:
        return self.renderer.time

    def cue(self, i: int, offset: float = 0.0):
        """Wait until line i (plus offset) starts."""
        target = self.starts[i] + offset
        if target - self.now > 1 / 60:
            self.wait(target - self.now)
        elif self.now - target > 0.2:
            print(f"[{self.sid}] line {i}: running {self.now - target:.2f} s late", file=sys.stderr)

    def until(self, i: int, offset: float = 0.0) -> float:
        """Seconds from now until line i (plus offset) starts; at least one frame."""
        return max(1 / 30, self.starts[i] + offset - self.now)

    def hold(self, d: float):
        if d > 1 / 60:
            self.wait(d)

    def span(self, i: int) -> float:
        return self.ends[i] - self.starts[i]

    def finish(self):
        if self.total - self.now > 1 / 60:
            self.wait(self.total - self.now)
        elif self.now > self.total + 0.05:
            print(f"[{self.sid}] {self.now - self.total:.2f} s longer than the narration", file=sys.stderr)


class Crane(VGroup):
    """Side view of the gantry crane in world metres, drawn at `k` units per metre.

    walls: list of (x0, x1, h).  `set_state(x, th)` moves trolley, string and ball.
    """

    def __init__(self, k=2.9, anchor=(0.4, 0.0), at=ORIGIN + DOWN * 1.6, xlim=(-1.45, 2.3),
                 walls=((1.30, 1.42, 0.75), (1.84, 1.96, 0.75)), rail_y=1.25, L=1.0, r=0.06,
                 rail=(-1.0, 3.2), ball_color=BALL, opacity=1.0, **kw):
        super().__init__(**kw)
        self.k, self.anchor, self.at = k, np.array(anchor), np.asarray(at, float)
        self.rail_y, self.L, self.r = rail_y, L, r
        self.floor = Line(self.w2s(xlim[0], 0), self.w2s(xlim[1], 0), color=FLOOR, stroke_width=6)
        self.walls = VGroup(*[self.make_wall(*w) for w in walls])
        lo, hi = max(rail[0], xlim[0]), min(rail[1], xlim[1])
        self.rail = Line(self.w2s(lo, rail_y), self.w2s(hi, rail_y), color=RAIL, stroke_width=5)
        self.stops = VGroup(*[Line(self.w2s(e, rail_y - 0.05), self.w2s(e, rail_y + 0.05), color=RAIL,
                                   stroke_width=5) for e in rail if xlim[0] <= e <= xlim[1]])
        self.trolley = Rectangle(width=0.22 * k, height=0.09 * k, fill_color=TROLLEY, fill_opacity=opacity,
                                 stroke_width=0)
        self.string = Line(ORIGIN, RIGHT, color=STRING, stroke_width=3, stroke_opacity=opacity)
        self.ball = Circle(radius=r * k, fill_color=ball_color, fill_opacity=opacity, stroke_width=0)
        self.scenery = VGroup(self.floor, self.walls, self.rail, self.stops)
        self.body = VGroup(self.string, self.trolley, self.ball)
        self.add(self.scenery, self.body)
        self.x, self.th = 0.0, 0.0
        self.set_state(0.0, 0.0)

    def w2s(self, x, y):
        return self.at + self.k * np.array([x - self.anchor[0], y - self.anchor[1], 0.0])

    def make_wall(self, x0, x1, h):
        g = VGroup()
        g.add(Rectangle(width=(x1 - x0) * self.k, height=h * self.k, fill_color=BRICK, fill_opacity=1,
                        stroke_width=0).move_to(self.w2s((x0 + x1) / 2, h / 2)))
        for y in np.arange(0.075, h - 1e-6, 0.075):
            g.add(Line(self.w2s(x0, y), self.w2s(x1, y), color=MORTAR, stroke_width=1.5))
        return g

    def pivot(self):
        return self.w2s(self.x, self.rail_y)

    def ball_world(self, x=None, th=None):
        x = self.x if x is None else x
        th = self.th if th is None else th
        return x + self.L * np.sin(th), self.rail_y - self.L * np.cos(th)

    def set_state(self, x, th):
        self.x, self.th = float(x), float(th)
        p = self.pivot()
        b = self.w2s(*self.ball_world())
        self.trolley.move_to(p + UP * 0.045 * self.k)
        self.string.put_start_and_end_on(p, b)
        self.ball.move_to(b)
        return self

    def path(self, x, th, color=BALL, width=3, opacity=1.0):
        bx, by = x + self.L * np.sin(th), self.rail_y - self.L * np.cos(th)
        m = VMobject(stroke_color=color, stroke_width=width, stroke_opacity=opacity)
        m.set_points_as_corners([self.w2s(a, b) for a, b in zip(bx, by)])
        return m

    def player(self, t, x, th):
        """ValueTracker driving the crane along a sampled trajectory."""
        vt = ValueTracker(float(t[0]))
        self.add_updater(lambda m: m.set_state(np.interp(vt.get_value(), t, x), np.interp(vt.get_value(), t, th)))
        return vt

    def trace(self, color=BALL, width=3, opacity=0.8):
        return TracedPath(self.ball.get_center, stroke_color=color, stroke_width=width, stroke_opacity=opacity)


def polyline(points, color=TEXT, width=3, opacity=1.0):
    m = VMobject(stroke_color=color, stroke_width=width, stroke_opacity=opacity)
    m.set_points_as_corners([np.array([p[0], p[1], 0.0]) for p in points])
    return m


__all__ = [n for n in dir() if not n.startswith("_")] + ["linear"]
