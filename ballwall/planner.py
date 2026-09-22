"""Trajectory optimisation between two rest states of the crane, e.g. swing
the ball over the first wall and park it in the gap between the two walls
("enter"), or start parked in the gap and get back out ("escape").

Direct multiple shooting (RK4, piecewise-constant force) solved with IPOPT.
Constraints: exact dynamics, rail limits, trolley speed, force bound, ball and
string clearance from every wall, and (optionally) positive string tension.
Clearance is enforced at the nodes and at the middle of every interval;
tension at the start, middle and end of every interval (it jumps with the
force at each node, so both one-sided values matter).

The non-convex wall constraints are reached by continuation: the walls start
low and are raised to their real height, warm-starting each solve.
"""

from __future__ import annotations

from dataclasses import dataclass

import casadi as ca
import numpy as np

from .dynamics import rhs, tension
from .geometry import sdf_smooth
from .params import Plant, Scene


@dataclass(frozen=True)
class PlanConfig:
    T: float = 10.0  # manoeuvre duration [s]
    N: int = 500  # control intervals
    objective: str = "effort"  # "effort": min ∫F² ; "peak": min w_peak·max|F| + ∫F² (both + w_smooth term)
    F_max: float = 40.0  # actuator limit [N]
    v_max: float = 4.0  # trolley speed limit [m/s]
    margin_ball: float = 0.02  # required ball-to-wall gap [m]
    margin_string: float = 0.02  # required string-to-wall gap [m]
    rail_margin: float = 0.03  # keep the planned trolley this far from the rail ends [m]
    tension_min: float | None = 1.5  # [N]; None = treat the string as a rigid rod
    w_smooth: float = 1e-3  # penalty on force rate (keeps the crane realistic)
    w_peak: float = 20.0  # weight of max|F| in the "peak" objective
    substeps: int = 2  # RK4 substeps per interval
    cont_start: float = 0.4  # continuation: first wall-height scale
    cont_step: float = 0.15  # initial increment of the wall-height scale
    max_wall_s: float = 300.0  # IPOPT wall-clock limit per solve [s]
    verbose: bool = False


@dataclass
class Plan:
    t: np.ndarray  # node times, shape (N+1,)
    X: np.ndarray  # states at nodes, shape (4, N+1)
    U: np.ndarray  # force per interval, shape (N,)
    dt: float
    A: np.ndarray  # discrete Jacobians, shape (N, 4, 4)
    B: np.ndarray  # shape (N, 4, 1)
    stats: dict


def rk4_step(plant: Plant, dt: float, substeps: int) -> ca.Function:
    s = ca.SX.sym("s", 4)
    u = ca.SX.sym("u")
    h = dt / substeps
    f = lambda z: rhs(z, u, plant, ca)
    z = s
    for _ in range(substeps):
        k1 = f(z)
        k2 = f(z + h / 2 * k1)
        k3 = f(z + h / 2 * k2)
        k4 = f(z + h * k3)
        z = z + h / 6 * (k1 + 2 * k2 + 2 * k3 + k4)
    return ca.Function("step", [s, u], [z])


def _clearance_fn(plant: Plant, scene: Scene, n_string: int) -> ca.Function:
    """g(s, heights) >= 0 when the ball and string clear every wall with margin."""
    s = ca.SX.sym("s", 4)
    hs = ca.SX.sym("h", len(scene.walls))
    x, th = s[0], s[2]
    bx, by = scene.ball_pos(x, th, plant.L, ca)
    # string sample points (the part near the pivot is always above the walls)
    lams = np.linspace(0.3, 1.0, n_string, endpoint=False)
    out = []
    for i, w in enumerate(scene.walls):
        out.append(sdf_smooth(bx, by, w.cx, w.hw, hs[i], ca) - scene.ball_r)
        for lam in lams:
            px = x + lam * (bx - x)
            py = scene.rail_y + lam * (by - scene.rail_y)
            out.append(sdf_smooth(px, py, w.cx, w.hw, hs[i], ca))
    return ca.Function("clear", [s, hs], [ca.vertcat(*out)])


def plan(plant: Plant, scene: Scene, cfg: PlanConfig, init: Plan | None = None,
         continuation: bool | None = None) -> Plan:
    """Solve for a nominal trajectory.

    init         : warm start (interpolated onto this plan's time grid).
    continuation : raise the walls gradually; default True without `init`,
                   False with it (a warm start is assumed to clear the walls).
    """
    N, dt = cfg.N, cfg.T / cfg.N
    step = rk4_step(plant, dt, cfg.substeps)
    n_string = 8
    clear = _clearance_fn(plant, scene, n_string)
    lb_one = np.r_[cfg.margin_ball, np.full(n_string, cfg.margin_string)]
    lb_clear = np.tile(lb_one, len(scene.walls))

    opti = ca.Opti()
    X = opti.variable(4, N + 1)
    U = opti.variable(1, N)
    H = opti.parameter(len(scene.walls))

    s0 = np.array([scene.x_start, 0, 0, 0])
    sg = np.array([scene.x_goal, 0, 0, 0])
    opti.subject_to(X[:, 0] == s0)
    opti.subject_to(X[:, N] == sg)
    opti.subject_to(X[:, 1:] == step.map(N)(X[:, :-1], U))
    opti.subject_to(opti.bounded(scene.x_min + cfg.rail_margin, X[0, :], scene.x_max - cfg.rail_margin))
    opti.subject_to(opti.bounded(-cfg.v_max, X[1, :], cfg.v_max))
    opti.subject_to(opti.bounded(-cfg.F_max, U, cfg.F_max))

    # mid-interval states: the first of the two RK4 substeps
    Xm = rk4_step(plant, dt / 2, max(1, cfg.substeps // 2)).map(N)(X[:, :-1], U)
    G = clear.map(N + 1)(X, ca.repmat(H, 1, N + 1))
    opti.subject_to(ca.vec(G) >= np.tile(lb_clear, N + 1))
    Gm = clear.map(N)(Xm, ca.repmat(H, 1, N))
    opti.subject_to(ca.vec(Gm) >= np.tile(lb_clear, N))

    if cfg.tension_min is not None:
        s_sym, u_sym = ca.SX.sym("s", 4), ca.SX.sym("u")
        ten = ca.Function("ten", [s_sym, u_sym], [tension(s_sym, u_sym, plant, ca)]).map(N)
        for Xs in (X[:, :-1], Xm, X[:, 1:]):
            opti.subject_to(ten(Xs, U) >= cfg.tension_min)

    # penalise force steps, including the steps up from and back to zero at the ends
    dU = ca.diff(ca.horzcat(0, U, 0), 1, 1)
    effort = dt * ca.sumsqr(U)
    smooth = cfg.w_smooth * ca.sumsqr(dU) / dt
    if cfg.objective == "peak":
        peak = opti.variable()
        opti.subject_to(opti.bounded(-peak, U, peak))
        opti.subject_to(peak >= 0)
        opti.minimize(cfg.w_peak * peak + effort + smooth)
    else:
        opti.minimize(effort + smooth)

    # ---- initial guess ----
    t = np.linspace(0, cfg.T, N + 1)
    if init is not None:
        ti = init.t / init.t[-1] * cfg.T
        opti.set_initial(X, np.vstack([np.interp(t, ti, init.X[i]) for i in range(4)]))
        tu = t[:-1]
        opti.set_initial(U, np.interp(tu, ti[:-1], init.U))
        if cfg.objective == "peak":
            opti.set_initial(peak, np.max(np.abs(init.U)))
    else:
        tau = t / cfg.T
        sm = tau**3 * (10 - 15 * tau + 6 * tau**2)
        xg = scene.x_start + (scene.x_goal - scene.x_start) * sm
        opti.set_initial(X[0, :], xg)
        opti.set_initial(X[1, :], np.gradient(xg, t))

    opts = {"ipopt.max_iter": 5000, "ipopt.max_wall_time": cfg.max_wall_s, "ipopt.tol": 1e-8,
            "ipopt.acceptable_tol": 1e-6, "ipopt.mu_strategy": "adaptive", "print_time": False}
    if not cfg.verbose:
        opts["ipopt.print_level"] = 0
        opts["ipopt.sb"] = "yes"
    opti.solver("ipopt", opts)

    # Continuation on wall height.  A failed step is retried from the last
    # good solution with half the increment; a success enlarges it again.
    heights = np.array([w.h for w in scene.walls])
    a_ok, da = None, cfg.cont_step
    if continuation is None:
        continuation = init is None
    a = cfg.cont_start if continuation else 1.0
    sol, warm, iters = None, None, []
    while True:
        opti.set_value(H, a * heights)
        if warm is not None:
            opti.set_initial(warm[0])
            opti.set_initial(opti.lam_g, warm[1])
        try:
            sol = opti.solve()
        except RuntimeError as e:
            if a_ok is None or da < 0.005:
                raise RuntimeError(f"planner failed at wall scale {a:.3f}: "
                                   f"{opti.stats()['return_status']}") from e
            da /= 2
            a = min(1.0, a_ok + da)
            continue
        iters.append(sol.stats()["iter_count"])
        warm = (sol.value_variables(), sol.value(opti.lam_g))
        if a >= 1.0:
            break
        a_ok, da = a, min(1.5 * da, cfg.cont_step)
        a = min(1.0, a + da)

    Xv = np.asarray(sol.value(X))
    Uv = np.asarray(sol.value(U)).ravel()

    # discrete Jacobians along the nominal, for time-varying LQR
    s_sym, u_sym = ca.SX.sym("s", 4), ca.SX.sym("u")
    z = step(s_sym, u_sym)
    jac = ca.Function("step_jac", [s_sym, u_sym], [ca.jacobian(z, s_sym), ca.jacobian(z, u_sym)])
    Aa, Ba = jac.map(N)(Xv[:, :-1], Uv[None, :])
    A = np.asarray(Aa).reshape(4, N, 4).transpose(1, 0, 2)
    B = np.asarray(Ba).reshape(4, N, 1).transpose(1, 0, 2)

    stats = {"status": sol.stats()["return_status"], "iterations": iters,
             "objective": float(sol.value(opti.f)),
             "effort": float(dt * np.sum(Uv**2)), "peak_force": float(np.max(np.abs(Uv)))}
    return Plan(t=t, X=Xv, U=Uv, dt=dt, A=A, B=B, stats=stats)


def time_reversed(p: Plan, plant: Plant) -> Plan:
    """The same path traversed backwards: x(T-t), -v(T-t), th(T-t), -w(T-t).

    The equations of motion are time-reversible except for the friction
    terms.  Trolley friction is compensated exactly (F_r = F - 2 b v); the
    tiny pivot damping cannot be (the pivot is unactuated), so the result is
    a near-feasible warm start rather than an exact solution.
    """
    X = p.X[:, ::-1].copy()
    X[1] *= -1
    X[3] *= -1
    v_mid = 0.5 * (p.X[1, :-1] + p.X[1, 1:])
    U = (p.U - 2 * plant.b * v_mid)[::-1].copy()
    return Plan(t=p.t.copy(), X=X, U=U, dt=p.dt, A=None, B=None, stats={})


def replan(plant: Plant, scene: Scene, cfg: PlanConfig, init: Plan) -> Plan:
    """Re-solve with a different config (e.g. objective) warm-started from `init`."""
    return plan(plant, scene, cfg, init=init)
