import numpy as np
from dataclasses import replace
from scipy.integrate import solve_ivp

from ballwall.dynamics import accel, energy, rhs, tension
from ballwall.geometry import sdf, string_clearance
from ballwall.params import Plant, Wall

LOSSLESS = replace(Plant(), b=0.0, c=0.0)


def test_energy_conserved_without_force_or_friction():
    s0 = np.array([0.0, 0.7, 2.0, -1.0])
    sol = solve_ivp(lambda _t, y: rhs(y, 0.0, LOSSLESS), (0, 10), s0,
                    method="DOP853", rtol=1e-11, atol=1e-12)
    E = energy(sol.y, LOSSLESS)
    assert np.max(np.abs(E - E[0])) < 1e-8


def test_horizontal_momentum_conserved_without_force():
    p = LOSSLESS
    s0 = np.array([0.0, 0.3, 1.0, 2.0])
    sol = solve_ivp(lambda _t, y: rhs(y, 0.0, p), (0, 5), s0, method="DOP853", rtol=1e-11, atol=1e-12)
    x, v, th, w = sol.y
    P = (p.M + p.m) * v + p.m * p.L * w * np.cos(th)
    assert np.max(np.abs(P - P[0])) < 1e-8


def test_equations_of_motion_satisfy_lagrange_form():
    p = Plant()
    rng = np.random.default_rng(0)
    for _ in range(20):
        s = rng.normal(size=4)
        F = rng.normal() * 10
        xdd, thdd = accel(s, F, p)
        _, v, th, w = s
        eq1 = (p.M + p.m) * xdd + p.m * p.L * np.cos(th) * thdd - p.m * p.L * w**2 * np.sin(th) - (F - p.b * v)
        eq2 = p.m * p.L * np.cos(th) * xdd + p.m * p.L**2 * thdd + p.m * p.g * p.L * np.sin(th) + p.c * w
        assert abs(eq1) < 1e-10 and abs(eq2) < 1e-10


def test_tension_at_rest_equals_weight():
    p = Plant()
    assert np.isclose(tension(np.zeros(4), 0.0, p), p.m * p.g)


def test_sdf_and_string_clearance():
    w = Wall(1.0, 1.2, 0.5)
    assert np.isclose(sdf(0.7, 0.2, w), 0.3)  # left of wall
    assert np.isclose(sdf(1.1, 0.9, w), 0.4)  # above wall
    assert np.isclose(sdf(1.1, 0.4, w), -0.1)  # inside, nearest face is the top
    # segment passing 0.1 above the top-left corner
    assert np.isclose(string_clearance(0.0, 0.6, 2.0, 0.6, w), 0.1)
    # segment cutting through the wall 0.2 below its top
    assert np.isclose(string_clearance(0.0, 0.3, 2.0, 0.3, w), -0.2)
    # vertical segment beside the wall
    assert np.isclose(string_clearance(0.9, 1.0, 0.9, 0.1, w), 0.1)


def test_time_reversibility_without_friction():
    """Run forward under F(t), then from the velocity-flipped end state under
    F(T - t): the plant must retrace its path back to the start."""
    p = LOSSLESS
    T = 3.0
    F = lambda t: 8.0 * np.sin(2.1 * t) + 3.0
    s0 = np.array([0.2, 0.5, 0.4, -1.0])
    fwd = solve_ivp(lambda t, y: rhs(y, F(t), p), (0, T), s0, method="DOP853", rtol=1e-12, atol=1e-13)
    flip = np.array([1.0, -1.0, 1.0, -1.0])
    back = solve_ivp(lambda t, y: rhs(y, F(T - t), p), (0, T), fwd.y[:, -1] * flip,
                     method="DOP853", rtol=1e-12, atol=1e-13)
    assert np.allclose(back.y[:, -1] * flip, s0, atol=1e-8)
