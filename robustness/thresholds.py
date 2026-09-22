"""Failure thresholds, one parameter at a time: coarse scan, then bisection.

For every (run, parameter, direction) and every failure criterion
(ok / collision / slack / rail / speed), find the smallest perturbation that
fails it.  A pass seen after the first failure in the scan is reported as
non-monotone.
"""
import json
import os
from concurrent.futures import ProcessPoolExecutor

import numpy as np

import rsim
from rsim import Pert

CRIT = {
    "ok": lambda r: not r["ok"],
    "collision": lambda r: not r["collision_free"],
    "slack": lambda r: not r["taut"],
    "rail": lambda r: not r["within_rail"],
    "speed": lambda r: not r["within_speed"],
}


def mk(param, val):
    if param == "noise":
        return None  # handled separately
    return Pert(**{param: val})


def eval_point(run, param, val):
    if param == "noise":  # fail if any of 5 seeds fails
        rs = [rsim.simulate(*run, Pert(noise_seed=s, noise_scale=val)) for s in range(5)]
        agg = {k: all(r[k] for r in rs) for k in ("ok", "collision_free", "taut", "within_rail", "within_speed")}
        agg["min_ball_clear"] = min(r["min_ball_clear"] for r in rs)
        agg["min_tension"] = min(r["min_tension"] for r in rs)
        agg["x_min"] = min(r["x_min"] for r in rs)
        agg["contact"] = min(rs, key=lambda r: r["min_ball_clear"])["contact"]
        return agg
    return rsim.simulate(*run, mk(param, val))


PARAMS = {
    "L+": ("dL", list(np.round(np.r_[np.arange(0.0025, 0.1001, 0.0025), 0.15, 0.2, 0.3], 6))),
    "L-": ("dL", list(np.round(-np.r_[np.arange(0.0025, 0.1001, 0.0025), 0.15, 0.2, 0.3], 6))),
    "M-": ("dM", list(np.round(-np.arange(0.025, 0.701, 0.025), 6))),
    "M+": ("dM", list(np.round(np.arange(0.025, 1.501, 0.025), 6))),
    "m-": ("dm", list(np.round(-np.arange(0.025, 0.701, 0.025), 6))),
    "m+": ("dm", list(np.round(np.arange(0.025, 1.501, 0.025), 6))),
    "b up": ("b_scale", list(np.round(np.r_[np.arange(1.1, 3.01, 0.1), np.arange(3.5, 10.01, 0.5)], 6))),
    "b down": ("b_scale", list(np.round(np.arange(0.9, -0.001, -0.1), 6))),
    "Fc": ("Fc", list(np.round(np.arange(0.05, 5.001, 0.05), 6))),
    "delay": ("delay", list(np.round(np.arange(0.002, 0.1201, 0.002), 6))),
    "lag tau": ("tau", list(np.round(np.arange(0.002, 0.1501, 0.002), 6))),
    "noise x": ("noise", list(np.round(np.r_[np.arange(1.0, 10.01, 0.5), 12, 15, 20, 30], 6))),
}


def job(a):
    run, key = a
    param, scan = PARAMS[key]
    res = []
    for v in scan:
        r = eval_point(run, param, v)
        res.append((v, r))
    out = {}
    for cname, cf in CRIT.items():
        fails = [i for i, (_, r) in enumerate(res) if cf(r)]
        if not fails:
            out[cname] = {"threshold": None, "scan_max": scan[-1]}
            continue
        i = fails[0]
        nonmono = any(not cf(r) for _, r in res[i:])
        lo = 0.0 if param != "b_scale" else 1.0
        if param == "noise":
            lo = 0.0
        if i > 0:
            lo = res[i - 1][0]
        hi = res[i][0]
        rhi = res[i][1]
        for _ in range(14):
            mid = 0.5 * (lo + hi)
            rm = eval_point(run, param, mid)
            if cf(rm):
                hi, rhi = mid, rm
            else:
                lo = mid
        out[cname] = {"threshold": hi, "last_pass": lo, "nonmonotone_in_scan": nonmono,
                      "at_threshold": {k: rhi.get(k) for k in ("min_ball_clear", "min_string_clear", "min_tension",
                                                                 "x_min", "x_max", "contact", "peak_speed")
                                       if k in rhi}}
    return run, key, out


if __name__ == "__main__":
    jobs = [(run, key) for run in rsim.RUNS for key in PARAMS]
    with ProcessPoolExecutor(max(1, (os.cpu_count() or 2) - 2)) as ex:
        res = list(ex.map(job, jobs))
    table = {}
    for run, key, out in res:
        table.setdefault("/".join(run), {})[key] = out
    json.dump(table, open(rsim.HERE / "thresholds.json", "w"), indent=1, default=float)
    for run, d in table.items():
        print(f"\n== {run}")
        for key, out in d.items():
            s = []
            for c in ("ok", "collision", "slack", "rail", "speed"):
                o = out[c]
                if o["threshold"] is None:
                    s.append(f"{c}: none<= {o['scan_max']}")
                else:
                    extra = ""
                    if c in ("ok", "collision") and "contact" in o["at_threshold"]:
                        ct = o["at_threshold"]["contact"]
                        extra = f" [{ct['wall']} {ct['face']} t={ct['t']:.2f}]"
                    s.append(f"{c}: {o['threshold']:.4g}{'*' if o['nonmonotone_in_scan'] else ''}{extra}")
            print(f"  {key:8s} " + " | ".join(s))
