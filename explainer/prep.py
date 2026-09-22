"""Data for the explainer video's Manim scenes -> explainer/data/*.json.

Everything plotted in the video comes from the real planner / simulator:
    shooting.json  IPOPT iterates of a small multiple-shooting problem (gaps closing)
    homotopy.json  enter/fast solved while the walls are raised step by step
    localopt.json  escape/fast: continuation-only optimum vs the stored seed
    tvlqr.json     enter/fast with a 5 % heavier ball: open loop vs TVLQR
    tension.json   string tension along the enter/fast nominal

Needs the four default runs in out/ (uv run python -m ballwall ...).
Run: uv run python explainer/prep.py
"""

from __future__ import annotations

import json
import sys
from dataclasses import replace
from pathlib import Path

import casadi as ca
import numpy as np
from scipy.integrate import solve_ivp

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from ballwall.__main__ import PRESETS  # noqa: E402
from ballwall.control import goal_lqr  # noqa: E402
from ballwall.control import tvlqr as tv  # noqa: E402
from ballwall.dynamics import rhs, tension  # noqa: E402
from ballwall.geometry import clearances  # noqa: E402
from ballwall.params import Plant, Scene, Wall  # noqa: E402
from ballwall.planner import Plan, plan, rk4_step  # noqa: E402
from ballwall.search import mission_scene  # noqa: E402
from ballwall.simulate import derived, simulate  # noqa: E402

OUT = Path(__file__).parent / "data"
P, BASE = Plant(), Scene()


def r(a, n=4):
    return np.round(np.asarray(a, float), n).tolist()


def load_plan(mission: str, preset: str) -> Plan:
    z = np.load(ROOT / "out" / mission / preset / "plan.npz")
    return with_jacobians(z["t"], z["X"], z["U"], preset)


def with_jacobians(t, X, U, preset) -> Plan:
    cfg = PRESETS[preset]
    N, dt = len(U), cfg.T / cfg.N
    step = rk4_step(P, dt, cfg.substeps)
    s, u = ca.SX.sym("s", 4), ca.SX.sym("u")
    z = step(s, u)
    jac = ca.Function("j", [s, u], [ca.jacobian(z, s), ca.jacobian(z, u)])
    Aa, Ba = jac.map(N)(X[:, :-1], U[None, :])
    return Plan(t=t, X=X, U=U, dt=dt, A=np.asarray(Aa).reshape(4, N, 4).transpose(1, 0, 2),
                B=np.asarray(Ba).reshape(4, N, 1).transpose(1, 0, 2), stats={})


def ball(X, scene=BASE):
    bx, by = scene.ball_pos(X[0], X[2], P.L, np)
    return bx, by


def shooting():
    """Rest-to-rest transfer (no walls) with 12 shooting intervals; keep every IPOPT iterate."""
    T, N, sub = 4.0, 12, 8
    dt = T / N
    step = rk4_step(P, dt, 4)
    fine = rk4_step(P, dt / sub, 1)
    opti = ca.Opti()
    X, U = opti.variable(4, N + 1), opti.variable(1, N)
    opti.subject_to(X[:, 0] == [0, 0, 0, 0])
    opti.subject_to(X[:, N] == [1.63, 0, 0, 0])
    opti.subject_to(X[:, 1:] == step.map(N)(X[:, :-1], U))
    opti.subject_to(opti.bounded(-40, U, 40))
    opti.minimize(dt * ca.sumsqr(U))
    # a deliberately crude guess: trolley positions on a straight line, everything else zero
    opti.set_initial(X[0, :], np.linspace(0, 1.63, N + 1))
    iters = []

    def grab(_i):
        Xv = np.asarray(opti.debug.value(X))
        Uv = np.asarray(opti.debug.value(U)).ravel()
        arcs = []
        for k in range(N):
            s = Xv[:, k].copy()
            pts = [s.copy()]
            for _ in range(sub):
                s = np.asarray(fine(s, Uv[k])).ravel()
                pts.append(s.copy())
            arcs.append(np.array(pts))
        defect = max(np.abs(a[-1] - Xv[:, k + 1]).max() for k, a in enumerate(arcs))
        iters.append({"X": r(Xv[[0, 2]]), "U": r(Uv),
                      "arcs": [r(a[:, [0, 2]].T) for a in arcs], "defect": float(defect)})

    opti.callback(grab)
    opti.solver("ipopt", {"ipopt.print_level": 0, "ipopt.sb": "yes", "print_time": False})
    opti.solve()
    return {"T": T, "N": N, "iters": iters}


def homotopy():
    cfg = PRESETS["fast"]
    out, prev = [], None
    for a in (0.4, 0.55, 0.7, 0.85, 1.0):
        sc = replace(BASE, walls=tuple(Wall(w.x0, w.x1, a * w.h) for w in BASE.walls))
        p = plan(P, sc, cfg, init=prev, continuation=False)
        bx, by = ball(p.X)
        out.append({"scale": a, "bx": r(bx[::2]), "by": r(by[::2]), "x": r(p.X[0, ::2]),
                    "peak": p.stats["peak_force"], "iters": p.stats["iterations"][0]})
        print(f"  homotopy {a:.2f}: peak {p.stats['peak_force']:.1f} N, {p.stats['iterations']} iters")
        prev = p
    return {"h": [w.h for w in BASE.walls], "steps": out}


def localopt():
    f = ROOT / "paper" / "cache" / "escape_fast_continuation.npz"  # shared with paper/make_figs.py
    if not f.exists():
        f.parent.mkdir(parents=True, exist_ok=True)
        p = plan(P, mission_scene(BASE, "escape"), PRESETS["fast"])
        np.savez(f, t=p.t, X=p.X, U=p.U, objective=p.stats["objective"])
    z = np.load(f)
    seed = np.load(ROOT / "out" / "escape" / "fast" / "plan.npz")
    res = {}
    for key, d, J in (("continuation", z, float(z["objective"])), ("seed", seed, None)):
        bx, by = ball(d["X"])
        res[key] = {"t": r(d["t"]), "bx": r(bx), "by": r(by), "x": r(d["X"][0]), "th": r(d["X"][2]),
                    "U": r(d["U"], 3), "peak": float(np.abs(d["U"]).max()), "J": J}
    rep = json.loads((ROOT / "out" / "escape" / "fast" / "report.json").read_text())
    res["seed"]["J"] = rep["plan"]["objective"]
    return res


def tvlqr():
    """Same nominal, a plant whose ball is 5 % heavier than the model."""
    nominal = load_plan("enter", "fast")
    true = replace(P, m=P.m * 1.05)
    fps, t_end = 30, 5.5
    tg = np.linspace(0, t_end, int(t_end * fps) + 1)
    # open loop: replay the planned force, then zero force
    s = nominal.X[:, 0].copy()
    t_knots = np.arange(int(round(t_end / nominal.dt)) + 1) * nominal.dt
    pieces = []
    for k in range(len(t_knots) - 1):
        u = nominal.U[k] if k < len(nominal.U) else 0.0
        sol = solve_ivp(lambda _t, y: rhs(y, u, true), (t_knots[k], t_knots[k + 1]), s,
                        method="DOP853", rtol=1e-10, atol=1e-12, dense_output=True)
        pieces.append(sol.sol)
        s = sol.y[:, -1]
    idx = np.clip(np.searchsorted(t_knots, tg, side="right") - 1, 0, len(pieces) - 1)
    S_open = np.column_stack([pieces[i](t) for i, t in zip(idx, tg)])
    res = simulate(nominal, true, P, BASE, hold=t_end - nominal.t[-1], F_limit=40.0)
    d = derived(res, tg)
    out = {"t": r(tg, 3), "fps": fps}
    for key, S_ in (("open", S_open), ("closed", d["S"])):
        cb, _ = clearances(S_[0], S_[2], BASE, true.L)
        bx, by = ball(S_)
        hit = np.nonzero(cb.min(axis=0) < 0)[0]
        out[key] = {"x": r(S_[0]), "th": r(S_[2]), "bx": r(bx), "by": r(by),
                    "clear": r(cb.min(axis=0)), "hit": int(hit[0]) if hit.size else None}
    out["F_closed"] = r(d["F"], 3)
    out["F_plan"] = r(np.interp(tg, nominal.t[:-1], nominal.U, right=0.0), 3)
    _, P_inf = goal_lqr(P, np.array([BASE.x_goal, 0, 0, 0]), nominal.dt)
    K = tv(nominal, P_inf)[:, 0, :]
    out["K"] = {"t": r(nominal.t[:-1:2], 3), "k": [r(K[::2, i], 3) for i in range(4)]}
    return out


def tension_series():
    p = load_plan("enter", "fast")
    ten = tension(p.X[:, :-1], p.U, P)
    return {"t": r(p.t[:-1], 3), "T": r(ten, 3), "U": r(p.U, 3), "th": r(p.X[2, :-1])}


def main():
    OUT.mkdir(exist_ok=True)
    jobs = {"shooting": shooting, "homotopy": homotopy, "localopt": localopt,
            "tvlqr": tvlqr, "tension": tension_series}
    only = sys.argv[1:] or list(jobs)
    for name in only:
        print(name)
        (OUT / f"{name}.json").write_text(json.dumps(jobs[name]()))


if __name__ == "__main__":
    main()
