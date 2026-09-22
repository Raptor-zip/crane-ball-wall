"""Combined Monte Carlo per run (common random numbers across runs).

Base distribution (all uniform, independent):
  L  +-1 %, m +-10 %, M +-10 %, b x U[0.5, 1.5], Fc U[0, 0.5] N,
  force lag tau U[0, 10] ms, plus Gaussian measurement noise
  sigma = (1 mm, 0.2 deg, 1 cm/s, 1 deg/s), a fresh noise seed per sample.
Variants for attribution: 'noFc' (Fc = 0), 'noFc_L0' (Fc = 0 and L exact).
"""
import json
import os
import math
import sys
from concurrent.futures import ProcessPoolExecutor

import numpy as np

import rsim
from rsim import Pert

NS = int(sys.argv[1]) if len(sys.argv) > 1 else 1000
VARIANTS = sys.argv[2].split(",") if len(sys.argv) > 2 else ["base", "noFc", "noFc_L0"]


def draw(i, variant):
    rng = np.random.default_rng(12345 + i)
    u = rng.uniform(size=6)
    pt = Pert(dL=-0.01 + 0.02 * u[0], dm=-0.1 + 0.2 * u[1], dM=-0.1 + 0.2 * u[2], b_scale=0.5 + u[3],
              Fc=0.5 * u[4], tau=0.01 * u[5], noise_seed=100000 + i)
    if variant in ("noFc", "noFc_L0"):
        pt = Pert(**{**pt.__dict__, "Fc": 0.0})
    if variant == "noFc_L0":
        pt = Pert(**{**pt.__dict__, "dL": 0.0})
    return pt


def job(a):
    run, variant, i = a
    pt = draw(i, variant)
    r = rsim.simulate(*run, pt)
    keep = {k: r[k] for k in ("min_ball_clear", "min_string_clear", "min_tension", "peak_force", "x_min", "x_max",
                              "peak_speed", "collision_free", "taut", "within_rail", "within_speed", "ok", "settled",
                              "contact", "at_T", "after_hold")}
    keep["pert"] = {k: v for k, v in pt.__dict__.items()}
    return "/".join(run), variant, i, keep


def wilson(k, n, z=1.96):
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return c - h, c + h


def spearman(a, b):
    ra = np.argsort(np.argsort(a))
    rb = np.argsort(np.argsort(b))
    return float(np.corrcoef(ra, rb)[0, 1])


if __name__ == "__main__":
    jobs = [(run, v, i) for v in VARIANTS for run in rsim.RUNS for i in range(NS)]
    with ProcessPoolExecutor(max(1, (os.cpu_count() or 2) - 2)) as ex:
        res = list(ex.map(job, jobs, chunksize=8))
    data = {}
    for run, v, i, r in res:
        data.setdefault(v, {}).setdefault(run, []).append(r)
    json.dump(data, open(rsim.HERE / f"mc_{NS}.json", "w"), default=float)
    summ = {}
    for v in VARIANTS:
        print(f"\n######## variant {v}  (n={NS} per run)")
        for run in data[v]:
            rs = data[v][run]
            n = len(rs)
            ok = sum(r["ok"] for r in rs)
            lo, hi = wilson(ok, n)
            cb = np.array([r["min_ball_clear"] for r in rs]) * 100
            cs = np.array([r["min_string_clear"] for r in rs]) * 100
            tn = np.array([r["min_tension"] for r in rs])
            xh = np.array([r["after_hold"]["x_error_mm"] for r in rs])
            xT = np.array([r["at_T"]["x_error_mm"] for r in rs])
            xmin = np.array([r["x_min"] for r in rs])
            modes = {m: sum(not r[k] for r in rs) for m, k in
                     (("collision", "collision_free"), ("slack", "taut"), ("rail", "within_rail"), ("speed", "within_speed"))}
            faces = {}
            for r in rs:
                if not r["collision_free"]:
                    key = f"{r['contact']['wall']} {r['contact']['face']}"
                    faces[key] = faces.get(key, 0) + 1
            P = {k: np.array([r["pert"][k] for r in rs]) for k in ("dL", "dm", "dM", "b_scale", "Fc", "tau")}
            corr = {k: spearman(P[k], cb) for k in P if np.ptp(P[k]) > 0}
            s = {"n": n, "ok": ok, "rate": ok / n, "wilson95": [lo, hi], "fail_modes": modes, "contact_faces": faces,
                 "ball_p1_cm": float(np.percentile(cb, 1)), "ball_p5_cm": float(np.percentile(cb, 5)),
                 "ball_med_cm": float(np.median(cb)), "ball_min_cm": float(cb.min()),
                 "string_p1_cm": float(np.percentile(cs, 1)), "string_min_cm": float(cs.min()),
                 "tension_p1_N": float(np.percentile(tn, 1)), "tension_min_N": float(tn.min()),
                 "xmin_p1": float(np.percentile(xmin, 1)), "xmin_min": float(xmin.min()),
                 "xT_mm_p99": float(np.percentile(xT, 99)), "xhold_mm_p99": float(np.percentile(xh, 99)),
                 "xhold_mm_med": float(np.median(xh)), "settled": int(sum(r["settled"] for r in rs)),
                 "spearman_ball_clear": corr}
            summ.setdefault(v, {})[run] = s
            print(f"{run:12s} ok {ok}/{n} = {100*ok/n:5.1f}% (95% CI {100*lo:.1f}-{100*hi:.1f})  modes {modes}  faces {faces}")
            print(f"   ball clr cm: p1 {s['ball_p1_cm']:.2f} p5 {s['ball_p5_cm']:.2f} med {s['ball_med_cm']:.2f} min {s['ball_min_cm']:.2f}"
                  f" | string p1 {s['string_p1_cm']:.2f} | tension p1 {s['tension_p1_N']:.3f} min {s['tension_min_N']:.3f}"
                  f" | x_min p1 {s['xmin_p1']:.3f} min {s['xmin_min']:.3f}")
            print(f"   x err at T p99 {s['xT_mm_p99']:.1f} mm, after hold med {s['xhold_mm_med']:.2f} p99 {s['xhold_mm_p99']:.2f} mm, settled {s['settled']}/{n}")
            print("   spearman(param, ball clearance): " + ", ".join(f"{k} {c:+.2f}" for k, c in corr.items()))
    json.dump(summ, open(rsim.HERE / f"mc_{NS}_summary.json", "w"), indent=1, default=float)
