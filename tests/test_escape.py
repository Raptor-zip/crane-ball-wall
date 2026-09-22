"""Escape mission: time reversal, and an end-to-end plan -> closed loop -> verify."""

from dataclasses import replace

import numpy as np

from ballwall.__main__ import verify
from ballwall.search import mission_scene
from ballwall.params import Plant, Scene
from ballwall.planner import Plan, PlanConfig, plan, rk4_step, time_reversed
from ballwall.simulate import derived, simulate


def _rk4_rollout(plant, U, dt, s0):
    step = rk4_step(plant, dt, 2)
    X = [np.asarray(s0, float)]
    for u in U:
        X.append(np.asarray(step(X[-1], u)).ravel())
    X = np.array(X).T
    return Plan(t=np.arange(len(U) + 1) * dt, X=X, U=np.asarray(U, float), dt=dt, A=None, B=None, stats={})


def _defect(plant, p):
    step = rk4_step(plant, p.dt, 2)
    return np.max(np.abs(np.asarray(step.map(len(p.U))(p.X[:, :-1], p.U[None, :])) - p.X[:, 1:]))


def test_time_reversed_compensates_trolley_friction():
    """Reversing a trajectory of the plant with trolley friction (pivot
    damping off) must give a trajectory of the same plant, up to the
    O(dt^2) error of holding F - 2 b v_mid constant over each interval.
    Dropping or flipping the friction term must be clearly worse."""
    plant = replace(Plant(), c=0.0)
    rng = np.random.default_rng(1)
    dt, N = 0.02, 150
    U = np.convolve(rng.normal(scale=15.0, size=N), np.ones(8) / 8, mode="same")
    fwd = _rk4_rollout(plant, U, dt, [0.0, 0.0, 0.0, 0.0])
    assert np.max(np.abs(fwd.X[1])) > 0.5  # the test needs real trolley motion

    good = _defect(plant, time_reversed(fwd, plant))
    bad_none = _defect(plant, time_reversed(fwd, replace(plant, b=0.0)))
    bad_sign = _defect(plant, time_reversed(fwd, replace(plant, b=-plant.b)))
    assert good < 1e-4
    assert bad_none > 20 * good and bad_sign > 20 * good


def test_time_reversal_is_exact_without_friction():
    plant = replace(Plant(), b=0.0, c=0.0)
    rng = np.random.default_rng(2)
    fwd = _rk4_rollout(plant, rng.normal(scale=10.0, size=100), 0.02, [0.3, 0.0, 0.2, 0.0])
    assert _defect(plant, time_reversed(fwd, plant)) < 1e-6


def _check(nominal, plant, scene, cfg):
    res = simulate(nominal, plant, plant, scene, hold=1.0, F_limit=cfg.F_max)
    fine = derived(res, np.linspace(0, res.t_final, int(res.t_final * 1000) + 1))
    report, _, _ = verify(res, fine, scene, plant, cfg, nominal.t[-1])
    assert report["ok"], report
    assert report["after_hold"]["x_error_mm"] < 1.0, report
    assert report["after_hold"]["angle_deg"] < 0.1, report
    return report, fine


def test_escape_from_gap():
    plant, base = Plant(), Scene()
    scene = mission_scene(base, "escape")
    assert np.isclose(scene.x_start, base.x_goal) and np.isclose(scene.x_goal, base.x_start)
    cfg = PlanConfig(T=4.0, N=120)
    nominal = plan(plant, scene, cfg)
    _, fine = _check(nominal, plant, scene, cfg)
    # the ball really goes out over the first wall (not around or through it)
    S = fine["S"]
    bx, by = scene.ball_pos(S[0], S[2], plant.L, np)
    wall = scene.walls[0]
    over = (bx > wall.x0) & (bx < wall.x1)
    assert over.any() and np.all(by[over] - scene.ball_r > wall.h)
    assert bx[0] > wall.x1 and bx[-1] < wall.x0
