"""High-accuracy closed-loop simulation.

The controller runs at the planner's rate with a zero-order hold, exactly as a
digital crane controller would.  Between samples the continuous nonlinear
plant is integrated with DOP853 at tight tolerances, and each interval keeps
its dense output so the trajectory can be evaluated at any time.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.integrate import solve_ivp

from .control import goal_lqr, tvlqr
from .dynamics import accel, energy, rhs, tension
from .params import Plant, Scene
from .planner import Plan


@dataclass
class SimResult:
    t_knots: np.ndarray  # controller sample times
    F: np.ndarray  # force held on each interval
    pieces: list  # dense-output interpolants, one per interval
    plant: Plant
    t_end_plan: float

    def sample(self, t):
        """States at arbitrary times t (array) -> shape (4, len(t))."""
        t = np.asarray(t, float)
        idx = np.clip(np.searchsorted(self.t_knots, t, side="right") - 1, 0, len(self.pieces) - 1)
        out = np.empty((4, t.size))
        for k in np.unique(idx):
            sel = idx == k
            out[:, sel] = self.pieces[k](t[sel])
        return out

    def force(self, t):
        t = np.asarray(t, float)
        idx = np.clip(np.searchsorted(self.t_knots, t, side="right") - 1, 0, len(self.F) - 1)
        return self.F[idx]

    def knot_left_limits(self):
        """States at the end of every hold interval, with the force held over it.

        The force steps at each knot, so quantities that depend on it (string
        tension, trolley acceleration) have a left limit that a time grid
        containing the knots never samples.
        """
        tk = self.t_knots[1:]
        S = np.column_stack([piece(t) for piece, t in zip(self.pieces, tk)])
        return tk, S, self.F

    @property
    def t_final(self) -> float:
        return float(self.t_knots[-1])


def simulate(plan: Plan, plant_true: Plant, plant_model: Plant, scene: Scene, hold: float = 3.0,
             F_limit: float | None = None, s0=None, rtol=1e-10, atol=1e-12) -> SimResult:
    """Track `plan` with TVLQR, then hold the goal with stationary LQR.

    plant_model : parameters the controller was designed with
    plant_true  : parameters of the simulated plant (set different to test robustness)
    """
    dt = plan.dt
    s_goal = np.array([scene.x_goal, 0.0, 0.0, 0.0])
    K_inf, P_inf = goal_lqr(plant_model, s_goal, dt)
    K = tvlqr(plan, P_inf)
    N = len(plan.U)
    n_hold = int(round(hold / dt))

    s = plan.X[:, 0].copy() if s0 is None else np.asarray(s0, float)
    t_knots = np.arange(N + n_hold + 1) * dt
    F_hist = np.empty(N + n_hold)
    pieces = []
    for k in range(N + n_hold):
        if k < N:
            u = plan.U[k] - (K[k] @ (s - plan.X[:, k])).item()
        else:
            u = -(K_inf @ (s - s_goal)).item()
        if F_limit is not None:
            u = float(np.clip(u, -F_limit, F_limit))
        F_hist[k] = u
        sol = solve_ivp(lambda _t, y: rhs(y, u, plant_true), (t_knots[k], t_knots[k + 1]), s,
                        method="DOP853", rtol=rtol, atol=atol, dense_output=True)
        pieces.append(sol.sol)
        s = sol.y[:, -1]
    return SimResult(t_knots=t_knots, F=F_hist, pieces=pieces, plant=plant_true, t_end_plan=plan.t[-1])


def derived(res: SimResult, t):
    """Useful signals on a time grid: states, force, tension, ball position, energy."""
    S = res.sample(t)
    F = res.force(t)
    p = res.plant
    ten = tension(S, F, p)
    xdd, _ = accel(S, F, p)
    return {"t": t, "S": S, "F": F, "tension": ten, "xdd": xdd, "E": energy(S, p)}
