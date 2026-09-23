"""Fixed test data for the TypeScript side (spec §8.2 "export_fixtures.py").

    uv run python game/tools/export_fixtures.py

Writes (game/tests/fixtures/):
  eom_py.json            taut-string RK4 reference: 4 plants x 2 force sequences, 12 s at h = 1/120
  plans_py.json          the 4 research seeds + the 2-2 `ai` plan (t, X, U, dt, substeps = 2)
  ghostcodec_vectors.json 10 channel-codec vectors (input numbers -> expected base64url text)
  levelhash_vectors.json levelHash vectors (physics -> canonicalJson -> FNV-1a hex)

All floats are written with Python's repr (shortest round-trip), so JSON.parse gives
the exact same doubles.
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np  # noqa: E402

import common as C  # noqa: E402
import ghostcodec as GC  # noqa: E402
from ballwall.dynamics import rhs, tension  # noqa: E402
from ballwall.params import Plant  # noqa: E402

H = 1.0 / 120.0
TICKS = 720  # 12 s at 60 Hz
EVERY = 60  # record every 60 substeps (0.5 s)
FIRST = 20  # plus the first 20 substeps one by one


def rk4(s, F, p):
    k1 = rhs(s, F, p)
    k2 = rhs(s + H / 2 * k1, F, p)
    k3 = rhs(s + H / 2 * k2, F, p)
    k4 = rhs(s + H * k3, F, p)
    return s + H / 6 * (k1 + 2 * k2 + 2 * k3 + k4)


def q_random(rng, qmax: int):
    """Piecewise-constant q: levels uniform in [-qmax, qmax], held 0.25-1.0 s."""
    q = np.empty(TICKS, int)
    k = 0
    while k < TICKS:
        n = int(rng.integers(15, 61))
        q[k:k + n] = int(rng.integers(-qmax, qmax + 1))
        k += n
    return q


def q_sine(Fmax: float, amp: float, period: float, phase: float):
    t = np.arange(TICKS) / 60.0
    F = amp * np.sin(2 * math.pi * t / period + phase)
    return np.array([max(-127, min(127, GC.js_round(f * 127 / Fmax))) for f in F])


def integrate(p: Plant, F_ticks):
    s = np.zeros(4)
    states, first, t_min = [s.copy()], [], math.inf
    sub = 0
    for F in F_ticks:
        for _ in range(2):
            s = rk4(s, F, p)
            sub += 1
            t_min = min(t_min, float(tension(s, F, p)))
            if sub <= FIRST:
                first.append(s.copy())
            if sub % EVERY == 0:
                states.append(s.copy())
    return states, first, t_min


def eom_cases():
    plants = [("default", Plant(), 40.0, 15.0), ("heavy_m3", Plant(m=3.0), 40.0, 15.0),
              ("short_L0.6", Plant(L=0.6), 40.0, 15.0), ("weak_F6", Plant(), 6.0, 6.0)]
    cases = []
    for name, p, Fmax, amp in plants:
        qmax = min(127, int(math.floor(amp * 127 / Fmax)))
        # random piecewise-constant forces; redraw (next seed) until the string stays taut
        for seed in range(100, 200):
            q = q_random(np.random.default_rng(seed), qmax)
            F = [qq * Fmax / 127 for qq in q]
            states, first, t_min = integrate(p, F)
            if t_min > 0.5:
                break
        else:
            raise RuntimeError(f"{name}: no taut random sequence")
        cases.append((f"{name}/random", p, Fmax, q, F, states, first, t_min, {"seed": seed, "qmax": qmax}))
        # sinusoid, off resonance
        for a in (amp, amp * 0.75, amp * 0.5):
            q = q_sine(Fmax, a, 2.7, 0.3)
            F = [qq * Fmax / 127 for qq in q]
            states, first, t_min = integrate(p, F)
            if t_min > 0.5:
                break
        else:
            raise RuntimeError(f"{name}: no taut sine")
        cases.append((f"{name}/sine", p, Fmax, q, F, states, first, t_min, {"ampN": a, "periodS": 2.7, "phase": 0.3}))
    out = []
    for name, p, Fmax, q, F, states, first, t_min, gen in cases:
        out.append({
            "name": name, "plant": {"M": p.M, "m": p.m, "L": p.L, "g": p.g, "b": p.b, "c": p.c},
            "Fmax": Fmax, "gen": gen, "q": [int(v) for v in q], "F": F,
            "s0": [0.0, 0.0, 0.0, 0.0], "every": EVERY,
            "states": [[float(v) for v in s] for s in states],
            "first": [[float(v) for v in s] for s in first],
            "minTension": t_min,
        })
    return {
        "format": 1,
        "about": "ballwall.dynamics.rhs integrated with classic RK4, h = 1/120, F held for the 2 substeps of each "
                 "60 Hz tick (F[k] = q[k]*Fmax/127, evaluated in that order). states[j] is [x, v, th, w] after "
                 "j*every substeps (states[0] = s0); first[i] is the state after substep i+1. The string stays taut "
                 "(minTension > 0) in every case.",
        "h": H, "substepsPerTick": 2, "ticks": TICKS, "cases": out,
    }


def plan_entry(name, t, X, U, plant: Plant, extra=None):
    T = float(t[-1])
    N = len(U)
    e = {"name": name, "T": T, "N": N, "dt": T / N, "substeps": 2,
         "plant": {"M": plant.M, "m": plant.m, "L": plant.L, "g": plant.g, "b": plant.b, "c": plant.c},
         "t": [float(v) for v in t], "X": [[float(v) for v in row] for row in X], "U": [float(v) for v in U]}
    if extra:
        e.update(extra)
    return e


def ai_plan_22():
    """The 2-2 `ai` plan chosen by ai_ghosts.py (its cache), else solve it at tHi here."""
    lv = C.level_by_id(C.load_levels())["2-2"]
    info = C.CACHE_DIR / "2-2" / "result.json"
    if info.exists():
        r = json.loads(info.read_text())
        ai = r.get("ai")
        if ai and r.get("hash") == C.level_hash(lv["physics"]):
            res = C.load_result_npz(C.cache_path(ai["level"], ai["digest"]))
            return res["t"], res["X"], res["U"], {"source": f"ai_ghosts cache {ai['digest'][:12]} ({r.get('mode')})"}
    print("[fixtures] no ai_ghosts result for 2-2 yet: solving it at tHi from the enter_fast seed")
    from ballwall.planner import plan
    face = C.level_face(lv)
    plant, scene, cfg, extra = C.build_planner(face, "ai", lv["ai"]["tHi"])
    p = plan(plant, scene, cfg, init=C.load_seed_plan("enter_fast"), continuation=False, extra=extra)
    return p.t, p.X, p.U, {"source": "export_fixtures direct solve at tHi (warm start enter_fast)"}


def plans():
    out = []
    for name in C.SEED_NAMES:
        p = C.load_seed_plan(name)
        out.append(plan_entry(name, p.t, p.X, p.U, Plant()))
    t, X, U, meta = ai_plan_22()
    out.append(plan_entry("2-2/ai", t, X, U, Plant(), meta))
    return {"format": 1,
            "about": "Planner node trajectories: X[:, k] is [x, v, th, w] at t[k] (4 rows), U[k] the force held on "
                     "[t[k], t[k+1]); dt = T/N and each interval is 2 RK4 substeps of dt/2 (ballwall.planner).",
            "plans": out}


def codec_vectors():
    seed = C.load_seed_plan("enter_fast")
    tr = C.Traj.of(seed)
    t60 = np.arange(0, 40) / 60.0
    S = tr.states(t60 + 1.0)
    F = tr.force(t60 + 1.0)
    rng = np.random.default_rng(7)
    raw = [
        ("x", "enter_fast x(t), 60 Hz from t=1 s", [float(v) for v in S[0]]),
        ("th", "enter_fast th(t), 60 Hz from t=1 s", [float(v) for v in S[2]]),
        ("f", "enter_fast F(t), 60 Hz from t=1 s", [float(v) for v in F]),
        ("x", "empty channel", []),
        ("x", "single value", [1.63]),
        ("th", "single negative value", [-0.7854]),
        ("f", "full-scale steps", [40.0, -40.0, 40.0, 0.0, -39.95, 12.34, -0.04, 0.06]),
        ("x", "rest then run (repeated values)", [0.0] * 10 + [0.0001, 0.0005, 0.002, 0.01, 0.03, 0.07, 0.13]),
        ("th", "random walk", [float(v) for v in np.cumsum(rng.normal(0, 0.05, 50))]),
        ("x", "large jumps (multi-byte varints)", [-1.0, 3.2, -0.6, 3.6, 0.0, 1234.5678, -1234.5678]),
    ]
    vecs = []
    for ch, note, values in raw:
        ints = GC.quantize(values, ch)
        enc = GC.encode_ints(ints)
        assert GC.decode_ints(enc) == ints
        vecs.append({"channel": ch, "note": note, "values": values, "ints": ints, "encoded": enc})
    return {"format": 1,
            "about": "ints = Math.round(value * scale) with scale x: 1e4, th: 1e4, f: 10; encoded = base64url (no "
                     "padding) of LEB128(zigzag(first value, then differences)). decode(encoded) must equal ints.",
            "scale": GC.SCALE, "vectors": vecs}


def hash_vectors():
    by = C.level_by_id(C.load_levels())
    vecs = []
    for lid in ("1-1", "2-2", "2-3", "3-3", "4-3", "5-4"):
        ph = by[lid]["physics"]
        vecs.append({"id": lid, "physics": ph, "canonical": C.canonical_json(ph), "hash": C.level_hash(ph)})
    # synthetic objects exercising Number -> String and key order (not valid levels)
    synth = [
        ("floats", {"b": 0.1 + 0.2, "a": 1e21, "c": 1e-7, "d": 123456789012345680000.0, "e": -2.5, "f": 100.0,
                    "g": 1.5e-6, "h": 0.000001, "i": 5e-324}),
        ("negative zero and ints", {"z": -0.0, "M": 2.0, "m": 3, "L": [0.6, -1.0, 3.2]}),
        ("unsorted keys, nested", {"walls": [{"x1": 1.42, "x0": 1.3, "h": 0.75}], "Fmax": 14, "egg": {"Tmax": 16.5, "Jmax": 0.3}}),
    ]
    for name, obj in synth:
        vecs.append({"id": f"synthetic: {name}", "physics": obj, "canonical": C.canonical_json(obj),
                     "hash": C.level_hash(obj)})
    return {"format": 1,
            "about": "levelHash(phys) = FNV-1a 32 of the UTF-8 bytes of canonicalJson(phys), 8 lowercase hex digits. "
                     "canonicalJson: keys sorted, no whitespace, numbers as String(n), array order kept.",
            "vectors": vecs}


def dump(name: str, obj):
    path = C.FIXTURES / name
    C.write_text_atomic(path, json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(f"[fixtures] {path.relative_to(C.REPO)}  {path.stat().st_size / 1024:.0f} KB")


def main():
    dump("eom_py.json", eom_cases())
    dump("ghostcodec_vectors.json", codec_vectors())
    dump("levelhash_vectors.json", hash_vectors())
    dump("plans_py.json", plans())


if __name__ == "__main__":
    main()
