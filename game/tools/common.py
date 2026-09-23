"""Shared helpers for the game's offline Python tools (owner O2).

Run every tool from the repository root:  uv run python game/tools/<name>.py

Contents
  * paths and game constants (spec appendix A)
  * JS-compatible number formatting, canonicalJson, FNV-1a levelHash (spec §6.1)
  * levels.json I/O with a stable, readable formatter
  * levelFacts / placeholder formatting (§5.3) and validateLevel (§6.1)
  * planner problem construction: Plant / Scene / PlanConfig / `extra` constraints (§8.2)
  * trajectories: Hermite resampling, composition, the game's success rule, split
    and apex detection, statistics and ghost building (§8.2 6-8)
  * a process scheduler that runs one planner candidate per child process with a
    hard kill (600 s) and an on-disk cache keyed by the problem digest (§8.2 9)
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import sys
import threading
import time
from pathlib import Path

# BLAS / OpenMP threads: one per process (IPOPT's linear algebra would otherwise use
# several cores per process and `--jobs 20` would oversubscribe the machine).
for _k in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_k, "1")

TOOLS = Path(__file__).resolve().parent
GAME = TOOLS.parent
REPO = GAME.parent
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

import numpy as np  # noqa: E402

DATA = GAME / "src" / "data"
LEVELS_JSON = DATA / "levels.json"
GHOST_DIR = DATA / "ghosts"
SUMMARY_JSON = DATA / "ghosts_summary.json"
FIXTURES = GAME / "tests" / "fixtures"
CACHE_DIR = TOOLS / ".cache"

# ---------------------------------------------------------------- game constants (appendix A)
G = 9.81
B_TROLLEY = 0.3
C_PIVOT = 0.002
RAIL_Y = 1.25
BALL_R = 0.06
BEAM_Y = 1.30
SUB_HZ = 120
TICK_HZ = 60
HOLD_SUB = 60
REST_V = 0.05
MAX_SUB = 7200

DUMMY_WALL = (9.0, 9.1, 0.05)  # planner needs >= 1 wall (walls=() crashes CasADi)
AI_MARGIN = 0.02
AI_TENSION_MIN = 1.5
AI_CEILING = 1.28  # ball top <= beam 1.30 - 2 cm
HUMAN_MARGIN = 0.002
HUMAN_TENSION_MIN = 0.1
HUMAN_CEILING = 1.298  # decision: the human-like rules keep a 2 mm (not 2 cm) margin to the beam too
CANDIDATE_TIMEOUT_S = 600.0

SEED_NAMES = ("enter_fast", "enter_pump", "escape_fast", "escape_pump")
GHOST_LABELS = {"ai": "AI", "calm": "AI(お手本)", "research_fast": "AI(省エネ)", "research_pump": "AI(ブランコ)"}


# ================================================================ JS number formatting / hashing

def js_number(v) -> str:
    """ECMAScript Number::toString(10) for a finite double (what `String(n)` returns).

    Python's repr gives the shortest round-trip digit string (the same digits V8 picks);
    only the layout (exponent thresholds, '.0' suffix, '-0') differs, and is redone here.
    """
    if isinstance(v, bool):
        raise TypeError("booleans are not numbers")
    v = float(v)
    if not math.isfinite(v):
        raise ValueError(f"non-finite number {v!r}")
    if v == 0.0:
        return "0"  # String(-0) === "0"
    sign = "-" if v < 0 else ""
    r = repr(abs(v))
    if "e" in r:
        mant, exp_s = r.split("e")
        exp = int(exp_s)
    else:
        mant, exp = r, 0
    ip, _, fp = mant.partition(".")
    digits = (ip + fp).lstrip("0")
    stripped = digits.rstrip("0")
    tz = len(digits) - len(stripped)
    k = len(stripped)
    n = exp - len(fp) + tz + k  # value = 0.d1..dk × 10^n
    if k <= n <= 21:
        return sign + stripped + "0" * (n - k)
    if 0 < n <= 21:
        return sign + stripped[:n] + "." + stripped[n:]
    if -6 < n <= 0:
        return sign + "0." + "0" * (-n) + stripped
    e = n - 1
    es = ("+" if e >= 0 else "-") + str(abs(e))
    if k == 1:
        return sign + stripped + "e" + es
    return sign + stripped[0] + "." + stripped[1:] + "e" + es


def _json_str(s: str) -> str:
    return json.dumps(s, ensure_ascii=False)


def canonical_json(obj) -> str:
    """canonicalJson of spec §6.1: sorted keys, no whitespace, numbers as String(n),
    keys whose value is None (JS undefined) omitted, array order kept."""
    if obj is None:
        return "null"
    if isinstance(obj, bool):
        return "true" if obj else "false"
    if isinstance(obj, (int, float, np.integer, np.floating)):
        return js_number(obj)
    if isinstance(obj, str):
        return _json_str(obj)
    if isinstance(obj, dict):
        parts = [f"{_json_str(k)}:{canonical_json(obj[k])}" for k in sorted(obj) if obj[k] is not None]
        return "{" + ",".join(parts) + "}"
    if isinstance(obj, (list, tuple)):
        return "[" + ",".join(canonical_json(x) for x in obj) + "]"
    raise TypeError(f"cannot canonicalise {type(obj).__name__}")


def fnv1a32(data: bytes) -> int:
    h = 0x811C9DC5
    for b in data:
        h ^= b
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


def level_hash(phys: dict) -> str:
    return f"{fnv1a32(canonical_json(phys).encode('utf-8')):08x}"


def sha256_json(obj) -> str:
    return hashlib.sha256(canonical_json(obj).encode("utf-8")).hexdigest()


# ================================================================ pretty JSON (levels.json, ghosts)

def _inline(obj) -> str:
    if isinstance(obj, dict):
        if not obj:
            return "{}"
        return "{ " + ", ".join(f"{_json_str(k)}: {_inline(v)}" for k, v in obj.items()) + " }"
    if isinstance(obj, (list, tuple)):
        return "[" + ", ".join(_inline(x) for x in obj) + "]"
    if obj is None:
        return "null"
    if isinstance(obj, bool):
        return "true" if obj else "false"
    if isinstance(obj, (int, float, np.integer, np.floating)):
        return js_number(obj)
    if isinstance(obj, str):
        return _json_str(obj)
    raise TypeError(type(obj).__name__)


def pretty_json(obj, width: int = 120, indent: int = 0) -> str:
    """Readable JSON: a value is written on one line when it fits in `width`,
    otherwise its members go on their own lines.  Numbers use String(n)."""
    one = _inline(obj)
    if not isinstance(obj, (dict, list, tuple)) or indent + len(one) <= width or not obj:
        return one
    pad = " " * (indent + 2)
    if isinstance(obj, dict):
        items = []
        for k, v in obj.items():
            key = f"{_json_str(k)}: "
            items.append(pad + key + pretty_json(v, width, indent + 2).lstrip())
        return "{\n" + ",\n".join(items) + "\n" + " " * indent + "}"
    items = [pad + pretty_json(v, width, indent + 2).lstrip() for v in obj]
    return "[\n" + ",\n".join(items) + "\n" + " " * indent + "]"


def write_text_atomic(path: Path, text: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f".tmp{os.getpid()}")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def load_levels(path: Path = LEVELS_JSON) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def save_levels(doc: dict, path: Path = LEVELS_JSON):
    write_text_atomic(path, pretty_json(doc) + "\n")


def level_by_id(doc: dict) -> dict:
    return {lv["id"]: lv for lv in doc["levels"]}


def r3(v: float) -> float:
    """Round to 3 decimals (levels.json holds finite numbers with <= 3 decimals)."""
    return float(round(v + 0.0, 3)) + 0.0


# ================================================================ level facts / placeholders (§5.3)

def req_deg(h: float, L: float) -> float:
    """Angle at which the ball centre passes a wall top at h + r (margin 0)."""
    c = (RAIL_Y - h - BALL_R) / L
    return math.degrees(math.acos(max(-1.0, min(1.0, c))))


def level_facts(phys: dict) -> dict:
    L = phys["L"]
    pockets = [z for z in phys["phases"] if z["kind"] == "pocket"]
    return {
        "reqDeg": [req_deg(w["h"], L) for w in phys["walls"]],
        "beamDeg": math.degrees(math.acos(max(-1.0, min(1.0, (RAIL_Y - (BEAM_Y - BALL_R)) / L)))),
        "gapCm": (pockets[0]["xb"] - pockets[0]["xa"]) * 100 if pockets else None,
        "periodS": 2 * math.pi * math.sqrt(L / G),
        "wallH": [w["h"] for w in phys["walls"]],
    }


PLACEHOLDER_RE = re.compile(r"\{([A-Za-z]+[0-9]?)\}")


def placeholder_values(phys: dict) -> dict:
    f = level_facts(phys)
    vals = {"beam": f"{round(f['beamDeg'])}", "period": f"{f['periodS']:.2f}", "Fmax": f"{round(phys['Fmax'])}"}
    for i, h in enumerate(f["wallH"]):
        vals[f"h{i}"] = f"{h:.2f}"
        vals[f"req{i}"] = f"{round(f['reqDeg'][i])}"
    if f["gapCm"] is not None:
        vals["gap"] = f"{round(f['gapCm'])}"
    if phys.get("egg"):
        vals["Tmax"] = f"{round(phys['egg']['Tmax'])}"
    return vals


def fmt_level_text(text: str, phys: dict) -> str:
    vals = placeholder_values(phys)

    def sub(m):
        if m.group(1) not in vals:
            raise KeyError(f"unresolvable placeholder {{{m.group(1)}}} in {text!r}")
        return vals[m.group(1)]
    return PLACEHOLDER_RE.sub(sub, text)


# ================================================================ geometry used by validation / checks

def point_slab_dist2(px, py, w) -> float:
    x0, x1, h = w
    dx = max(x0 - px, 0.0, px - x1)
    dy = max(py - h, 0.0)
    return dx * dx + dy * dy


def seg_slab_dist2(ax, ay, bx, by, w) -> float:
    """Squared distance between segment A-B and the slab x0<=x<=x1, y<=h (0 if they meet)."""
    x0, x1, h = w
    lo, hi = min(ax, bx), max(ax, bx)
    if hi >= x0 and lo <= x1:
        # y of the segment over the x-overlap; its minimum is at an end of the overlap
        if abs(bx - ax) < 1e-15:
            ymin = min(ay, by)
        else:
            xa, xb = max(lo, x0), min(hi, x1)
            ya = ay + (by - ay) * (xa - ax) / (bx - ax)
            yb = ay + (by - ay) * (xb - ax) / (bx - ax)
            ymin = min(ya, yb)
        if ymin <= h:
            return 0.0
    d2 = min(point_slab_dist2(ax, ay, w), point_slab_dist2(bx, by, w))
    dx, dy = bx - ax, by - ay
    len2 = dx * dx + dy * dy
    for cx in (x0, x1):
        t = 0.0 if len2 == 0 else max(0.0, min(1.0, ((cx - ax) * dx + (h - ay) * dy) / len2))
        ex, ey = ax + t * dx - cx, ay + t * dy - h
        d2 = min(d2, ex * ex + ey * ey)
    return d2


def walls_of(phys: dict) -> list[tuple[float, float, float]]:
    return [(w["x0"], w["x1"], w["h"]) for w in phys["walls"]]


# ================================================================ validateLevel (§6.1) + schema checks

class LevelError(ValueError):
    pass


def validate_level(d: dict, campaign: bool = True):
    """Python re-implementation of validateLevel (spec §6.1). Raises LevelError."""
    lid = d.get("id", "?")

    def need(cond, msg):
        if not cond:
            raise LevelError(f"{lid}: {msg}")

    p = d["physics"]
    rail = p["rail"]
    walls = p["walls"]
    need(len(walls) <= 4, "at most 4 walls")
    for i, w in enumerate(walls):
        need(0 < w["x1"] - w["x0"], f"wall {i}: x1 must exceed x0")
        need(0 < w["h"] <= 0.95, f"wall {i}: 0 < h <= 0.95")
        need(rail[0] - 0.5 <= w["x0"] and w["x1"] <= rail[1] + 0.5, f"wall {i}: outside rail ± 0.5")
        if i:
            need(walls[i - 1]["x0"] < w["x0"], f"wall {i}: walls must be sorted by x0")
            need(walls[i - 1]["x1"] <= w["x0"], f"wall {i}: overlaps wall {i - 1}")
    need(rail[0] < p["startX"] < rail[1], "rail[0] < startX < rail[1]")
    need(0.3 <= p["L"] <= 1.0, "0.3 <= L <= 1.0")
    need(0 < p["m"] and 0 < p["M"], "masses must be positive")
    need(0 < p["Fmax"] <= 40, "0 < Fmax <= 40")
    need(0 < p["restDeg"] <= 6, "0 < restDeg <= 6")
    ph = p["phases"]
    need(1 <= len(ph) <= 2, "1 or 2 phases")
    for i, z in enumerate(ph):
        need(z["kind"] in ("pad", "pocket"), f"phase {i}: kind")
        need(z["xa"] < z["xb"], f"phase {i}: xa < xb")
        c = 0.5 * (z["xa"] + z["xb"])
        need(rail[0] <= c <= rail[1], f"phase {i}: zone centre outside the rail")
    bx, by = p["startX"], RAIL_Y - p["L"]
    for i, w in enumerate(walls_of(p)):
        need(point_slab_dist2(bx, by, w) >= (BALL_R + 0.01) ** 2, f"start ball within 1 cm of wall {i}")
        need(seg_slab_dist2(p["startX"], RAIL_Y, bx, by, w) > 0, f"start string meets wall {i}")
    z0 = ph[0]
    need(not (z0["xa"] <= bx <= z0["xb"]), "start ball inside the phase-0 zone")
    ai = d["ai"]
    need(len(ai["xGoal"]) == len(ph), "ai.xGoal count must equal phases")
    if not ai.get("compose"):
        for i, (xg, z) in enumerate(zip(ai["xGoal"], ph)):
            need(z["xa"] <= xg <= z["xb"], f"ai.xGoal[{i}] outside its zone")
    for s in d["splits"]:
        if "wall" in s:
            need(0 <= s["wall"] < len(walls) and s["dir"] in (1, -1), f"bad split {s}")
        else:
            need(0 <= s["phase"] < len(ph), f"bad split {s}")
    if campaign:
        need(d.get("hints") is not None, "campaign levels need hints")
    if d.get("hints") is not None:
        for lang in ("ja", "en"):
            need(len(d["hints"][lang]) == 3, f"hints.{lang} must have 3 entries")
    if d["cargo"] == "egg":
        need(p.get("egg") is not None, "egg cargo needs physics.egg")
        need(p["egg"]["Tmax"] > p["m"] * G, "egg would crack at rest")


def texts_of(d: dict):
    """(label, ja, en) for every translatable text of a level."""
    out = [("name", d["name"]["ja"], d["name"]["en"]), ("concept", d["concept"]["ja"], d["concept"]["en"])]
    if d.get("hints"):
        for i in range(3):
            out.append((f"hint{i + 1}", d["hints"]["ja"][i], d["hints"]["en"][i]))
    return out


def validate_levels_file(doc: dict, expect: int = 18) -> list[str]:
    """validateLevel on every level plus the levels_schema checks. Returns a report."""
    rep = []
    if doc.get("format") != 1:
        raise LevelError("format must be 1")
    lvls = doc["levels"]
    ids = [lv["id"] for lv in lvls]
    if len(set(ids)) != len(ids):
        raise LevelError("duplicate level ids")
    if len(lvls) != expect:
        raise LevelError(f"expected {expect} levels, got {len(lvls)}")
    for lv in lvls:
        validate_level(lv, campaign=True)
        if lv["id"] != f"{lv['world']}-{lv['order']}":
            raise LevelError(f"{lv['id']}: id does not match world/order")
        for label, ja, en in texts_of(lv):
            pj, pe = sorted(PLACEHOLDER_RE.findall(ja)), sorted(PLACEHOLDER_RE.findall(en))
            if pj != pe:
                raise LevelError(f"{lv['id']} {label}: placeholders differ ja={pj} en={pe}")
            fmt_level_text(ja, lv["physics"])
            fmt_level_text(en, lv["physics"])
        if lv["ai"].get("compose"):
            a, _, b = lv["ai"]["compose"]
            if a not in ids or b not in ids:
                raise LevelError(f"{lv['id']}: compose refers to unknown levels")
        for s in lv["ai"].get("seeds", []) + lv["ai"].get("extras", []):
            if s not in SEED_NAMES:
                raise LevelError(f"{lv['id']}: unknown research seed {s}")
        f = level_facts(lv["physics"])
        rep.append(f"{lv['id']:4s} ok  hash={level_hash(lv['physics'])}  req="
                   + "/".join(f"{a:.1f}" for a in f["reqDeg"]) + f"  period={f['periodS']:.2f}s"
                   + (f"  gap={f['gapCm']:.0f}cm" if f["gapCm"] is not None else ""))
    return rep


# ================================================================ planner problems (§8.2 2, 3b)

RULES = {
    # the AI's own rules (§8.2 2)
    "ai": {"margin_ball": AI_MARGIN, "margin_string": AI_MARGIN, "rail_margin": 0.03,
           "tension_min": AI_TENSION_MIN, "ceiling": AI_CEILING},
    # "human-like" rules for the crown headroom probe (§8.2 3b)
    "human": {"margin_ball": HUMAN_MARGIN, "margin_string": HUMAN_MARGIN, "rail_margin": 0.0,
              "tension_min": HUMAN_TENSION_MIN, "ceiling": HUMAN_CEILING},
}
CACHE_VERSION = 1
PLANNER_WALL_S = 120.0  # IPOPT max_wall_s of one solve (§8.2 2)
RETRY_FACTOR = 2.0  # a retried time-limited candidate gets 2x the IPOPT wall time and 2x the kill time


def ai_margin_mm(lv: dict) -> float | None:
    """The level's AI wall margin (LevelDef.ai.marginMm, §12.1 fix) when it differs from the
    default 20 mm, else None (so the problem digests of default levels stay unchanged)."""
    mm = lv["ai"].get("marginMm")
    if mm is None or abs(mm - AI_MARGIN * 1000) < 1e-9:
        return None
    return float(mm)


def summary_margin_mm(lv: dict) -> int | float:
    """ghosts_summary aiMarginMm: the margin the level's AI kept (default 20)."""
    mm = lv["ai"].get("marginMm", AI_MARGIN * 1000)
    return int(mm) if float(mm).is_integer() else float(mm)


def n_nodes(T: float) -> int:
    return max(100, int(math.floor(50 * T + 0.5)))


def seed_face(seed: str) -> dict:
    """The research problem a seed was solved on (2-2 for enter, 2-3 for escape)."""
    mission = seed.split("_")[0]
    x_start, x_goal = (0.0, 1.63) if mission == "enter" else (1.63, 0.0)
    return {"M": 2.0, "m": 1.0, "L": 1.0, "walls": [[1.30, 1.42, 0.75], [1.84, 1.96, 0.75]],
            "x_start": x_start, "x_goal": x_goal, "x_min": -1.0, "x_max": 3.2, "F_max": 40.0,
            "tension_max": None}


def human_goal_x(lv: dict) -> float:
    """Headroom goal: trolley at the near edge of the zone, 0.5 cm inside a pad,
    ball radius + 0.5 cm inside a pocket (§8.2 3b)."""
    p = lv["physics"]
    z = p["phases"][0]
    off = 0.005 + (BALL_R if z["kind"] == "pocket" else 0.0)
    if p["startX"] < z["xa"]:
        return r3(z["xa"] + off)
    return r3(z["xb"] - off)


def human_goals(lv: dict, with_ai_goal: bool = True) -> list[float]:
    """Trolley goals the headroom probe may use: the zone's near edge (§8.2 3b) and, with
    `with_ai_goal`, the AI's own goal ai.xGoal[0].  The human-like rules are meant to be a
    relaxation of the AI's (a human can always stop where the AI stops); on pump levels and
    pockets the near edge alone is the harder goal (3-1 / 3-2: infeasible even at the AI's T_min)."""
    near = human_goal_x(lv)
    ai = r3(lv["ai"]["xGoal"][0])
    return [near] if not with_ai_goal or abs(near - ai) < 1e-9 else [near, ai]


def level_face(lv: dict, rules: str = "ai", goal: float | None = None) -> dict:
    """Planner face of a level.  Human-like rules: the goal is `goal` (default: the near edge)."""
    p, ai = lv["physics"], lv["ai"]
    face = {"M": p["M"], "m": p["m"], "L": p["L"], "walls": [list(w) for w in walls_of(p)],
            "x_start": p["startX"], "x_goal": ai["xGoal"][0], "x_min": p["rail"][0], "x_max": p["rail"][1],
            "F_max": p["Fmax"], "tension_max": ai.get("tensionMax")}
    if rules == "human":
        face["x_goal"] = human_goal_x(lv) if goal is None else goal
        face["tension_max"] = p["egg"]["Tmax"] if p.get("egg") else None
    return face


def morph_seed_for(lv: dict) -> str:
    """Seed used by the morph candidate: enter/escape by direction, pump when F_max < 20 N."""
    p, ai = lv["physics"], lv["ai"]
    mission = "escape" if ai["xGoal"][0] < p["startX"] else "enter"
    return f"{mission}_{'pump' if p['Fmax'] < 20 else 'fast'}"


def make_problem(face: dict, rules: str, T: float, margin_mm: float | None = None) -> dict:
    """Planner problem (the cache digest covers all of it).  `margin_mm` overrides the AI
    rules' margin_ball = margin_string (ai.marginMm); None (the default 20 mm) leaves the key
    out, so the digests of levels without an override are the same as before."""
    T = r3(T)
    pr = {"face": face, "rules": rules, "T": T, "N": n_nodes(T)}
    if margin_mm is not None:
        if rules != "ai":
            raise ValueError("a margin override applies to the ai rules only")
        pr["marginMm"] = margin_mm
    return pr


def build_planner(face: dict, rules: str, T: float, N: int | None = None, margin_mm: float | None = None,
                  wall_s: float | None = None):
    """(plant, scene, cfg, extra) for ballwall.planner.plan.  `margin_mm` overrides the ai
    rules' wall margins, `wall_s` IPOPT's max_wall_s (default 120 s)."""
    from ballwall.params import Plant, Scene, Wall
    from ballwall.planner import PlanConfig
    R = dict(RULES[rules])
    if margin_mm is not None:
        R["margin_ball"] = R["margin_string"] = margin_mm / 1000.0
    plant = Plant(M=float(face["M"]), m=float(face["m"]), L=float(face["L"]))
    walls = tuple(Wall(float(a), float(b), float(h)) for a, b, h in face["walls"]) or (Wall(*DUMMY_WALL),)
    scene = Scene(rail_y=RAIL_Y, ball_r=BALL_R, walls=walls, x_start=float(face["x_start"]),
                  x_goal=float(face["x_goal"]), x_min=float(face["x_min"]), x_max=float(face["x_max"]))
    cfg = PlanConfig(T=float(T), N=N or n_nodes(T), objective="effort", F_max=float(face["F_max"]), v_max=4.0,
                     margin_ball=R["margin_ball"], margin_string=R["margin_string"], rail_margin=R["rail_margin"],
                     tension_min=R["tension_min"], cont_start=0.25, max_wall_s=float(wall_s or PLANNER_WALL_S))
    return plant, scene, cfg, make_extra(plant, R["ceiling"], face.get("tension_max"))


def make_extra(plant, ceiling: float, tension_max: float | None):
    """Game-specific constraints added through planner.plan(extra=...) (§8.2 2):
    ceiling at nodes and midpoints, and optionally a tension cap at the start,
    middle and end of every interval."""
    import casadi as ca
    from ballwall.dynamics import tension

    def extra(opti, X, U, Xm):
        for th in (X[2, :], Xm[2, :]):
            opti.subject_to(RAIL_Y - plant.L * ca.cos(th) + BALL_R <= ceiling)
        if tension_max is not None:
            s, u = ca.SX.sym("s", 4), ca.SX.sym("u")
            ten = ca.Function("ten_cap", [s, u], [tension(s, u, plant, ca)]).map(U.shape[1])
            for Xs in (X[:, :-1], Xm, X[:, 1:]):
                opti.subject_to(ten(Xs, U) <= tension_max)
    return extra


# ---------------------------------------------------------------- seeds and morph

def load_seed_plan(name: str):
    from ballwall.search import load_seed
    mission, preset = name.split("_")
    p = load_seed(mission, preset)
    if p is None:
        raise FileNotFoundError(f"research seed {name} not found")
    return p


def plan_max_tension(p, plant) -> float:
    from ballwall.dynamics import tension
    return float(np.max(tension(p.X[:, :-1], p.U, plant)))


def wall_tracks(src: list, dst: list):
    """Pair the seed's walls with the level's walls by nearest x0 (greedy).
    Unmatched level walls grow from 0.02 m; unmatched seed walls shrink to 0.02 m
    and are dropped at a = 1.  Returns [(from, to, vanishes)]."""
    pairs = sorted((abs(s[0] - d[0]), i, j) for i, s in enumerate(src) for j, d in enumerate(dst))
    used_s, match = set(), {}
    for _, i, j in pairs:
        if i in used_s or j in match:
            continue
        match[j] = i
        used_s.add(i)
    tracks = []
    for j, d in enumerate(dst):
        tracks.append((list(src[match[j]]) if j in match else [d[0], d[1], 0.02], list(d), False))
    for i, s in enumerate(src):
        if i not in used_s:
            tracks.append((list(s), [s[0], s[1], 0.02], True))
    return tracks


def morph_face(src: dict, dst: dict, a: float, tmax_src: float | None) -> dict:
    if a >= 1.0:
        return dst
    lerp = lambda u, v: (1.0 - a) * u + a * v  # noqa: E731
    face = {k: lerp(float(src[k]), float(dst[k])) for k in ("M", "m", "L", "x_start", "x_goal", "x_min", "x_max", "F_max")}
    face["walls"] = [[lerp(s[0], d[0]), lerp(s[1], d[1]), lerp(s[2], d[2])] for s, d, _ in wall_tracks(src["walls"], dst["walls"])]
    face["tension_max"] = None if dst.get("tension_max") is None else lerp(tmax_src, dst["tension_max"])
    return face


def run_morph(seed: str, src: dict, dst: dict, rules: str, T: float, log=print, margin_mm: float | None = None,
              wall_s: float | None = None):
    """Shape morph (§8.2 3): solve the seed's problem at this T, then move the walls,
    start, goal, rail, F_max and plant to this level with a going 0 -> 1, each solve
    warm-started from the last (continuation=False).  Step 0.25, x0.5 on failure,
    x1.5 on success, give up below 0.01."""
    from ballwall.params import Plant
    from ballwall.planner import plan
    seed_plan = load_seed_plan(seed)
    tmax_src = None
    if dst.get("tension_max") is not None:
        tmax_src = max(dst["tension_max"], plan_max_tension(seed_plan, Plant()) + 0.5)

    def solve(a, init):
        plant, scene, cfg, extra = build_planner(morph_face(src, dst, a, tmax_src), rules, T, margin_mm=margin_mm,
                                                 wall_s=wall_s)
        return plan(plant, scene, cfg, init=init, continuation=False, extra=extra)

    cur = solve(0.0, seed_plan)
    a_ok, step = 0.0, 0.25
    while a_ok < 1.0:
        a = min(1.0, a_ok + step)
        try:
            cur = solve(a, cur)
            log(f"morph {seed}: a={a:.3f} ok")
            a_ok, step = a, step * 1.5
        except RuntimeError:
            step /= 2
            log(f"morph {seed}: a={a:.3f} failed, step -> {step:.4f}")
            if step < 0.01:
                raise RuntimeError(f"morph from {seed} failed at a={a:.3f}")
    return cur


# ================================================================ candidates, cache, child processes

def cand_scratch():
    return {"kind": "scratch"}


def cand_stretch(res: dict):
    """Warm start from a solved plan, time-stretched onto the new T (plan(init=...))."""
    return {"kind": "init", "init": res["digest"], "initLevel": res["level"]}


def cand_seed(seed: str):
    return {"kind": "seed", "seed": seed}


def cand_morph(seed: str):
    return {"kind": "morph", "seed": seed, "from": seed_face(seed)}


def cand_retry(c: dict) -> dict:
    """Second attempt of a start whose result hit a time limit (IPOPT's wall time or the
    kill): its own cache key, RETRY_FACTOR x the IPOPT wall time (the kill time likewise,
    see Scheduler.run)."""
    return {**c, "attempt": 2, "wallS": PLANNER_WALL_S * RETRY_FACTOR}


def time_limited(res: dict) -> bool:
    """A failure that hit a time limit (IPOPT's max_wall_s or the per-candidate kill) rather
    than one IPOPT decided (e.g. Infeasible_Problem_Detected)."""
    reason = (res or {}).get("reason") or ""
    return reason.startswith("timeout") or "WallTime" in reason or "CpuTime" in reason


def cand_name(c: dict) -> str:
    k = c["kind"]
    if k == "init":
        name = f"stretch({c['init'][:8]})"
    elif k in ("seed", "morph"):
        name = f"{k}({c['seed']})"
    else:
        name = k
    return name + (f"#{c['attempt']}" if c.get("attempt") else "")


def job_digest(problem: dict, cand: dict) -> str:
    return sha256_json({"v": CACHE_VERSION, "problem": problem, "cand": cand})


def cache_path(level: str, digest: str) -> Path:
    return CACHE_DIR / level / f"{digest}.npz"


def save_result_npz(path: Path, ok: bool, meta: dict, t=None, X=None, U=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f".tmp{os.getpid()}.npz")
    arrays = {"ok": np.array(1 if ok else 0), "meta": np.array(json.dumps(meta))}
    if ok:
        arrays.update(t=np.asarray(t, float), X=np.asarray(X, float), U=np.asarray(U, float))
    np.savez(tmp, **arrays)
    os.replace(tmp, path)


def load_result_npz(path: Path) -> dict:
    with np.load(path) as z:
        meta = json.loads(str(z["meta"]))
        res = {"ok": bool(int(z["ok"])), **meta}
        if res["ok"]:
            res.update(t=z["t"].copy(), X=z["X"].copy(), U=z["U"].copy())
    return res


def plan_from_result(res: dict):
    from ballwall.planner import Plan
    t = np.asarray(res["t"], float)
    return Plan(t=t, X=np.asarray(res["X"], float), U=np.asarray(res["U"], float), dt=float(t[1] - t[0]),
                A=None, B=None, stats={})


def solve_candidate(job: dict, log=print):
    from ballwall.planner import plan
    pr, cand = job["problem"], job["cand"]
    face, rules, T = pr["face"], pr["rules"], pr["T"]
    margin_mm, wall_s = pr.get("marginMm"), cand.get("wallS")
    plant, scene, cfg, extra = build_planner(face, rules, T, pr["N"], margin_mm=margin_mm, wall_s=wall_s)
    k = cand["kind"]
    if k == "scratch":
        return plan(plant, scene, cfg, continuation=True, extra=extra)
    if k == "init":
        init = plan_from_result(load_result_npz(cache_path(cand["initLevel"], cand["init"])))
        return plan(plant, scene, cfg, init=init, continuation=False, extra=extra)
    if k == "seed":
        return plan(plant, scene, cfg, init=load_seed_plan(cand["seed"]), continuation=False, extra=extra)
    if k == "morph":
        return run_morph(cand["seed"], cand["from"], face, rules, T, log=log, margin_mm=margin_mm, wall_s=wall_s)
    raise ValueError(k)


def _child_entry(job: dict, out_path: str, log_path: str):
    """Runs in a spawned child: solve one candidate, write the result npz."""
    fd = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
    os.dup2(fd, 1)
    os.dup2(fd, 2)
    sys.stdout = os.fdopen(1, "w", buffering=1)
    sys.stderr = sys.stdout
    t0 = time.time()
    meta = {"digest": job["digest"], "level": job["level"], "cand": job["cand"], "problem": job["problem"]}
    try:
        p = solve_candidate(job, log=lambda s: print(s, flush=True))
        meta.update(secs=time.time() - t0, objective=float(p.stats["objective"]),
                    peak=float(p.stats["peak_force"]), status=p.stats["status"],
                    iterations=[int(i) for i in p.stats["iterations"]])
        save_result_npz(Path(out_path), True, meta, p.t, p.X, p.U)
    except Exception as e:  # a failed candidate must not sink the search
        meta.update(secs=time.time() - t0, reason=f"{type(e).__name__}: {e}"[:400])
        save_result_npz(Path(out_path), False, meta)


class Scheduler:
    """Runs planner candidates, each in its own spawned child process, at most
    `jobs` at a time, killing a child after `timeout` s (counted as infeasible).
    Results (successes, IPOPT failures and timeouts) are cached on disk by digest."""

    def __init__(self, jobs: int, timeout: float = CANDIDATE_TIMEOUT_S, force: bool = False, log=print):
        import multiprocessing as mp
        self.ctx = mp.get_context("spawn")
        self.sem = threading.Semaphore(max(1, jobs))
        self.timeout = timeout
        self.force = force
        self.t_start = time.time()
        self.log = log
        self.stats = {"solved": 0, "failed": 0, "timeout": 0, "cached": 0, "crashed": 0}
        self._lock = threading.Lock()

    def _count(self, key):
        with self._lock:
            self.stats[key] += 1

    def run(self, level: str, problem: dict, cand: dict, tag: str = "", timeout: float | None = None) -> dict:
        """Solve one candidate (or take it from the cache).  A candidate with a longer IPOPT wall
        time (cand_retry's "wallS") gets a proportionally longer kill time unless `timeout` is given."""
        if timeout is None:
            timeout = self.timeout * max(1.0, float(cand.get("wallS") or PLANNER_WALL_S) / PLANNER_WALL_S)
        digest = job_digest(problem, cand)
        path = cache_path(level, digest)
        name = f"[{level}] {tag} T={problem['T']:g} {problem['rules']} {cand_name(cand)}"
        if path.exists() and (not self.force or path.stat().st_mtime >= self.t_start):
            res = load_result_npz(path)
            self._count("cached")
            self.log(f"{name}: cached {'ok' if res['ok'] else 'fail'}"
                     + (f" obj={res['objective']:.1f} peak={res['peak']:.2f}" if res["ok"] else ""))
            return res
        job = {"digest": digest, "level": level, "problem": problem, "cand": cand}
        with self.sem:
            path.parent.mkdir(parents=True, exist_ok=True)
            t0 = time.time()
            proc = self.ctx.Process(target=_child_entry, args=(job, str(path), str(path.with_suffix(".log"))),
                                    daemon=True)
            proc.start()
            proc.join(timeout)
            if proc.is_alive():
                proc.kill()
                proc.join()
                save_result_npz(path, False, {"digest": digest, "level": level, "cand": cand, "problem": problem,
                                              "secs": time.time() - t0, "reason": f"timeout {timeout:.0f}s (killed)"})
                self._count("timeout")
            elif not path.exists():
                self._count("crashed")
                self.log(f"{name}: child crashed (exit {proc.exitcode}); not cached")
                return {"ok": False, "digest": digest, "level": level, "reason": f"crash exit {proc.exitcode}",
                        "secs": time.time() - t0}
        res = load_result_npz(path)
        if res["ok"]:
            self._count("solved")
            self.log(f"{name}: ok obj={res['objective']:.1f} peak={res['peak']:.2f} ({res['secs']:.0f}s)")
        else:
            if not res["reason"].startswith("timeout"):
                self._count("failed")
            self.log(f"{name}: FAIL ({res['secs']:.0f}s) {res['reason'][:100]}")
        return res

    def run_many(self, level: str, problem: dict, cands: list, tag: str = "") -> list[dict]:
        """Every candidate in parallel (each still waits for a free job slot)."""
        out = [None] * len(cands)

        def work(i):
            out[i] = self.run(level, problem, cands[i], tag)
        ths = [threading.Thread(target=work, args=(i,)) for i in range(len(cands))]
        for th in ths:
            th.start()
        for th in ths:
            th.join()
        return out


def best_of(results: list[dict]) -> dict | None:
    """Lowest objective among the solved candidates (candidate order breaks ties)."""
    best = None
    for r in results:
        if r and r["ok"] and (best is None or r["objective"] < best["objective"] * (1 - 1e-9)):
            best = r
    return best


# ================================================================ trajectories (§8.2 6)

class Traj:
    """Node trajectory: times t (n,), states X (4, n) = [x, v, th, w], force U (n-1,)
    held on each interval.  Nodes need not be uniformly spaced (compositions)."""

    def __init__(self, t, X, U):
        self.t = np.asarray(t, float)
        self.X = np.asarray(X, float)
        self.U = np.asarray(U, float)
        assert self.X.shape == (4, len(self.t)) and len(self.U) == len(self.t) - 1

    @classmethod
    def of(cls, res_or_plan):
        if isinstance(res_or_plan, dict):
            return cls(res_or_plan["t"], res_or_plan["X"], res_or_plan["U"])
        return cls(res_or_plan.t, res_or_plan.X, res_or_plan.U)

    @property
    def T(self) -> float:
        return float(self.t[-1])

    def states(self, ts):
        """Cubic Hermite for x and th (v, w as slopes); v, w from the Hermite derivative.
        After the end: the final (rest) state."""
        ts = np.asarray(ts, float)
        t = self.t
        idx = np.clip(np.searchsorted(t, ts, side="right") - 1, 0, len(t) - 2)
        t0, dt = t[idx], t[idx + 1] - t[idx]
        s = np.clip((ts - t0) / dt, 0.0, 1.0)
        s2, s3 = s * s, s * s * s
        h00, h10, h01, h11 = 2 * s3 - 3 * s2 + 1, s3 - 2 * s2 + s, -2 * s3 + 3 * s2, s3 - s2
        d00, d10, d01, d11 = 6 * s2 - 6 * s, 3 * s2 - 4 * s + 1, -6 * s2 + 6 * s, 3 * s2 - 2 * s
        out = np.empty((4, ts.size))
        for ip, im in ((0, 1), (2, 3)):
            p0, p1 = self.X[ip, idx], self.X[ip, idx + 1]
            m0, m1 = self.X[im, idx] * dt, self.X[im, idx + 1] * dt
            out[ip] = h00 * p0 + h10 * m0 + h01 * p1 + h11 * m1
            out[im] = (d00 * p0 + d10 * m0 + d01 * p1 + d11 * m1) / dt
        return out

    def force(self, ts):
        ts = np.asarray(ts, float)
        idx = np.searchsorted(self.t, ts, side="right") - 1
        F = np.zeros(ts.size)
        ok = (idx >= 0) & (idx < len(self.U))
        F[ok] = self.U[idx[ok]]
        return F

    def clipped(self, Fmax: float) -> "Traj":
        return Traj(self.t, self.X, np.clip(self.U, -Fmax, Fmax))


def compose(parts: list) -> Traj:
    """Concatenate trajectories and rests: parts are Traj or ('rest', seconds)."""
    ts, Xs, Us = [np.zeros(1)], None, []
    t_end = 0.0
    for part in parts:
        if isinstance(part, tuple):
            dur = float(part[1])
            ts.append(np.array([t_end + dur]))
            Xs = np.hstack([Xs, Xs[:, -1:] * np.array([[1], [0], [1], [0]])])
            Us.append(np.zeros(1))
            t_end += dur
            continue
        if Xs is None:
            Xs = part.X[:, :1]
        elif np.max(np.abs(Xs[:, -1] - part.X[:, 0])) > 1e-6:
            raise ValueError("composed trajectories do not join")
        ts.append(t_end + part.t[1:])
        Xs = np.hstack([Xs, part.X[:, 1:]])
        Us.append(part.U)
        t_end += part.T
    return Traj(np.concatenate(ts), Xs, np.concatenate(Us))


def n_samples(T: float, hz: int, extra_s: float = 1.0) -> int:
    return int(math.floor((T + extra_s) * hz + 1e-9)) + 1


# ================================================================ game rules on samples (§4.5, §4.6, §8.2 7-8)

def ball_xy(x, th, L):
    return x + L * np.sin(th), RAIL_Y - L * np.cos(th)


def wall_cross_events(bx, by, walls) -> list[tuple[int, int, int]]:
    """(sample k, wall i, dir) where the ball centre crosses the wall's centre x
    between samples k-1 and k while above the wall (by - r > h)."""
    ev = []
    for i, (x0, x1, h) in enumerate(walls):
        cx = 0.5 * (x0 + x1)
        a, b = bx[:-1] - cx, bx[1:] - cx
        fwd = np.nonzero((a < 0) & (b >= 0) & (by[1:] - BALL_R > h))[0]
        bwd = np.nonzero((a > 0) & (b <= 0) & (by[1:] - BALL_R > h))[0]
        ev += [(int(k) + 1, i, 1) for k in fwd] + [(int(k) + 1, i, -1) for k in bwd]
    return sorted(ev)


def success_scan(lv: dict, S) -> dict:
    """The game's success rule (§4.6) on 120 Hz samples S = [x, v, th, w] (sample k at k/120).
    Returns parSub (holdStart of the final phase) and the holdStart of every phase."""
    p = lv["physics"]
    L = p["L"]
    x, v, th, w = S
    bx, _ = ball_xy(x, th, L)
    E = 0.5 * L * L * w * w + G * L * (1 - np.cos(th))
    E_rest = G * L * (1 - math.cos(p["restDeg"] * math.pi / 180))
    phases = p["phases"]
    phase, hold, hold_start, done = 0, 0, -1, []
    for k in range(1, len(x)):
        z = phases[phase]
        if z["xa"] <= bx[k] <= z["xb"] and E[k] < E_rest and abs(v[k]) < REST_V:
            if hold == 0:
                hold_start = k
            hold += 1
            if hold == HOLD_SUB:
                done.append(hold_start)
                if phase == len(phases) - 1:
                    return {"parSub": hold_start, "phaseSub": done}
                phase, hold = phase + 1, 0
        elif hold > 0:
            hold = 0
    return {"parSub": None, "phaseSub": done}


def split_subs(lv: dict, S, phase_sub: list) -> list:
    """First sample at which each split of level.splits is achieved (None if never).
    Wall splits: the WallCross rule; phase splits: holdStart of that phase's hold."""
    p = lv["physics"]
    bx, by = ball_xy(S[0], S[2], p["L"])
    ev = wall_cross_events(bx, by, walls_of(p))
    out = []
    for s in lv["splits"]:
        if "wall" in s:
            ks = [k for k, i, d in ev if i == s["wall"] and d == s["dir"]]
            out.append(ks[0] if ks else None)
        else:
            out.append(phase_sub[s["phase"]] if s["phase"] < len(phase_sub) else None)
    return out


def count_pumps(lv: dict, S) -> int:
    """Apexes (sign change of w) with |th| >= 10 deg before the first wall crossing
    in the forward direction (towards the phase-0 goal).  0 without walls."""
    p = lv["physics"]
    if not p["walls"]:
        return 0
    fwd = 1 if lv["ai"]["xGoal"][0] > p["startX"] else -1
    bx, by = ball_xy(S[0], S[2], p["L"])
    ks = [k for k, _, d in wall_cross_events(bx, by, walls_of(p)) if d == fwd]
    if not ks:
        return 0
    w, th = S[3], S[2]
    apex = np.nonzero(w[:-1] * w[1:] < 0)[0] + 1
    return int(np.sum((apex < ks[0]) & (np.abs(th[apex]) >= math.radians(10))))


def traj_stats(lv: dict, tr: Traj) -> dict:
    """peakF, minGapMm (ball_clearance at 1 kHz), maxThetaDeg, max tension."""
    from ballwall.dynamics import tension
    from ballwall.geometry import ball_clearance
    from ballwall.params import Plant, Wall
    p = lv["physics"]
    ts = np.linspace(0.0, tr.T, int(math.floor(tr.T * 1000)) + 1)
    S = tr.states(ts)
    bx, by = ball_xy(S[0], S[2], p["L"])
    gaps = [ball_clearance(bx, by, Wall(*w), BALL_R) for w in walls_of(p)]
    plant = Plant(M=p["M"], m=p["m"], L=p["L"])
    ten = tension(S, tr.force(ts), plant)
    ten_nodes = tension(tr.X[:, :-1], tr.U, plant)
    ten_nodes_end = tension(tr.X[:, 1:], tr.U, plant)
    return {
        "peakF": float(np.max(np.abs(tr.U))) if len(tr.U) else 0.0,
        "minGapMm": float(np.min(gaps) * 1000) if gaps else None,
        "maxThetaDeg": float(np.degrees(np.max(np.abs(S[2])))),
        "maxTension": float(max(ten.max(), ten_nodes.max(), ten_nodes_end.max())),
        "minTension": float(min(ten.min(), ten_nodes.min(), ten_nodes_end.min())),
    }


def build_ghost(lv: dict, tr: Traj, kind: str, plan_T: float | None = None) -> dict:
    """Ghost entry of a ghost file (§8.2): 60 Hz Hermite samples + 1 s of rest,
    parSub / splitSub on 120 Hz Hermite samples, statistics."""
    from ghostcodec import encode_channel
    p = lv["physics"]
    tr = tr.clipped(p["Fmax"])
    T = tr.T
    n60 = n_samples(T, TICK_HZ)
    t60 = np.arange(n60) / TICK_HZ
    S60 = tr.states(t60)
    F60 = tr.force(t60)
    n120 = n_samples(T, SUB_HZ)
    S120 = tr.states(np.arange(n120) / SUB_HZ)
    sc = success_scan(lv, S120)
    if sc["parSub"] is None:
        raise RuntimeError(f"{lv['id']} {kind}: the success rule never holds on the samples")
    st = traj_stats(lv, tr)
    splits = split_subs(lv, S120, sc["phaseSub"])
    return {
        "kind": kind, "label": GHOST_LABELS[kind], "hz": TICK_HZ, "n": n60, "parSub": sc["parSub"],
        "planT": r3(plan_T if plan_T is not None else T),
        "peakF": round(st["peakF"], 2), "minGapMm": None if st["minGapMm"] is None else round(st["minGapMm"], 1),
        "maxThetaDeg": round(st["maxThetaDeg"], 1), "pumps": count_pumps(lv, S120), "splitSub": splits,
        "x": encode_channel(S60[0], "x"), "th": encode_channel(S60[2], "th"), "f": encode_channel(F60, "f"),
    }


# ================================================================ ghost checks (mirror of the §8.3 gate)

def decode_ghost(g: dict):
    from ghostcodec import decode_channel
    x = np.array(decode_channel(g["x"], "x"))
    th = np.array(decode_channel(g["th"], "th"))
    f = np.array(decode_channel(g["f"], "f"))
    if not (len(x) == len(th) == len(f) == g["n"]):
        raise ValueError(f"{g['kind']}: channel lengths {len(x)},{len(th)},{len(f)} != n={g['n']}")
    return x, th, f


def check_ghost(lv: dict, g: dict) -> dict:
    """Decode a ghost and check it like tests/data/ghosts_valid.test.ts will (§8.3):
    linear 120 Hz interpolation, central-difference v and w."""
    from ballwall.dynamics import tension
    from ballwall.params import Plant
    p = lv["physics"]
    L = p["L"]
    x60, th60, f60 = decode_ghost(g)
    n = len(x60)
    k2 = np.arange(2 * n - 1) / 2.0
    x = np.interp(k2, np.arange(n), x60)
    th = np.interp(k2, np.arange(n), th60)
    f = f60[np.minimum(np.floor(k2).astype(int), n - 1)]
    h = 1.0 / SUB_HZ
    v = np.gradient(x, h)
    w = np.gradient(th, h)
    bx, by = ball_xy(x, th, L)
    walls = walls_of(p)
    gap = min((math.sqrt(min(point_slab_dist2(a, b, wl) for a, b in zip(bx, by))) - BALL_R for wl in walls),
              default=None)
    str_d2 = min((min(seg_slab_dist2(xa, RAIL_Y, a, b, wl) for xa, a, b in zip(x, bx, by)) for wl in walls),
                 default=None)
    sc = success_scan(lv, np.vstack([x, v, th, w]))
    splits = split_subs(lv, np.vstack([x, v, th, w]), sc["phaseSub"])
    plant = Plant(M=p["M"], m=p["m"], L=L)
    ten = tension(np.vstack([x, v, th, w]), f, plant)
    res = {
        "kind": g["kind"], "n": n, "parSub": g["parSub"], "parSubTs": sc["parSub"],
        "minGapMm": None if gap is None else gap * 1000,
        "minStringGapMm": None if str_d2 is None else math.sqrt(str_d2) * 1000,
        "maxBallTop": float(np.max(by + BALL_R)),
        "xRange": (float(x.min()), float(x.max())),
        "peakFdecoded": float(np.max(np.abs(f60))),
        "maxTension": float(ten.max()),
        "splitSubTs": splits,
    }
    errs = []
    if gap is not None and gap < 0.015:
        errs.append(f"ball-wall gap {gap * 1000:.1f} mm < 15 mm")
    if str_d2 is not None and str_d2 <= 0:
        errs.append("string meets a wall")
    if res["maxBallTop"] >= BEAM_Y:
        errs.append(f"ball top {res['maxBallTop']:.4f} >= beam")
    if x.min() < p["rail"][0] or x.max() > p["rail"][1]:
        errs.append(f"trolley outside rail {res['xRange']}")
    if sc["parSub"] is None:
        errs.append("success rule never holds (TS-style samples)")
    elif abs(sc["parSub"] - g["parSub"]) > 3:
        errs.append(f"parSub {g['parSub']} vs TS-style {sc['parSub']}")
    if g["parSub"] + HOLD_SUB > 2 * n:
        errs.append("hold does not fit in the samples")
    for a, b in zip(g["splitSub"], splits):
        if a is None or b is None or abs(a - b) > 3:
            errs.append(f"splitSub {g['splitSub']} vs TS-style {splits}")
            break
    if g["peakF"] > p["Fmax"] + 1e-6 or res["peakFdecoded"] > p["Fmax"] + 1e-6:
        errs.append(f"peakF {g['peakF']} / decoded {res['peakFdecoded']} > Fmax {p['Fmax']}")
    if p.get("egg") and res["maxTension"] >= p["egg"]["Tmax"]:
        errs.append(f"tension {res['maxTension']:.2f} >= Tmax {p['egg']['Tmax']}")
    res["errors"] = errs
    return res
