"""LQR gains: time-varying along the planned trajectory, stationary at the goal."""

from __future__ import annotations

import numpy as np
from scipy.linalg import expm, solve_discrete_are

from .dynamics import linearize
from .params import Plant
from .planner import Plan

Q_DEFAULT = np.diag([40.0, 4.0, 80.0, 4.0])
R_DEFAULT = np.array([[0.05]])


def c2d(A, B, dt):
    """Exact zero-order-hold discretisation."""
    n, m = B.shape
    Mx = np.zeros((n + m, n + m))
    Mx[:n, :n] = A
    Mx[:n, n:] = B
    E = expm(Mx * dt)
    return E[:n, :n], E[:n, n:]


def goal_lqr(plant: Plant, s_goal, dt, Q=Q_DEFAULT, R=R_DEFAULT):
    """Discrete infinite-horizon LQR about the hanging equilibrium."""
    A, B = c2d(*linearize(s_goal, 0.0, plant), dt)
    P = solve_discrete_are(A, B, Q, R)
    K = np.linalg.solve(R + B.T @ P @ B, B.T @ P @ A)
    return K, P


def tvlqr(plan: Plan, P_final, Q=Q_DEFAULT, R=R_DEFAULT):
    """Backward Riccati recursion along the nominal -> gains K[k], shape (N, 1, 4)."""
    N = len(plan.U)
    K = np.zeros((N, 1, 4))
    P = P_final
    for k in range(N - 1, -1, -1):
        A, B = plan.A[k], plan.B[k]
        K[k] = np.linalg.solve(R + B.T @ P @ B, B.T @ P @ A)
        P = Q + A.T @ P @ (A - B @ K[k])
        P = 0.5 * (P + P.T)
    return K
