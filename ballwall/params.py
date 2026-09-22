"""Physical and scene parameters (SI units: m, kg, s, N).

Coordinate frame (side view):
    x  : horizontal along the rail, positive to the right
    y  : vertical, positive up, floor at y = 0
    th : string angle from the downward vertical, positive when the ball
         is ahead of the trolley (+x side)
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Plant:
    M: float = 2.0  # trolley mass [kg]
    m: float = 1.0  # ball mass [kg]
    L: float = 1.0  # pivot -> ball centre [m]
    g: float = 9.81  # [m/s^2]
    b: float = 0.3  # trolley viscous friction [N s/m]
    c: float = 0.002  # pivot viscous damping [N m s/rad]


@dataclass(frozen=True)
class Wall:
    x0: float  # left face
    x1: float  # right face
    h: float  # top height (walls stand on the floor)

    @property
    def cx(self) -> float:
        return 0.5 * (self.x0 + self.x1)

    @property
    def hw(self) -> float:
        return 0.5 * (self.x1 - self.x0)


@dataclass(frozen=True)
class Scene:
    rail_y: float = 1.25  # pivot height [m]
    ball_r: float = 0.06  # ball radius [m]
    walls: tuple[Wall, ...] = field(
        default_factory=lambda: (Wall(1.30, 1.42, 0.75), Wall(1.84, 1.96, 0.75))
    )
    x_start: float = 0.0  # trolley position at rest, start of the manoeuvre
    x_goal: float = 1.63  # trolley position at rest, end (default: centre of the gap)
    x_min: float = -1.0  # rail travel limits
    x_max: float = 3.2

    def ball_pos(self, x, th, L, lib):
        return x + L * lib.sin(th), self.rail_y - L * lib.cos(th)
