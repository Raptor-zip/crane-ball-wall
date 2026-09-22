"""Plan objects built from the exact published X, U; A, B from the planner's RK4 step Jacobian."""
import pickle
import sys
from pathlib import Path

import casadi as ca
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ballwall.__main__ import PRESETS
from ballwall.params import Plant
from ballwall.planner import Plan, rk4_step

ROOT = str(Path(__file__).resolve().parents[1])
HERE = ROOT + "/out/robustness"
Path(HERE).mkdir(parents=True, exist_ok=True)
for m, p in [("enter", "fast"), ("escape", "fast"), ("enter", "pump"), ("escape", "pump")]:
    z = np.load(f"{ROOT}/out/{m}/{p}/plan.npz")
    t, X, U = z["t"], z["X"], z["U"]
    cfg = PRESETS[p]
    N, dt = cfg.N, cfg.T / cfg.N
    assert len(U) == N and abs(t[1] - t[0] - dt) < 1e-12
    step = rk4_step(Plant(), dt, cfg.substeps)
    s, u = ca.SX.sym("s", 4), ca.SX.sym("u")
    z_ = step(s, u)
    jac = ca.Function("j", [s, u], [ca.jacobian(z_, s), ca.jacobian(z_, u)])
    Aa, Ba = jac.map(N)(X[:, :-1], U[None, :])
    A = np.asarray(Aa).reshape(4, N, 4).transpose(1, 0, 2)
    B = np.asarray(Ba).reshape(4, N, 1).transpose(1, 0, 2)
    # defect of the published nominal w.r.t. the planner's own RK4 model
    Xn = np.asarray(step.map(N)(X[:, :-1], U[None, :]))
    defect = np.abs(Xn - X[:, 1:]).max()
    pl = Plan(t=t, X=X, U=U, dt=dt, A=A, B=B, stats={"source": "published plan.npz"})
    pickle.dump(pl, open(f"{HERE}/plan_{m}_{p}.pkl", "wb"))
    print(m, p, "RK4 defect of the published nominal", f"{defect:.2e}")
