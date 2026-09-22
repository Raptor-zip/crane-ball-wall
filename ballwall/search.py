"""Multi-start search for the nominal trajectory.

The wall and string-tension constraints make the planning problem
non-convex, so IPOPT converges to whichever local optimum its warm start
leads to, and these differ a lot.  For escape/fast, for example, plain
wall-height continuation lands on a 37 N plan, while a 22 N plan exists that
first swings the ball inside the gap to gain energy.  Cheap warm starts do
not find that family; a slow deep search (fine-mesh continuation) does.

So the best plans found so far are stored as *seeds* (ballwall/seeds/*.npz),
and every run re-optimises from several warm starts in parallel processes
(from scratch, from the seeds, from time-reversed / time-stretched seeds)
and keeps the lowest objective.  `deep=True` adds the slow candidates and
lets the caller save a better result as the new seed.
"""

from __future__ import annotations

import json
import os
import tempfile
import time
from concurrent.futures import ProcessPoolExecutor
from dataclasses import asdict, replace
from pathlib import Path

import numpy as np

from .params import Plant, Scene
from .planner import Plan, PlanConfig, plan, replan, time_reversed

SEED_DIR = Path(__file__).parent / "seeds"
MISSIONS = ("enter", "escape")
DEEP_MESHES = (600, 800, 1000)  # fine-mesh continuations tried by the deep search
DEEP_T_MAX = 6.0  # longer horizons are seeded by time-stretching instead
TIE_RTOL = 1e-6
POLISH_MAX = 6  # re-solves of the winner while its objective keeps improving
# Bump when the planner's constraints change: objectives of seeds made for
# another formulation are not comparable (they are still usable warm starts).
FORMULATION = "clearance@nodes+midpoints, tension@start+mid+end, rail margin"


def mission_scene(base: Scene, mission: str) -> Scene:
    """enter: rest at x_start -> rest in the gap.  escape: the reverse trip."""
    if mission == "escape":
        return replace(base, x_start=base.x_goal, x_goal=base.x_start)
    return base


def other_mission(mission: str) -> str:
    return "enter" if mission == "escape" else "escape"


def solve(plant: Plant, scene: Scene, cfg: PlanConfig, warm: Plan | None = None,
          continuation: bool | None = None) -> Plan:
    """Nominal trajectory.  The "peak" objective is refined from the min-effort one."""
    if cfg.objective == "peak":
        effort = plan(plant, scene, replace(cfg, objective="effort"), init=warm, continuation=continuation)
        return replan(plant, scene, cfg, effort)
    return plan(plant, scene, cfg, init=warm, continuation=continuation)


# ---------------------------------------------------------------- seeds

def seed_path(mission: str, preset: str) -> Path:
    return SEED_DIR / f"{mission}_{preset}.npz"


def fingerprint(plant: Plant, base: Scene, cfg: PlanConfig) -> dict:
    """Everything that defines the optimisation problem (not how it is solved)."""
    solver_only = ("verbose", "max_wall_s", "cont_start", "cont_step")
    return {"formulation": FORMULATION, "plant": asdict(plant),
            "scene": {**asdict(base), "walls": [asdict(w) for w in base.walls]},
            "config": {k: v for k, v in asdict(cfg).items() if k not in solver_only}}


def same_problem(seed: Plan | None, fp: dict) -> bool:
    return seed is not None and json.loads(json.dumps(seed.stats.get("fingerprint"))) == json.loads(json.dumps(fp))


def load_seed(mission: str, preset: str) -> Plan | None:
    path = seed_path(mission, preset)
    if not path.exists():
        return None
    with np.load(path) as z:
        meta = json.loads(str(z["meta"]))
        t, X, U = z["t"], z["X"], z["U"]
    return Plan(t=t, X=X, U=U, dt=float(t[1] - t[0]), A=None, B=None, stats=meta)


def save_seed(p: Plan, mission: str, preset: str, fp: dict, found_by: str):
    SEED_DIR.mkdir(parents=True, exist_ok=True)
    meta = {"mission": mission, "preset": preset, "found_by": found_by,
            "objective": p.stats["objective"], "peak_force": p.stats["peak_force"], "fingerprint": fp}
    fd, tmp = tempfile.mkstemp(dir=SEED_DIR, suffix=".npz.tmp")
    with os.fdopen(fd, "wb") as f:  # write-then-rename: a crash never leaves a torn seed
        np.savez(f, t=p.t, X=p.X, U=p.U, meta=json.dumps(meta))
    os.replace(tmp, seed_path(mission, preset))


# ---------------------------------------------------------------- candidates

def candidates(mission: str, preset: str, cfg: PlanConfig, use_seeds: bool = True, deep: bool = False):
    """Warm-start recipes as (name, kind, arg).  Resolved inside the worker."""
    other = other_mission(mission)
    out = [("continuation", "scratch", None),
           (f"time-reversed {other} (from scratch)", "reversed-other", None)]
    if cfg.T > DEEP_T_MAX:
        out.append(("time-stretched short plan (from scratch)", "via-short", None))
    if use_seeds:
        seeds = [(f"seed {mission}/{preset}", "seed", (mission, preset)),
                 (f"time-reversed seed {other}/{preset}", "reversed-seed", (other, preset))]
        if preset != "fast":
            seeds += [(f"time-stretched seed {mission}/fast", "seed", (mission, "fast")),
                      (f"time-stretched reversed seed {other}/fast", "reversed-seed", (other, "fast"))]
        out += [c for c in seeds if seed_path(*c[2]).exists()]
    if deep and cfg.T <= DEEP_T_MAX:
        out += [(f"fine mesh N={n}", "fine-mesh", n) for n in DEEP_MESHES]
    return out


def _warm_start(kind, arg, plant, base, mission, cfg):
    scene = mission_scene(base, mission)
    if kind == "scratch":
        return None
    if kind == "seed":
        return load_seed(*arg)
    if kind == "reversed-seed":
        return time_reversed(load_seed(*arg), plant)
    if kind == "reversed-other":
        return time_reversed(solve(plant, mission_scene(base, other_mission(mission)), cfg), plant)
    if kind == "via-short":
        return solve(plant, scene, replace(cfg, T=4.0, N=200, objective="effort"))
    if kind == "fine-mesh":
        return plan(plant, scene, replace(cfg, N=arg, objective="effort", max_wall_s=max(cfg.max_wall_s, 1500)))
    raise ValueError(kind)


def _run(job):
    name, kind, arg, plant, base, mission, cfg = job
    t0 = time.time()
    try:
        warm = _warm_start(kind, arg, plant, base, mission, cfg)
        p = solve(plant, mission_scene(base, mission), cfg, warm=warm)
        return name, p, None, time.time() - t0
    except Exception as e:  # a failed candidate must not sink the search
        return name, None, f"{type(e).__name__}: {e}", time.time() - t0


def best_plan(plant: Plant, base: Scene, mission: str, preset: str, cfg: PlanConfig,
              use_seeds: bool = True, deep: bool = False, workers: int | None = None, log=print) -> Plan:
    """Solve from every candidate warm start in parallel; keep the lowest objective."""
    cands = candidates(mission, preset, cfg, use_seeds, deep)
    jobs = [(n, k, a, plant, base, mission, cfg) for n, k, a in cands]
    workers = workers or min(len(jobs), max(1, (os.cpu_count() or 2) - 1))
    if workers == 1:
        results = [_run(j) for j in jobs]
    else:
        with ProcessPoolExecutor(workers) as ex:
            results = list(ex.map(_run, jobs))

    table, best = {}, None
    for name, p, err, secs in results:  # candidate order breaks ties
        if p is None:
            table[name] = {"error": err, "seconds": secs}
            log(f"[plan] {name:44s} FAILED ({secs:.0f}s): {err[:80]}")
            continue
        s = p.stats
        table[name] = {"status": s["status"], "objective": s["objective"], "peak_force": s["peak_force"],
                       "iterations": s["iterations"], "seconds": secs}
        log(f"[plan] {name:44s} objective={s['objective']:9.2f}  peak |F|={s['peak_force']:6.2f} N  ({secs:.0f}s)")
        if best is None or s["objective"] < best[1].stats["objective"] * (1 - TIE_RTOL):
            best = (name, p)
    if best is None:
        raise RuntimeError(f"{mission}/{preset}: planning failed from every warm start")
    name, p = best
    p, n_polish = polish(plant, mission_scene(base, mission), cfg, p)
    p.stats["search"] = {"winner": name, "polish_resolves": n_polish, "candidates": table}
    log(f"[plan] polished the winner with {n_polish} re-solve(s): objective={p.stats['objective']:.2f}")
    return p


def polish(plant: Plant, scene: Scene, cfg: PlanConfig, p: Plan):
    """Re-solve from the winner (directly on its own objective) while that
    still lowers the objective.  IPOPT restarts from primal values only and
    can settle on a slightly better neighbouring optimum; iterating makes the
    result, and any seed saved from it, a fixed point of the planner."""
    n = 0
    for _ in range(POLISH_MAX):
        try:
            q = plan(plant, scene, cfg, init=p)
        except RuntimeError:
            break
        if q.stats["objective"] >= p.stats["objective"] * (1 - 1e-7):
            break
        p, n = q, n + 1
    return p, n
