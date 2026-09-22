"""Cart (trolley) + point-mass pendulum on a massless string.

State s = [x, v, th, w]  (trolley position/velocity, string angle/rate).
Input  F  = horizontal force on the trolley [N].

Lagrange equations:
    (M+m) x'' + m L cos(th) th'' - m L w^2 sin(th) = F - b v
    m L cos(th) x'' + m L^2 th''  + m g L sin(th)  = -c w

Every function takes a `lib` argument (numpy or casadi) so the planner and the
simulator share exactly the same equations.
"""

from __future__ import annotations

import numpy as np

from .params import Plant


def accel(s, F, p: Plant, lib=np):
    """Return (x'', th'') from the closed-form 2x2 mass-matrix solve."""
    v, th, w = s[1], s[2], s[3]
    sn, cs = lib.sin(th), lib.cos(th)
    a12 = p.m * p.L * cs
    a22 = p.m * p.L**2
    r1 = F - p.b * v + p.m * p.L * w**2 * sn
    r2 = -p.m * p.g * p.L * sn - p.c * w
    det = p.m * p.L**2 * (p.M + p.m * sn**2)
    xdd = (a22 * r1 - a12 * r2) / det
    thdd = ((p.M + p.m) * r2 - a12 * r1) / det
    return xdd, thdd


def rhs(s, F, p: Plant, lib=np):
    xdd, thdd = accel(s, F, p, lib)
    if lib is np:
        return np.array([s[1], xdd, s[3], thdd])
    return lib.vertcat(s[1], xdd, s[3], thdd)


def tension(s, F, p: Plant, lib=np):
    """String tension [N]. A real string stays taut only while this is > 0."""
    xdd, _ = accel(s, F, p, lib)
    th, w = s[2], s[3]
    return p.m * (p.g * lib.cos(th) + p.L * w**2 - xdd * lib.sin(th))


def energy(s, p: Plant):
    x, v, th, w = s
    kin = 0.5 * (p.M + p.m) * v**2 + p.m * p.L * v * w * np.cos(th) + 0.5 * p.m * p.L**2 * w**2
    return kin + p.m * p.g * p.L * (1.0 - np.cos(th))


def linearize(s, F, p: Plant, eps=1e-6):
    """Continuous-time Jacobians (A, B) by central differences."""
    s = np.asarray(s, float)
    A = np.zeros((4, 4))
    for i in range(4):
        d = np.zeros(4)
        d[i] = eps
        A[:, i] = (rhs(s + d, F, p) - rhs(s - d, F, p)) / (2 * eps)
    B = ((rhs(s, F + eps, p) - rhs(s, F - eps, p)) / (2 * eps)).reshape(4, 1)
    return A, B
