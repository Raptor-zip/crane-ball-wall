"""Seeds, candidate lists and verify() semantics (no long planning runs)."""

from dataclasses import replace

import numpy as np

from ballwall import search
from ballwall.__main__ import PRESETS, verify
from ballwall.params import Plant, Scene
from ballwall.planner import Plan, PlanConfig, plan
from ballwall.search import candidates, fingerprint, load_seed, mission_scene, same_problem, save_seed
from ballwall.simulate import derived, simulate


def _fake_plan(N=10, obj=1.0):
    t = np.linspace(0, 1, N + 1)
    return Plan(t=t, X=np.random.default_rng(0).normal(size=(4, N + 1)), U=np.arange(N, dtype=float),
                dt=t[1], A=None, B=None, stats={"objective": obj, "peak_force": 9.0})


def test_seed_round_trip_and_fingerprint(tmp_path, monkeypatch):
    monkeypatch.setattr(search, "SEED_DIR", tmp_path)
    plant, base, cfg = Plant(), Scene(), PRESETS["fast"]
    fp = fingerprint(plant, base, cfg)
    p = _fake_plan()
    save_seed(p, "escape", "fast", fp, "unit test")
    q = load_seed("escape", "fast")
    assert np.array_equal(q.X, p.X) and np.array_equal(q.U, p.U) and np.allclose(q.t, p.t)
    assert q.stats["found_by"] == "unit test" and q.stats["objective"] == 1.0
    assert same_problem(q, fp)
    # solver settings do not change the problem; constraints and physics do
    assert same_problem(q, fingerprint(plant, base, replace(cfg, max_wall_s=5, verbose=True)))
    assert not same_problem(q, fingerprint(plant, base, replace(cfg, tension_min=None)))
    assert not same_problem(q, fingerprint(replace(plant, L=1.1), base, cfg))
    assert not same_problem(None, fp)
    assert list(tmp_path.glob("*.tmp")) == []  # atomic write leaves no temp file


def test_candidates(tmp_path, monkeypatch):
    monkeypatch.setattr(search, "SEED_DIR", tmp_path)
    fp = fingerprint(Plant(), Scene(), PRESETS["fast"])
    for m in ("enter", "escape"):
        save_seed(_fake_plan(), m, "fast", fp, "unit test")

    fast = [c[1:] for c in candidates("escape", "fast", PRESETS["fast"])]
    assert len(fast) == len(set(map(repr, fast)))  # no duplicate recipes
    assert ("seed", ("escape", "fast")) in fast and ("reversed-seed", ("enter", "fast")) in fast

    pump = [c[1:] for c in candidates("escape", "pump", PRESETS["pump"])]
    assert ("seed", ("escape", "fast")) in pump  # time-stretched fast seed
    assert ("via-short", None) in pump

    deep_fast = [c[1] for c in candidates("escape", "fast", PRESETS["fast"], deep=True)]
    deep_pump = [c[1] for c in candidates("escape", "pump", PRESETS["pump"], deep=True)]
    assert deep_fast.count("fine-mesh") == len(search.DEEP_MESHES)
    assert "fine-mesh" not in deep_pump  # long horizons are seeded by stretching instead

    assert all(k in ("scratch", "reversed-other")
               for _, k, _ in candidates("escape", "fast", PRESETS["fast"], use_seeds=False))


def test_verify_ignores_tension_for_a_rigid_rod():
    plant, base = Plant(), Scene()
    scene = mission_scene(base, "escape")
    cfg = PlanConfig(T=4.0, N=120, tension_min=None)
    nominal = plan(plant, scene, cfg)
    res = simulate(nominal, plant, plant, scene, hold=0.5, F_limit=cfg.F_max)
    fine = derived(res, np.linspace(0, res.t_final, int(res.t_final * 1000) + 1))
    report, _, _ = verify(res, fine, scene, plant, cfg, nominal.t[-1])
    assert report["string_taut"] is None
    assert report["ok"] == (report["collision_free"] and report["within_rail"] and report["within_speed_limit"])
