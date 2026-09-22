"""Closed-loop simulation with robustness perturbations.

Mirrors ballwall.simulate.simulate (TVLQR at the plan rate, ZOH, saturation at
F_limit, stationary goal LQR during the hold, DOP853) and adds:

  * true-plant parameter changes (any Plant field, incl. L)
  * Coulomb trolley friction  F_c * tanh(v / 1e-3)
  * pure actuation delay d  (force computed at t_k acts on [t_k+d, t_{k+1}+d))
  * first-order force lag   tau * dFa/dt = u - Fa   (Fa is the force on the trolley)
  * Gaussian state-measurement noise fed to the controller

Evaluation on a 1 kHz grid plus the left limit of every integration segment,
with clearance computed using the TRUE string length and tension from the
TRUE plant with the actual (effective) force on the trolley.
"""
from __future__ import annotations

import math
import pickle
import sys
from dataclasses import dataclass, replace
from pathlib import Path

import numpy as np
from scipy.integrate import solve_ivp

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from ballwall.control import goal_lqr, tvlqr
from ballwall.dynamics import accel, tension
from ballwall.geometry import clearances
from ballwall.params import Plant, Scene
from ballwall.search import mission_scene

HERE = ROOT / "out" / "robustness"  # plan pickles (from exact.py) and results
EPS_C = 1e-3
NOISE_SIGMA = np.array([1e-3, math.radians(0.2), 1e-2, math.radians(1.0)])
RUNS = [("enter", "fast"), ("escape", "fast"), ("enter", "pump"), ("escape", "pump")]
V_MAX = 4.0

_plans = {}


def load_plan(mission, preset):
    key = (mission, preset)
    if key not in _plans:
        with open(HERE / f"plan_{mission}_{preset}.pkl", "rb") as f:
            _plans[key] = pickle.load(f)
    return _plans[key]


@dataclass(frozen=True)
class Pert:
    dL: float = 0.0  # relative
    dM: float = 0.0
    dm: float = 0.0
    b_scale: float = 1.0
    Fc: float = 0.0  # Coulomb friction [N]
    delay: float = 0.0  # [s]
    tau: float = 0.0  # force lag [s]
    noise_seed: int | None = None  # None: no measurement noise
    noise_scale: float = 1.0


def true_plant(pt: Pert) -> Plant:
    p = Plant()
    return replace(p, L=p.L * (1 + pt.dL), M=p.M * (1 + pt.dM), m=p.m * (1 + pt.dm), b=p.b * pt.b_scale)


def _make_rhs(p: Plant, Fc: float, tau: float):
    M, m, L, g, b, c = p.M, p.m, p.L, p.g, p.b, p.c

    def acc(v, th, w, F):
        sn, cs = math.sin(th), math.cos(th)
        Fe = F - Fc * math.tanh(v / EPS_C) if Fc else F
        a12 = m * L * cs
        a22 = m * L * L
        r1 = Fe - b * v + m * L * w * w * sn
        r2 = -m * g * L * sn - c * w
        det = m * L * L * (M + m * sn * sn)
        return (a22 * r1 - a12 * r2) / det, ((M + m) * r2 - a12 * r1) / det

    if tau > 0:  # analytic first-order lag: Fa(t) = u + (Fa0 - u) exp(-(t - ta)/tau)
        def f(t, y, u, fa0, ta):
            Fa = u + (fa0 - u) * math.exp(-(t - ta) / tau)
            xdd, thdd = acc(y[1], y[2], y[3], Fa)
            return [y[1], xdd, y[3], thdd]
    else:
        def f(_t, y, u, fa0, ta):
            xdd, thdd = acc(y[1], y[2], y[3], u)
            return [y[1], xdd, y[3], thdd]
    return f


def simulate(mission, preset, pt: Pert, hold=2.5, F_limit=40.0, rtol=1e-10, atol=1e-12, grid_hz=1000):
    nominal = load_plan(mission, preset)
    scene = mission_scene(Scene(), mission)
    pm = Plant()
    p = true_plant(pt)
    dt = nominal.dt
    s_goal = np.array([scene.x_goal, 0.0, 0.0, 0.0])
    K_inf, P_inf = goal_lqr(pm, s_goal, dt)
    K = tvlqr(nominal, P_inf)
    N = len(nominal.U)
    n_hold = int(round(hold / dt))
    n_tot = N + n_hold
    t_knots = np.arange(n_tot + 1) * dt
    t_final = t_knots[-1]
    rng = np.random.default_rng(pt.noise_seed) if pt.noise_seed is not None else None
    f = _make_rhs(p, pt.Fc, pt.tau)
    lag = pt.tau > 0

    q = int(math.floor(pt.delay / dt + 1e-9))
    r = pt.delay - q * dt
    if r < 1e-12:
        r = 0.0

    grid = np.linspace(0, t_final, int(round(t_final * grid_hz)) + 1)
    y = nominal.X[:, 0].copy()
    fa = 0.0  # force acting on the trolley (lag state)
    u_hist = np.zeros(n_tot)
    ts, Ys, Fs = [], [], []  # grid samples: time, state, applied force (command reaching the actuator)
    tl, Yl, Fl = [], [], []  # segment left limits
    gi = 0

    def u_at(j):
        return u_hist[j] if j >= 0 else 0.0

    for k in range(n_tot):
        s = y[:4]
        s_meas = s + (pt.noise_scale * NOISE_SIGMA * rng.standard_normal(4) if rng is not None else 0.0)
        if k < N:
            u = nominal.U[k] - (K[k] @ (s_meas - nominal.X[:, k])).item()
        else:
            u = -(K_inf @ (s_meas - s_goal)).item()
        if F_limit is not None:
            u = float(np.clip(u, -F_limit, F_limit))
        u_hist[k] = u
        # segments inside [t_k, t_{k+1}): command reaching the actuator
        segs = []
        if r > 0:
            segs.append((t_knots[k], t_knots[k] + r, u_at(k - q - 1)))
            segs.append((t_knots[k] + r, t_knots[k + 1], u_at(k - q)))
        else:
            segs.append((t_knots[k], t_knots[k + 1], u_at(k - q)))
        last = k == n_tot - 1
        for (ta, tb, ua) in segs:
            j0 = gi
            while gi < len(grid) and (grid[gi] < tb or (last and grid[gi] <= tb + 1e-12)):
                gi += 1
            te = grid[j0:gi]
            te = te[(te >= ta - 1e-12)]
            te = np.clip(te, ta, tb)
            sol = solve_ivp(f, (ta, tb), y, method="DOP853", rtol=rtol, atol=atol, dense_output=True,
                            args=(ua, fa, ta))
            if not sol.success:
                raise RuntimeError(sol.message)
            fa_of = (lambda tt, ua=ua, fa0=fa, ta=ta: ua + (fa0 - ua) * np.exp(-(tt - ta) / pt.tau)) if lag \
                else (lambda tt, ua=ua: np.full(np.size(tt), ua))
            if te.size:
                ts.append(te)
                Ys.append(sol.sol(te))
                Fs.append(fa_of(te))
            y = sol.y[:, -1].copy()
            fa = float(fa_of(np.array([tb]))[0])
            tl.append(tb)
            Yl.append(y.copy())
            Fl.append(fa)
    t = np.concatenate(ts)
    Y = np.concatenate(Ys, axis=1)
    Fcmd = np.concatenate(Fs)
    Yl = np.array(Yl).T
    Fl = np.array(Fl)
    return evaluate(t, Y, Fcmd, np.array(tl), Yl, Fl, p, pt, scene, nominal.t[-1], u_hist, lag)


def rest_error(s, x_goal, p: Plant):
    x, v, th, w = s[:4]
    return {"x_error_mm": float(1e3 * abs(x - x_goal)), "angle_deg": float(np.degrees(abs(th))),
            "ball_speed_mps": float(np.hypot(v + p.L * np.cos(th) * w, p.L * np.sin(th) * w))}


def evaluate(t, Y, Fcmd, tl, Yl, Fl, p, pt, scene, T, u_hist, lag):
    S = Y[:4]
    Fa, Fa_l = Fcmd, Fl  # force acting on the trolley (after lag, before friction)
    fe = lambda S_, F_: F_ - pt.Fc * np.tanh(S_[1] / EPS_C) if pt.Fc else F_
    ten = tension(S, fe(S, Fa), p)
    ten_l = tension(Yl[:4], fe(Yl[:4], Fa_l), p)
    cb, cs = clearances(S[0], S[2], scene, p.L)
    # the same clearances at segment left limits (states only, cheap)
    cbl, csl = clearances(Yl[0], Yl[2], scene, p.L)
    cb_all = min(cb.min(), cbl.min())
    cs_all = min(cs.min(), csl.min())
    iT = int(np.argmin(np.abs(t - T)))
    wi, ti = np.unravel_index(np.argmin(cb), cb.shape)
    bx, by = scene.ball_pos(S[0, ti], S[2, ti], p.L, np)
    wl = scene.walls[wi]
    face = "top" if by >= wl.h else ("left face" if bx < wl.x0 else ("right face" if bx > wl.x1 else "inside"))
    ws, ts_ = np.unravel_index(np.argmin(cs), cs.shape)
    out = {
        "min_ball_clear": float(cb_all),
        "min_ball_clear_wall": int(np.argmin(np.minimum(cb.min(axis=1), cbl.min(axis=1)))),
        "t_min_ball_clear": float(t[np.unravel_index(np.argmin(cb), cb.shape)[1]]),
        "contact": {"wall": "AB"[wi], "face": face, "t": float(t[ti]), "ball_xy": [float(bx), float(by)],
                    "trolley_x": float(S[0, ti]), "theta_deg": float(np.degrees(S[2, ti]))},
        "string_min_at": {"wall": "AB"[ws], "t": float(t[ts_])},
        "t_x_min": float(t[np.argmin(S[0])]),
        "min_string_clear": float(cs_all),
        "min_tension": float(min(ten.min(), ten_l.min())),
        "t_min_tension": float(t[np.argmin(ten)]) if ten.min() <= ten_l.min() else float(tl[np.argmin(ten_l)]),
        "peak_force": float(np.abs(u_hist).max()),
        "n_saturated": int(np.sum(np.abs(u_hist) >= 40.0 - 1e-9)),
        "x_min": float(min(S[0].min(), Yl[0].min())),
        "x_max": float(max(S[0].max(), Yl[0].max())),
        "peak_speed": float(max(np.abs(S[1]).max(), np.abs(Yl[1]).max())),
        "at_T": rest_error(S[:, iT], scene.x_goal, p),
        "after_hold": rest_error(Yl[:4, -1], scene.x_goal, p),
    }
    out["collision_free"] = out["min_ball_clear"] > 0 and out["min_string_clear"] > 0
    out["taut"] = out["min_tension"] > 0
    out["within_rail"] = scene.x_min <= out["x_min"] and out["x_max"] <= scene.x_max
    out["within_speed"] = out["peak_speed"] <= V_MAX + 1e-3
    out["ok"] = out["collision_free"] and out["taut"] and out["within_rail"] and out["within_speed"]
    ah = out["after_hold"]
    out["settled"] = ah["x_error_mm"] < 5.0 and ah["angle_deg"] < 0.5
    return out
