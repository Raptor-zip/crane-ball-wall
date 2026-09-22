"""One-at-a-time sweeps over the four final plans (6 processes)."""
import json
import os
from concurrent.futures import ProcessPoolExecutor

import rsim
from rsim import Pert

CASES = [("nominal", Pert())]
for d in (-0.05, -0.03, -0.01, 0.01, 0.03, 0.05):
    CASES.append((f"L {d:+.0%}", Pert(dL=d)))
CASES += [("M -20%", Pert(dM=-0.2)), ("M +20%", Pert(dM=0.2)),
          ("m -20%", Pert(dm=-0.2)), ("m +20%", Pert(dm=0.2)),
          ("b x0", Pert(b_scale=0.0)), ("b x3", Pert(b_scale=3.0)),
          ("Fc 0.5 N", Pert(Fc=0.5)), ("Fc 1 N", Pert(Fc=1.0)), ("Fc 2 N", Pert(Fc=2.0)),
          ("delay 20 ms", Pert(delay=0.02)),
          ("lag 10 ms", Pert(tau=0.01)), ("lag 30 ms", Pert(tau=0.03))]
CASES += [(f"noise seed {s}", Pert(noise_seed=s)) for s in range(5)]


def job(a):
    run, name, pt = a
    try:
        return run, name, rsim.simulate(*run, pt), None
    except Exception as e:
        return run, name, None, repr(e)


if __name__ == "__main__":
    jobs = [(run, name, pt) for run in rsim.RUNS for name, pt in CASES]
    with ProcessPoolExecutor(max(1, (os.cpu_count() or 2) - 2)) as ex:
        res = list(ex.map(job, jobs))
    out = {}
    for run, name, r, err in res:
        out.setdefault("/".join(run), {})[name] = r if err is None else {"error": err}
    json.dump(out, open(rsim.HERE / "sweep.json", "w"), indent=1)
    for run in out:
        print(f"\n== {run}")
        print(f"{'case':14s} {'ball cm':>8s} {'wall':>4s} {'str cm':>7s} {'ten N':>7s} {'Fpk':>6s} {'sat':>4s} "
              f"{'xmin':>7s} {'xmax':>6s} {'vpk':>5s} {'xT mm':>7s} {'thT deg':>7s} {'xH mm':>7s} {'thH':>6s} ok")
        for name, r in out[run].items():
            if "error" in r:
                print(name, r["error"]); continue
            print(f"{name:14s} {100*r['min_ball_clear']:8.3f} {'AB'[r['min_ball_clear_wall']]:>4s} "
                  f"{100*r['min_string_clear']:7.2f} {r['min_tension']:7.3f} {r['peak_force']:6.2f} {r['n_saturated']:4d} "
                  f"{r['x_min']:7.3f} {r['x_max']:6.3f} {r['peak_speed']:5.2f} {r['at_T']['x_error_mm']:7.2f} "
                  f"{r['at_T']['angle_deg']:7.3f} {r['after_hold']['x_error_mm']:7.3f} {r['after_hold']['angle_deg']:6.3f} "
                  f"{'OK' if r['ok'] else 'FAIL'}")
