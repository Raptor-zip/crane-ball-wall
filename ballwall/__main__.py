"""Plan, simulate, verify and render the two-wall crane manoeuvre.

    uv run python -m ballwall                         # enter: swing over the wall, park in the gap
    uv run python -m ballwall --mission escape        # escape: start parked in the gap, get back out
    uv run python -m ballwall --preset pump           # low-force resonant pumping
    uv run python -m ballwall --mismatch 0.1          # simulated ball 10% heavier than modelled
    uv run python -m ballwall --search                # slow deep search; saves a better seed
"""

from __future__ import annotations

import argparse
import json
import time
from dataclasses import asdict, replace
from pathlib import Path

import numpy as np

from . import viz
from .dynamics import tension
from .geometry import clearances
from .params import Plant, Scene
from .planner import PlanConfig
from .search import MISSIONS, best_plan, fingerprint, load_seed, mission_scene, same_problem, save_seed
from .simulate import derived, simulate

PRESETS = {
    # quick thrust-and-catch: minimise ∫F² over a short horizon
    "fast": PlanConfig(T=4.0, N=200, objective="effort"),
    # resonant pumping: minimise the peak actuator force over a long horizon
    "pump": PlanConfig(T=12.0, N=600, objective="peak", w_peak=20.0),
}


def _rest_error(s, scene: Scene, plant: Plant) -> dict:
    """How far a state is from resting at the goal."""
    x, v, th, w = s
    return {
        "x_error_mm": float(1e3 * abs(x - scene.x_goal)),
        "angle_deg": float(np.degrees(abs(th))),
        "ball_speed_mps": float(np.hypot(v + plant.L * np.cos(th) * w, plant.L * np.sin(th) * w)),
    }


def verify(res, data, scene: Scene, plant: Plant, cfg: PlanConfig, t_plan: float):
    """Check a closed-loop run against the scene and the actuator limits.

    `data` is `derived()` on a fine grid; string tension is also evaluated at
    the left limit of every force step, where its minimum sits.
    """
    S = data["S"]
    cb, cs = clearances(S[0], S[2], scene, plant.L)
    _, S_left, F_left = res.knot_left_limits()
    ten_min = min(data["tension"].min(), tension(S_left, F_left, plant).min())
    bx, _ = scene.ball_pos(S[0], S[2], plant.L, np)
    report = {
        "min_ball_clearance_m": float(cb.min()),
        "min_string_clearance_m": float(cs.min()),
        "min_tension_N": float(ten_min),
        "peak_force_N": float(np.abs(data["F"]).max()),
        "peak_trolley_speed_mps": float(np.abs(S[1]).max()),
        "peak_angle_deg": float(np.degrees(np.abs(S[2]).max())),
        "trolley_x_range_m": [float(S[0].min()), float(S[0].max())],
        "ball_x_range_m": [float(bx.min()), float(bx.max())],
        "at_T": _rest_error(res.sample([t_plan])[:, 0], scene, plant),
        "after_hold": {**_rest_error(S[:, -1], scene, plant), "hold_s": float(data["t"][-1] - t_plan)},
        "collision_free": bool(cb.min() > 0 and cs.min() > 0),
        # a rigid rod (tension_min None) may be in compression
        "string_taut": bool(ten_min > 0) if cfg.tension_min is not None else None,
        "within_rail": bool(scene.x_min <= S[0].min() and S[0].max() <= scene.x_max),
        "within_speed_limit": bool(np.abs(S[1]).max() <= cfg.v_max + 1e-3),
        "t_plan_s": t_plan,
    }
    checks = ("collision_free", "string_taut", "within_rail", "within_speed_limit")
    report["ok"] = all(report[k] for k in checks if report[k] is not None)
    return report, cb, cs


def export_json(path, data, scene: Scene, plant: Plant, fps: int, meta: dict):
    """Frame-sampled trajectory for playback in three.js."""
    t, S, F = data["t"], data["S"], data["F"]
    out = {
        "meta": meta,
        "units": "SI (m, kg, s, N, rad)",
        "frame": "x along rail (right +), y up, floor y=0; theta from downward vertical",
        "fps": fps,
        "plant": asdict(plant),
        "scene": {**asdict(scene), "walls": [asdict(w) for w in scene.walls]},
        "t": np.round(t, 5).tolist(),
        "x": np.round(S[0], 6).tolist(),
        "theta": np.round(S[2], 6).tolist(),
        "F": np.round(F, 4).tolist(),
    }
    Path(path).write_text(json.dumps(out))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--mission", choices=MISSIONS, default="enter")
    ap.add_argument("--preset", choices=PRESETS, default="fast")
    ap.add_argument("--T", type=float, help="manoeuvre duration [s]")
    ap.add_argument("--rod", action="store_true", help="rigid rod instead of a string (no tension limit)")
    ap.add_argument("--mismatch", type=float, default=0.0, help="relative ball-mass error of the real plant")
    ap.add_argument("--hold", type=float, default=2.5, help="seconds of goal holding after the manoeuvre")
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--search", action="store_true",
                    help="also try the slow fine-mesh warm starts and save a better plan as the new seed")
    ap.add_argument("--no-seeds", action="store_true", help="ignore the stored seeds (plan from scratch)")
    ap.add_argument("--workers", type=int, help="parallel planner processes (default: CPUs - 1)")
    ap.add_argument("--no-video", action="store_true")
    ap.add_argument("--out", default="out")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args(argv)

    plant, base = Plant(), Scene()
    scene = mission_scene(base, args.mission)
    cfg = PRESETS[args.preset]
    if args.T:
        cfg = replace(cfg, T=args.T, N=int(round(args.T * 50)))
    if args.rod:
        cfg = replace(cfg, tension_min=None)
    cfg = replace(cfg, verbose=args.verbose)
    # non-default runs get their own directory instead of overwriting the default results
    variant = "".join((f"-T{args.T:g}" if args.T else "", "-rod" if args.rod else "",
                       f"-mismatch{args.mismatch:+g}" if args.mismatch else "",
                       f"-hold{args.hold:g}" if args.hold != 2.5 else ""))
    out = Path(args.out) / args.mission / (args.preset + variant)
    out.mkdir(parents=True, exist_ok=True)

    t0 = time.time()
    nominal = best_plan(plant, base, args.mission, args.preset, cfg, use_seeds=not args.no_seeds,
                        deep=args.search, workers=args.workers)
    print(f"[plan] {time.time() - t0:.1f}s  winner: {nominal.stats['search']['winner']}  "
          f"objective={nominal.stats['objective']:.2f}  peak |F|={nominal.stats['peak_force']:.2f} N")

    plant_true = replace(plant, m=plant.m * (1 + args.mismatch))
    t0 = time.time()
    res = simulate(nominal, plant_true, plant, scene, hold=args.hold, F_limit=cfg.F_max)
    print(f"[sim ] {time.time() - t0:.1f}s  (DOP853, rtol 1e-10)")

    # verification on a 1 kHz grid, rendering on the frame grid
    fine = derived(res, np.linspace(0, res.t_final, int(res.t_final * 1000) + 1))
    report, cb, cs = verify(res, fine, scene, plant_true, cfg, nominal.t[-1])
    report["plan"] = nominal.stats
    report["config"] = {**asdict(cfg), "mission": args.mission, "mismatch": args.mismatch}
    (out / "report.json").write_text(json.dumps(report, indent=2))
    np.savez(out / "plan.npz", t=nominal.t, X=nominal.X, U=nominal.U)  # the nominal the controller tracked
    for k, v in report.items():
        if k not in ("plan", "config"):
            print(f"  {k:26s} {v}")

    if args.search and not variant:
        fp = fingerprint(plant, base, cfg)
        stored = load_seed(args.mission, args.preset)
        old = stored if same_problem(stored, fp) else None  # objectives of other problems don't compare
        winner = nominal.stats["search"]["winner"]
        if not report["ok"]:
            print("[seed] not saved: the closed-loop check failed")
        elif old is None or nominal.stats["objective"] < old.stats["objective"] * (1 - 1e-6):
            found_by = winner
            if winner.startswith("seed ") and stored is not None:  # keep the provenance of a re-optimised seed
                found_by = f"{stored.stats.get('found_by', '?')} -> re-optimised"
            save_seed(nominal, args.mission, args.preset, fp, found_by)
            print(f"[seed] saved {args.mission}/{args.preset} (objective {nominal.stats['objective']:.2f})")
        else:
            print(f"[seed] kept the existing seed (objective {old.stats['objective']:.2f})")

    title = f"{args.mission} / {args.preset}: T={cfg.T:g}s  peak |F|={report['peak_force_N']:.1f} N" + \
            ("  (rod)" if args.rod else "  (string)") + \
            (f"  ball mass {args.mismatch:+.0%} vs model" if args.mismatch else "")
    frames = derived(res, np.linspace(0, res.t_final, int(res.t_final * args.fps) + 1))
    export_json(out / "trajectory.json", frames, scene, plant_true, args.fps,
                {"mission": args.mission, "preset": args.preset, "title": title, "t_plan": nominal.t[-1],
                 "mismatch": args.mismatch})
    viz.summary(fine, scene, plant_true, out / "summary.png", cb, cs, t_plan=nominal.t[-1], title=title)
    viz.strobe(fine, scene, plant_true, out / "strobe.png", t_end=nominal.t[-1], title=title)
    if not args.no_video:
        t0 = time.time()
        viz.animate(frames, scene, plant_true, out / "anim.mp4", fps=args.fps, title=title)
        print(f"[mp4 ] {time.time() - t0:.1f}s")
    print(f"-> {out}/")


if __name__ == "__main__":
    main()
