"""Daily challenge pool (spec §8.2 `daily_pool.py`, §6.1 DailyDef / DailyPoolFile, §6.2 naming).

    uv run python game/tools/daily_pool.py [--count 84] [--jobs 22] [--timeout 600] [--force]
                                           [--out DIR] [--dry-run] [--check] [--rename]
                                           [--bisect [--ids d:0,d:5]]

Candidates (deterministic, numpy.random.default_rng(20261001))
  The five templates draw their candidates from one generator, in the order
  hop, hurdles, enter, escape, weak, 5 x their full quota each (18/12/24/18/12 for the 84-level
  pool), so the candidate list never depends on solver outcomes or on --count.  Positions and
  heights are on a 0.05 m grid, the pocket mouth on a 0.02 m grid.  A template takes its
  candidates in list order until `quota` of them pass (at most 5 x quota candidates; fewer
  passes is a failure and nothing is written).  Candidates run in parallel, but the accepted set
  is always "the first `quota` passing candidates in list order", as if they had been tried one
  by one.

Rejections (in this order)
  wall that does not block the hanging ball (h < 1.25 - L + 0.06 + 0.05, any wall), required
  angle over 70 deg (walls the ball must cross), pad centre past its limit, validateLevel (§6.1,
  Python port), a physics block identical to an earlier candidate's, then the planner: the
  smallest feasible T on the grid ({6, 7.5, 9} for weak, {2.5, 3, 4, 5, 6, 8} otherwise) must
  exist (i.e. be <= 9 s), and its ghost must pass the §8.3 gate (checked here in Python).

T grid search (per candidate; the pool is then bisected with --bisect, see below)
  Warm starts are tried one after the other and the first that solves wins (deterministic, and
  no slot waits for a 600 s kill once another start has already solved).
  probe: from a start T (weak 9; F_max 40 -> 4, 25 -> 5, else 6) upwards: the fresh starts, i.e.
         the shape morph from the matching research seed, then scratch continuation (enter,
         escape), or scratch, then morph (hop, hurdles, weak), until one solves;
  down:  every lower grid T, warm-started from the lowest solved plan (time-stretched); if that
         fails, the first fresh start too, but only while no grid T has failed and only where
         the probe has not been.
  refine: one grid step below the lowest solved T, the starts skipped above: the stretch of every
         solved plan, the template's fresh starts (REFINE_FRESH), and a second attempt (its own
         cache key, "attempt": 2) for a start whose result hit a time limit (IPOPT's 120 s wall
         time or the kill: under load that is no proof of infeasibility).  Repeated while it
         solves.  It only adds solves after the search above, so it can only lower T_min.
  The lowest solved T is T_min; its plan becomes the `ai` ghost (60 Hz Hermite
  samples + 1 s rest) and parSub (120 Hz samples, the game's success rule), with the same code
  as ai_ghosts.py (common.build_ghost).  No calm ghost.

Pool
  d = T_min * w_template * (1 + 0.3 [L < 0.9] + 0.2 [m > 1]), w = hop 0.8, hurdles 0.9,
  enter 1.1, escape 1.15, weak 0.6.  Sorted by d (ties: levelHash), 12 per tier 1..7 in file
  order; ids d:0..d:83.  Names, concepts and splits follow §6.2, with the lead's decision D9 for
  hurdles: a fence-count modifier first (2 walls "ダブル / Double", 3 walls "トリプル / Triple") and
  "低い塀 / Low" when every fence is lower than 0.45 m (still at most two modifiers).

Every planner candidate runs in its own child process (BLAS threads = 1) and is killed after
--timeout s (600; counted as infeasible).  Solves are cached in game/tools/.cache/daily/, so an
interrupted run resumes where it stopped.  The outputs (src/data/daily_pool.json and
src/data/daily_ghosts.json) are written only at the very end, each atomically; a --count other
than 84 writes to game/tools/.cache/daily/out-<count>/ unless --out is given.  A per-candidate
report goes to game/tools/.cache/daily/report-<count>.json.
--check validates the existing pool files: tiers, order by d, template quotas, validateLevel,
the §8.2 generation rules on every entry (and that it is one of the generated candidates), names /
concepts / splits (§6.2), the ghosts and the §8.3 gate.
--rename rewrites only the names and concepts of the existing pool from the current naming rules
(no solving; every other byte of daily_pool.json stays the same, daily_ghosts.json is not touched),
then runs the --check gate.

--bisect (lead decision R9: the grid T_min made the daily pars too generous)
  Re-solves T_min of every level of the existing pool by bisection to 0.1 s, like ai_ghosts.py does
  for the campaign; the physics stays identical (so levelHash, names, concepts and splits stay).
  Per level, starting from the grid search's T_min and plan (report-<count>.json):
  lo:     the grid T just below the grid T_min (the grid search failed there), or 0.6 T_min when the
          grid T_min is the template's lowest grid T; while lo solves, lo x 0.6 again
  bisect: [lo, T_hi] down to 0.1 s
  below:  T_min - 0.1 and T_min - 0.2 from the stretched T_min plan (non-monotone feasibility)
  At every T the starts are tried one after the other, the first that solves wins: the stretched
  plan of the current T_hi, then the template's fresh starts (REFINE_FRESH).  When none solves, a
  start whose failure hit a time limit gets one retry with twice both limits (as in ai_ghosts.py).
  The lowest solved T whose ghost passes the §8.3 gate is the new T_min (ai.tHi, on the 0.1 s grid);
  parSub and the ai ghost come from its plan; d, the order, the ids d:<i> and the tiers are
  recomputed.  The files are written at the very end, each atomically, after the --check gate
  passed; the report goes to game/tools/.cache/daily/report-<count>-bisect.json.  --ids d:0,d:5
  bisects only those levels (the others keep their T_min and ghost), for trials with --out DIR.
"""

from __future__ import annotations

import argparse
import heapq
import itertools
import json
import math
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import common as C
import numpy as np

T0 = time.time()
_print_lock = threading.Lock()


def log(msg: str):
    with _print_lock:
        print(f"[{time.time() - T0:7.1f}s] {msg}", flush=True)


# ================================================================ spec constants (§8.2, §6.2)

RNG_SEED = 20261001
TEMPLATES = ("hop", "hurdles", "enter", "escape", "weak")
BASE_COUNT = 84
BASE_QUOTA = {"hop": 18, "hurdles": 12, "enter": 24, "escape": 18, "weak": 12}
MAX_FACTOR = 5
TIERS = 7
T_GRID = (2.5, 3.0, 4.0, 5.0, 6.0, 8.0)
T_GRID_WEAK = (6.0, 7.5, 9.0)
T_LIMIT = 9.0
T_RES = 0.1  # --bisect: resolution of the daily T_min [s] (lead decision R9); ai.tHi is on this grid
MAX_REQ_DEG = 70.0
W_TEMPLATE = {"hop": 0.8, "hurdles": 0.9, "enter": 1.1, "escape": 1.15, "weak": 0.6}

M_TROLLEY = 2.0
REST_DEG = 3.0
RAIL = (-1.0, 3.2)
RAIL_HURDLES = (-0.6, 3.6)
PAD_W = 0.30
WALL_W = 0.12
WALL_W_HURDLES = 0.10
HOP_PAD_MAX = 2.9
HURDLES_PAD_MAX = 3.30
ESCAPE_PAD = (-0.15, 0.15)

# Fresh starts of the refine stage.  Left out on purpose: scratch for escape (it hit the 600 s kill
# on every try, even where the morph solved in 12-22 s) and the morph for hurdles (the two-wall
# pocket seed never morphs onto a fence course; it fails at a < 0.16 every time).
REFINE_FRESH = {"hop": ("scratch", "morph"), "weak": ("scratch", "morph"), "hurdles": ("scratch",),
                "enter": ("morph", "scratch"), "escape": ("morph",)}

CACHE_LEVEL = "daily"  # solves are cached in game/tools/.cache/daily/<digest>.npz
DAILY_CACHE = C.CACHE_DIR / CACHE_LEVEL
POOL_NAME = "daily_pool.json"
GHOSTS_NAME = "daily_ghosts.json"

TEMPLATE_NAME = {
    "hop": ("ひとっとび", "Hop"),
    "hurdles": ("ハードル", "Hurdles"),
    "enter": ("いれる", "Enter"),
    "escape": ("だす", "Escape"),
    "weak": ("非力", "Weak"),
}
PLAIN = ("ふつう", "Plain")
HURDLES_COUNT = {2: ("ダブル", "Double"), 3: ("トリプル", "Triple")}  # D9
LOW_FENCE = ("低い塀", "Low")  # D9: hurdles whose fences are all lower than LOW_FENCE_H
LOW_FENCE_H = 0.45
CONCEPT = {
    "hop": ("{h0}mの壁をひとっとび、パッドでピタッ", "Hop the {h0} m wall, stop dead on the pad"),
    "hurdles": ("塀を1つの振りでつないで、パッドでピタッ", "Link the fences in one swing, stop dead on the pad"),
    "enter": ("{h0}mの壁を越えて{gap}cmのすき間でピタッ", "Over a {h0} m wall, stop dead in a {gap} cm gap"),
    "escape": ("すき間から{h0}mの壁を越えて、パッドでピタッ", "Out of the gap over the {h0} m wall, stop dead on the pad"),
    "weak": ("{Fmax}Nでは足りない。こいで{h0}mの壁を越える", "{Fmax} N is not enough. Pump over the {h0} m wall"),
}


def modifiers(template: str, phys: dict) -> list[tuple[str, str]]:
    """§6.2: in this order, at most two.  The weak template skips "Weak" (it would read
    "非力 × 非力": every weak level has F_max <= 12).  Hurdles (D9) start with the fence count
    and end with "Low" when every fence is < 0.45 m (the §6.2 modifiers never apply to hurdles:
    L 1.0, m 1, F_max 40, fences <= 0.55 m, no pocket)."""
    walls = phys["walls"]
    out = []
    if template == "hurdles":
        out.append(HURDLES_COUNT[len(walls)])
    if phys["L"] < 0.9:
        out.append(("短い紐", "Short string"))
    if phys["m"] > 1:
        out.append(("重い荷", "Heavy"))
    if phys["Fmax"] <= 15 and template != "weak":
        out.append(("非力", "Weak"))
    if walls and max(w["h"] for w in walls) >= 0.70:
        out.append(("高い壁", "Tall wall"))
    mouth = pocket_mouth(template, phys)
    if mouth is not None and mouth < 0.40 - 1e-9:
        out.append(("せまい口", "Narrow"))
    if template == "hurdles" and all(w["h"] < LOW_FENCE_H - 1e-9 for w in walls):
        out.append(LOW_FENCE)
    return out[:2]


def level_name(template: str, phys: dict) -> dict:
    """"いれる × 短い紐" (two modifiers: "いれる × 短い紐 × 重い荷"); none -> "× ふつう"."""
    ja, en = TEMPLATE_NAME[template]
    mods = modifiers(template, phys) or [PLAIN]
    return {"ja": " × ".join([ja] + [m[0] for m in mods]), "en": " × ".join([en] + [m[1] for m in mods])}


def pocket_mouth(template: str, phys: dict) -> float | None:
    if template not in ("enter", "escape"):
        return None
    a, b = phys["walls"][0], phys["walls"][1]
    return C.r3(b["x0"] - a["x1"])


def splits_for(template: str, n_walls: int) -> list[dict]:
    if template == "hurdles":
        return [{"wall": i, "dir": 1} for i in range(n_walls)]
    if template == "escape":
        return [{"wall": 0, "dir": -1}]
    return [{"wall": 0, "dir": 1}]


def crossed_walls(template: str, phys: dict) -> list[dict]:
    """Walls the ball has to swing over (the §5.1 'required angle' counts only these):
    wall A for enter / escape (B is the back wall of the pocket), every wall otherwise."""
    return phys["walls"][:1] if template in ("enter", "escape") else phys["walls"]


def difficulty(template: str, phys: dict, t_min: float) -> float:
    return t_min * W_TEMPLATE[template] * (1 + 0.3 * (phys["L"] < 0.9) + 0.2 * (phys["m"] > 1))


# ================================================================ candidate generation

def grid(lo: float, hi: float, step: float) -> list[float]:
    n = round((hi - lo) / step)
    return [C.r3(lo + i * step) for i in range(n + 1)]


def pick(rng, values):
    return values[int(rng.integers(len(values)))]


def wall(x0: float, width: float, h: float) -> dict:
    return {"x0": C.r3(x0), "x1": C.r3(x0 + width), "h": C.r3(h)}


def pad(c: float) -> dict:
    return {"kind": "pad", "xa": C.r3(c - PAD_W / 2), "xb": C.r3(c + PAD_W / 2)}


def physics(M, m, L, F, rail, start, walls, phases) -> dict:
    return {"M": M, "m": m, "L": L, "Fmax": F, "rail": list(rail), "startX": C.r3(start), "walls": walls,
            "phases": phases, "restDeg": REST_DEG}


def draw_hop(rng, weak: bool = False):
    """hop: 1 wall, x0 in [0.9, 1.4], h in [0.40, 0.80], pad centre x1 + [0.7, 1.1],
    L in {1.0, 0.85}, F_max in {40, 25}.  weak: the same layout with h in [0.45, 0.60]
    and F_max in [6, 12] (1 N steps)."""
    x0 = pick(rng, grid(0.9, 1.4, 0.05))
    h = pick(rng, grid(0.45, 0.60, 0.05) if weak else grid(0.40, 0.80, 0.05))
    off = pick(rng, grid(0.7, 1.1, 0.05))
    L = pick(rng, [1.0, 0.85])
    F = pick(rng, list(range(6, 13)) if weak else [40, 25])
    w = wall(x0, WALL_W, h)
    c = C.r3(w["x1"] + off)
    return physics(M_TROLLEY, 1.0, L, F, RAIL, 0.0, [w], [pad(c)]), c, {"padMax": HOP_PAD_MAX}


def draw_hurdles(rng):
    """2-3 fences, h in [0.40, 0.55], spacing (x0 to x0) [0.7, 1.0], first x0 in [0.7, 0.9],
    width 0.10; pad centre = last x1 + 0.6 (<= 3.30); F_max 40."""
    n = pick(rng, [2, 3])
    x0 = pick(rng, grid(0.7, 0.9, 0.05))
    walls = []
    for i in range(n):
        if i:
            x0 = C.r3(x0 + pick(rng, grid(0.7, 1.0, 0.05)))
        walls.append(wall(x0, WALL_W_HURDLES, pick(rng, grid(0.40, 0.55, 0.05))))
    c = C.r3(walls[-1]["x1"] + 0.6)
    return physics(M_TROLLEY, 1.0, 1.0, 40, RAIL_HURDLES, 0.0, walls, [pad(c)]), c, {"padMax": HURDLES_PAD_MAX}


def draw_pocket(rng, escape: bool):
    """enter: A.x0 in [1.1, 1.4], A.h in [0.50, 0.80], B.h = A.h ± 0.10 (within 0.45..0.85),
    mouth in [0.36, 0.60] (0.02 m), F_max {40, 25, 15}, L {1.0, 0.85, 0.7}, m {1.0, 2.0}.
    escape: the same layout, start at the pocket centre, pad [-0.15, 0.15]."""
    ax0 = pick(rng, grid(1.1, 1.4, 0.05))
    ah = pick(rng, grid(0.50, 0.80, 0.05))
    bh = pick(rng, [v for v in grid(ah - 0.10, ah + 0.10, 0.05) if 0.45 - 1e-9 <= v <= 0.85 + 1e-9])
    mouth = pick(rng, grid(0.36, 0.60, 0.02))
    F = pick(rng, [40, 25, 15])
    L = pick(rng, [1.0, 0.85, 0.7])
    m = pick(rng, [1.0, 2.0])
    a = wall(ax0, WALL_W, ah)
    b = wall(a["x1"] + mouth, WALL_W, bh)
    centre = C.r3(0.5 * (a["x1"] + b["x0"]))
    if escape:
        ph = [{"kind": "pad", "xa": ESCAPE_PAD[0], "xb": ESCAPE_PAD[1]}]
        return physics(M_TROLLEY, m, L, F, RAIL, centre, [a, b], ph), 0.0, {}
    ph = [{"kind": "pocket", "xa": a["x1"], "xb": b["x0"]}]
    return physics(M_TROLLEY, m, L, F, RAIL, 0.0, [a, b], ph), centre, {}


def draw(rng, template: str):
    if template == "hop":
        return draw_hop(rng)
    if template == "weak":
        return draw_hop(rng, weak=True)
    if template == "hurdles":
        return draw_hurdles(rng)
    return draw_pocket(rng, escape=template == "escape")


def make_level(template: str, index: int, phys: dict, x_goal: float, t_hi: float = 0.0) -> dict:
    return {
        "id": f"{template}#{index:03d}", "world": 0, "order": index,
        "name": level_name(template, phys),
        "concept": {"ja": CONCEPT[template][0], "en": CONCEPT[template][1]},
        "cargo": "ball", "physics": phys, "splits": splits_for(template, len(phys["walls"])),
        "ai": {"xGoal": [C.r3(x_goal)], "tHi": t_hi, "fallback": []},
    }


def cheap_reject(template: str, lv: dict, limits: dict) -> str | None:
    """The rejections that need no planner (§8.2), in spec order."""
    p = lv["physics"]
    block = C.RAIL_Y - p["L"] + C.BALL_R + 0.05
    for i, w in enumerate(p["walls"]):
        if w["h"] < block - 1e-9:
            return f"wall {i} (h {w['h']}) does not block the hanging ball (needs >= {C.r3(block)})"
    req = max((C.req_deg(w["h"], p["L"]) for w in crossed_walls(template, p)), default=0.0)
    if req > MAX_REQ_DEG:
        return f"required angle {req:.1f} deg > {MAX_REQ_DEG:.0f}"
    if "padMax" in limits and lv["ai"]["xGoal"][0] > limits["padMax"] + 1e-9:
        return f"pad centre {lv['ai']['xGoal'][0]} > {limits['padMax']}"
    try:
        C.validate_level(lv, campaign=False)
        for lang in ("ja", "en"):
            C.fmt_level_text(lv["concept"][lang], p)
    except (C.LevelError, KeyError) as e:
        return f"validateLevel: {e}"
    return None


class Cand:
    def __init__(self, template: str, index: int, lv: dict, reject: str | None):
        self.template = template
        self.index = index
        self.cid = lv["id"]
        self.lv = lv
        self.reject = reject  # set before solving (cheap rules) or by the planner stage
        self.accepted = False
        self.t_min: float | None = None
        self.ghost: dict | None = None
        self.check: dict | None = None
        self.plan_ref: dict | None = None
        self.secs = 0.0
        self.tried = False


def generate() -> dict[str, list[Cand]]:
    """All candidates of the full (84-level) pool, 5 x quota per template, in order."""
    rng = np.random.default_rng(RNG_SEED)
    out: dict[str, list[Cand]] = {}
    seen: dict[str, str] = {}
    for tpl in TEMPLATES:
        lst = []
        for k in range(MAX_FACTOR * BASE_QUOTA[tpl]):
            phys, x_goal, limits = draw(rng, tpl)
            lv = make_level(tpl, k, phys, x_goal)
            rej = cheap_reject(tpl, lv, limits)
            h = C.level_hash(phys)
            if rej is None and h in seen:
                rej = f"same physics as {seen[h]}"
            if rej is None:
                seen[h] = lv["id"]
            lst.append(Cand(tpl, k, lv, rej))
        out[tpl] = lst
    return out


def quotas(count: int) -> dict[str, int]:
    """Template quotas for a pool of `count` levels (largest remainder; 84 -> 18/12/24/18/12)."""
    raw = {t: BASE_QUOTA[t] * count / BASE_COUNT for t in TEMPLATES}
    q = {t: math.floor(v + 1e-9) for t, v in raw.items()}
    rest = count - sum(q.values())
    for t in sorted(TEMPLATES, key=lambda t: (-(raw[t] - q[t]), TEMPLATES.index(t)))[:rest]:
        q[t] += 1
    return q


# ================================================================ planner stage

time_limited = C.time_limited  # a failure that hit IPOPT's wall time or the kill, not one IPOPT decided


class PriorityGate:
    """At most `n` holders; waiting callers are served lowest priority value first
    (earlier-launched candidates finish before later ones start new solves)."""

    def __init__(self, n: int):
        self.free = n
        self.cv = threading.Condition()
        self.heap: list[tuple] = []
        self.seq = itertools.count()

    def acquire(self, prio):
        with self.cv:
            key = (prio, next(self.seq))
            heapq.heappush(self.heap, key)
            while not (self.free > 0 and self.heap[0] == key):
                self.cv.wait()
            heapq.heappop(self.heap)
            self.free -= 1
            self.cv.notify_all()

    def release(self):
        with self.cv:
            self.free += 1
            self.cv.notify_all()


class Runner:
    def __init__(self, jobs: int, timeout: float, force: bool):
        self.sched = C.Scheduler(jobs, timeout=timeout, force=force, log=log)
        self.gate = PriorityGate(jobs)
        self.launch = itertools.count()

    def run_one(self, cand: Cand, prio, T: float, start: dict, tag: str) -> dict:
        """One warm start of the candidate level at T (through the priority gate); the raw result."""
        pr = C.make_problem(C.level_face(cand.lv, "ai"), "ai", T)
        self.gate.acquire(prio)
        try:
            return self.sched.run(CACHE_LEVEL, pr, start, f"{cand.cid} {tag}")
        finally:
            self.gate.release()

    def solve(self, cand: Cand, prio, T: float, cands: list[dict], tag: str, retry: bool = False) -> list[dict]:
        """Solve the candidate level at T from every warm start in `cands`, in parallel.
        Returns the successful results.  With `retry`, a start whose (cached) result is a
        time-limit failure gets one more attempt under its own cache key (see `time_limited`)."""
        out: list[dict | None] = [None] * len(cands)

        def run(c):
            return self.run_one(cand, prio, T, c, tag)

        def work(i):
            res = run(cands[i])
            if retry and res and not res["ok"] and time_limited(res):
                res = run({**cands[i], "attempt": 2})
            out[i] = res
        ths = [threading.Thread(target=work, args=(i,)) for i in range(len(cands))]
        for th in ths:
            th.start()
        for th in ths:
            th.join()
        return [r for r in out if r and r["ok"]]

    def evaluate(self, cand: Cand):
        t0 = time.time()
        cand.tried = True
        prio = next(self.launch)
        try:
            self._evaluate(cand, prio)
        except Exception as e:  # noqa: BLE001 -- keep the other candidates going
            import traceback
            cand.reject = f"error: {type(e).__name__}: {e}"
            log(f"[{cand.cid}] ERROR {cand.reject}\n{traceback.format_exc()}")
        cand.secs = time.time() - t0
        if cand.accepted:
            log(f"[{cand.cid}] ACCEPT T_min={C.js_number(cand.t_min)} parSub={cand.ghost['parSub']} "
                f"peakF={cand.ghost['peakF']} gap={cand.ghost['minGapMm']}mm pumps={cand.ghost['pumps']} "
                f"({cand.secs:.0f}s)")
        else:
            log(f"[{cand.cid}] REJECT {cand.reject} ({cand.secs:.0f}s)")

    def _evaluate(self, cand: Cand, prio):
        lv = cand.lv
        p = lv["physics"]
        grid_t = T_GRID_WEAK if cand.template == "weak" else T_GRID
        start_t = 9.0 if cand.template == "weak" else (4.0 if p["Fmax"] >= 40 else 5.0 if p["Fmax"] >= 25 else 6.0)
        probe = grid_t.index(start_t)
        found: dict[float, list[dict]] = {}
        # Fresh starts, tried one after the other (the first success wins): the shape morph from
        # the research seed is the one that works for pockets (escape from scratch practically
        # never converges within the kill time), scratch continuation for the open layouts
        # (morphing the two-wall seed onto one wall mostly fails).
        morph = C.cand_morph(C.morph_seed_for(lv))
        fresh = [morph, C.cand_scratch()] if cand.template in ("enter", "escape") else [C.cand_scratch(), morph]

        def first_ok(T, cands, tag, retry=False):
            for c in cands:
                oks = self.solve(cand, prio, T, [c], tag, retry)
                if oks:
                    return oks
            return []
        i_ok = None
        for i in range(probe, len(grid_t)):
            oks = first_ok(grid_t[i], fresh, "probe")
            if oks:
                found[grid_t[i]], i_ok = oks, i
                break
        if i_ok is None:
            cand.reject = f"no feasible T on the grid up to {C.js_number(grid_t[-1])} s (T_min > {C.js_number(T_LIMIT)} s)"
            return
        best = C.best_of(found[grid_t[i_ok]])
        # below: the stretched lowest plan at every grid T; a fresh start as well only while no
        # grid T has failed yet (and only where the probe has not been)
        fresh_ok = i_ok == probe
        for j in range(i_ok - 1, -1, -1):
            T = grid_t[j]
            oks = first_ok(T, [C.cand_stretch(best)] + ([fresh[0]] if fresh_ok and j < probe else []), "down")
            if oks:
                found[T] = oks
                best = C.best_of(oks)
            else:
                fresh_ok = False
        # refine (additive: it only ever lowers T_min): one grid step below the lowest solved T,
        # try the starts the search above skipped -- the stretch of every solved plan (not only
        # the lowest), the template's fresh starts -- and give a start that hit a time limit one
        # more attempt (a 120 s IPOPT wall time or the 600 s kill under load is no proof of
        # infeasibility).  Repeat while it solves.
        refine_fresh = [C.cand_morph(C.morph_seed_for(lv)) if k == "morph" else C.cand_scratch()
                        for k in REFINE_FRESH[cand.template]]
        while grid_t.index(min(found)) > 0:
            T = grid_t[grid_t.index(min(found)) - 1]
            starts, seen = [], set()
            for Ts in sorted(found):
                for r in sorted(found[Ts], key=lambda r: r["objective"]):
                    if r["digest"] not in seen:
                        seen.add(r["digest"])
                        starts.append(C.cand_stretch(r))
            oks = first_ok(T, starts + refine_fresh, "refine", retry=True)
            if not oks:
                break
            found[T] = oks
        # lowest T first; within a T the lowest effort; the ghost must pass the §8.3 gate
        errors = []
        for T in sorted(found):
            for r in sorted(found[T], key=lambda r: r["objective"]):
                try:
                    g = C.build_ghost(lv, C.Traj.of(r), "ai", T)
                    chk = C.check_ghost(lv, g)
                except Exception as e:  # noqa: BLE001 -- a plan the ghost builder rejects is skipped
                    errors.append(f"T={C.js_number(T)} {C.cand_name(r['cand'])}: {e}")
                    continue
                if chk["errors"]:
                    errors.append(f"T={C.js_number(T)} {C.cand_name(r['cand'])}: {'; '.join(chk['errors'])}")
                    continue
                cand.accepted, cand.t_min, cand.ghost, cand.check = True, T, g, chk
                cand.plan_ref = {"digest": r["digest"], "cand": C.cand_name(r["cand"]), "objective": r["objective"],
                                 "solvedT": sorted(found)}
                if errors:
                    log(f"[{cand.cid}] note: skipped plans failing the ghost gate: {errors}")
                return
        cand.reject = "every solved plan fails the ghost gate: " + " | ".join(errors)


def run_template(runner: Runner, tpl: str, cands: list[Cand], quota: int, slack: int) -> list[Cand]:
    """Evaluate candidates in list order, keeping (passed + in flight) < quota + slack, until
    `quota` of them pass or the list is exhausted.  Returns the first `quota` passes."""
    cv = threading.Condition()
    state = {"pos": 0, "inflight": 0, "passed": 0}

    def work(c: Cand):
        runner.evaluate(c)
        with cv:
            state["inflight"] -= 1
            state["passed"] += int(c.accepted)
            cv.notify_all()
    with cv:
        while True:
            while state["pos"] < len(cands) and state["passed"] + state["inflight"] < quota + slack \
                    and state["passed"] < quota:
                c = cands[state["pos"]]
                state["pos"] += 1
                if c.reject is not None:
                    log(f"[{c.cid}] REJECT {c.reject}")
                    continue
                state["inflight"] += 1
                threading.Thread(target=work, args=(c,), name=c.cid, daemon=True).start()
            if state["inflight"] == 0:
                break
            cv.wait()
    tried = cands[:state["pos"]]
    passed = [c for c in tried if c.accepted]
    log(f"[{tpl}] {len(passed)} passed of {len(tried)} tried (quota {quota}, budget {len(cands)})")
    return passed[:quota]


# ================================================================ outputs

def assemble_pool(rows: list[tuple[str, dict, float, dict, dict]], count: int):
    """Pool, ghosts and report from rows (template, source level, T_min, ai ghost, report extras):
    sorted by difficulty d (ties: levelHash), `count // 7` per tier, ids d:<index>.  The source
    level gives name, concept, physics, splits and ai.xGoal; ai.tHi is T_min."""
    per = count // TIERS
    items = []
    for tpl, src, t_min, ghost, extra in rows:
        items.append((difficulty(tpl, src["physics"], t_min), C.level_hash(src["physics"]), tpl, src, t_min, ghost, extra))
    items.sort(key=lambda z: (z[0], z[1]))
    pool, ghosts, report = [], {}, []
    for i, (d, h, tpl, src, t_min, ghost, extra) in enumerate(items):
        lid = f"d:{i}"
        entry = {"id": lid, "world": 0, "order": i, "tier": i // per + 1, "template": tpl,
                 "parSub": ghost["parSub"], "name": src["name"], "concept": src["concept"], "cargo": "ball",
                 "physics": src["physics"], "splits": src["splits"],
                 "ai": {"xGoal": src["ai"]["xGoal"], "tHi": t_min, "fallback": []}}
        pool.append(entry)
        ghosts[lid] = [ghost]
        report.append({"id": lid, **extra, "tier": entry["tier"], "d": round(d, 4), "hash": h,
                       "tMin": t_min, "parSub": ghost["parSub"], "name": src["name"]["ja"]})
    return {"format": 1, "pool": pool}, {"format": 1, "ghosts": ghosts}, report


def build_pool(accepted: dict[str, list[Cand]], count: int):
    return assemble_pool([(tpl, c.lv, c.t_min, c.ghost, {"cand": c.cid}) for tpl in TEMPLATES for c in accepted[tpl]],
                         count)


DAILY_KEYS = {"id", "world", "order", "tier", "template", "parSub", "name", "concept", "cargo", "physics", "splits",
              "ai"}
PHYSICS_KEYS = {"M", "m", "L", "Fmax", "rail", "startX", "walls", "phases", "restDeg"}


def on_grid(v: float, lo: float, hi: float, step: float) -> bool:
    k = (v - lo) / step
    return lo - 1e-9 <= v <= hi + 1e-9 and abs(k - round(k)) < 1e-6


def template_errors(d: dict) -> list[str]:
    """The §8.2 generation rules re-checked on a finished pool entry: common values, the
    template's parameter ranges and steps, zone / xGoal / start, the cheap rejections, the T grid."""
    t, p, ai = d["template"], d["physics"], d["ai"]
    e = []

    def need(cond, msg):
        if not cond:
            e.append(msg)
    need(set(d) == DAILY_KEYS, f"keys {sorted(set(d) ^ DAILY_KEYS)} (a DailyDef has exactly {sorted(DAILY_KEYS)})")
    need(set(p) == PHYSICS_KEYS, f"physics keys {sorted(set(p) ^ PHYSICS_KEYS)}")
    need(set(ai) == {"xGoal", "tHi", "fallback"} and ai["fallback"] == [], f"ai {ai}")
    need(d["cargo"] == "ball", "cargo must be ball")
    need(p["M"] == M_TROLLEY and p["restDeg"] == REST_DEG, f"M {p['M']} / restDeg {p['restDeg']}")
    need(tuple(p["rail"]) == (RAIL_HURDLES if t == "hurdles" else RAIL), f"rail {p['rail']}")
    width = WALL_W_HURDLES if t == "hurdles" else WALL_W
    walls = p["walls"]
    need(all(abs(w["x1"] - w["x0"] - width) < 1e-9 for w in walls), f"wall width must be {width}")
    need(len(p["phases"]) == 1, "one phase")
    z = p["phases"][0]
    if t in ("hop", "weak", "hurdles"):
        need(len(walls) in ((2, 3) if t == "hurdles" else (1,)), f"{len(walls)} walls")
        need(z["kind"] == "pad" and abs(z["xb"] - z["xa"] - PAD_W) < 1e-9, f"zone {z}")
        c = C.r3(0.5 * (z["xa"] + z["xb"]))
        need(p["startX"] == 0 and p["m"] == 1, f"startX {p['startX']} / m {p['m']}")
        if t == "hurdles":
            need(p["L"] == 1 and p["Fmax"] == 40, f"L {p['L']} / Fmax {p['Fmax']}")
            need(on_grid(walls[0]["x0"], 0.7, 0.9, 0.05), f"first x0 {walls[0]['x0']}")
            need(all(on_grid(C.r3(b["x0"] - a["x0"]), 0.7, 1.0, 0.05) for a, b in itertools.pairwise(walls)),
                 "fence spacing outside [0.7, 1.0] / off the 0.05 grid")
            need(all(on_grid(w["h"], 0.40, 0.55, 0.05) for w in walls), "fence height")
            need(c == C.r3(walls[-1]["x1"] + 0.6) and c <= HURDLES_PAD_MAX + 1e-9, f"pad centre {c}")
        else:
            w = walls[0]
            need(on_grid(w["x0"], 0.9, 1.4, 0.05), f"x0 {w['x0']}")
            need(on_grid(w["h"], *((0.45, 0.60) if t == "weak" else (0.40, 0.80)), 0.05), f"h {w['h']}")
            need(on_grid(C.r3(c - w["x1"]), 0.7, 1.1, 0.05) and c <= HOP_PAD_MAX + 1e-9, f"pad centre {c}")
            need(p["L"] in (1.0, 0.85), f"L {p['L']}")
            need(p["Fmax"] in (range(6, 13) if t == "weak" else (40, 25)), f"Fmax {p['Fmax']}")
    elif t in ("enter", "escape"):
        need(len(walls) == 2, f"{len(walls)} walls")
        if len(walls) == 2:
            a, b = walls
            need(on_grid(a["x0"], 1.1, 1.4, 0.05) and on_grid(a["h"], 0.50, 0.80, 0.05), f"wall A {a}")
            need(on_grid(b["h"], 0.45, 0.85, 0.05) and abs(b["h"] - a["h"]) <= 0.10 + 1e-9, f"wall B {b}")
            need(on_grid(pocket_mouth(t, p), 0.36, 0.60, 0.02), f"mouth {pocket_mouth(t, p)}")
            centre = C.r3(0.5 * (a["x1"] + b["x0"]))
            if t == "enter":
                need(z == {"kind": "pocket", "xa": a["x1"], "xb": b["x0"]} and p["startX"] == 0, f"zone {z}")
            else:
                need(z == {"kind": "pad", "xa": ESCAPE_PAD[0], "xb": ESCAPE_PAD[1]} and p["startX"] == centre,
                     f"zone {z} / startX {p['startX']} (pocket centre {centre})")
        need(p["Fmax"] in (40, 25, 15) and p["L"] in (1.0, 0.85, 0.7) and p["m"] in (1.0, 2.0),
             f"Fmax {p['Fmax']} / L {p['L']} / m {p['m']}")
    need(ai["xGoal"] == [C.r3(0.5 * (z["xa"] + z["xb"]))], f"xGoal {ai['xGoal']} is not the zone centre")
    limits = {"padMax": HURDLES_PAD_MAX if t == "hurdles" else HOP_PAD_MAX} if t in ("hop", "weak", "hurdles") else {}
    rej = cheap_reject(t, d, limits)
    need(rej is None, f"fails a generation rule: {rej}")
    need(on_grid(ai["tHi"], T_RES, T_LIMIT, T_RES), f"tHi {ai['tHi']} is not on the {T_RES:g} s grid in (0, {T_LIMIT:g}]")
    need(isinstance(d["parSub"], int) and 0 < d["parSub"] <= round(ai["tHi"] * C.SUB_HZ),
         f"parSub {d['parSub']} outside (0, tHi*120]")
    return e


def check_pool(pool_doc: dict, ghosts_doc: dict, count: int = BASE_COUNT,
               cands: dict[str, list[Cand]] | None = None) -> list[str]:
    """The daily part of the §8.3 gate and the daily_pool vitest (84 levels, 12 per tier,
    validateLevel), the §6.2 naming rules, the §8.2 generation rules on every entry, the order
    by difficulty and the template quotas.  With `cands` (from generate()), every entry must
    also be one of its template's candidates within the 5x budget that pass the cheap rules
    (i.e. it really came from the rng stream).  Returns a list of errors."""
    errs = []
    if pool_doc.get("format") != 1 or ghosts_doc.get("format") != 1:
        errs.append("format must be 1")
    pool = pool_doc["pool"]
    per = count // TIERS
    if len(pool) != count:
        errs.append(f"expected {count} levels, got {len(pool)}")
    q = quotas(count)
    got = {t: sum(1 for d in pool if d.get("template") == t) for t in TEMPLATES}
    if got != q:
        errs.append(f"templates {got} != quotas {q}")
    origin = None
    if cands is not None:
        origin = {t: {C.level_hash(c.lv["physics"]): c for c in cands[t][:MAX_FACTOR * q[t]] if c.reject is None}
                  for t in TEMPLATES}
    hashes = set()
    prev_tier = 1
    prev_key = None
    for i, d in enumerate(pool):
        e = []
        lid = f"d:{i}"
        if d["id"] != lid or d["order"] != i or d["world"] != 0:
            e.append(f"id/order/world {d['id']}/{d['order']}/{d['world']} (want {lid}/{i}/0)")
        if d["tier"] != i // per + 1 or d["tier"] < prev_tier:
            e.append(f"tier {d['tier']} at position {i}")
        prev_tier = d["tier"]
        if d["template"] not in TEMPLATES:
            e.append(f"template {d['template']}")
            errs += [f"{d['id']}: {x}" for x in e]
            continue
        p = d["physics"]
        try:
            C.validate_level(d, campaign=False)
        except C.LevelError as ex:
            e.append(str(ex))
        if "hints" in d:
            e.append("daily levels have no hints")
        if d["name"] != level_name(d["template"], p):
            e.append(f"name {d['name']} != {level_name(d['template'], p)}")
        if list(d["concept"].values()) != list(CONCEPT[d["template"]]):
            e.append("concept is not the template's")
        for lang in ("ja", "en"):
            try:
                C.fmt_level_text(d["concept"][lang], p)
            except KeyError as ex:
                e.append(str(ex))
        if d["splits"] != splits_for(d["template"], len(p["walls"])):
            e.append(f"splits {d['splits']}")
        h = C.level_hash(p)
        if h in hashes:
            e.append("duplicate physics")
        hashes.add(h)
        e += template_errors(d)
        key = (difficulty(d["template"], p, d["ai"]["tHi"]), h)
        if prev_key is not None and key < prev_key:
            e.append(f"not sorted by difficulty: d={key[0]:.4f} after d={prev_key[0]:.4f}")
        prev_key = key
        if origin is not None:
            src = origin[d["template"]].get(h)
            if src is None:
                e.append("physics is not one of the template's generated candidates")
            elif (src.lv["name"], src.lv["concept"], src.lv["splits"], src.lv["ai"]["xGoal"]) != \
                    (d["name"], d["concept"], d["splits"], d["ai"]["xGoal"]):
                e.append(f"differs from its candidate {src.cid}")
        gs = ghosts_doc["ghosts"].get(d["id"])
        if not gs or [g["kind"] for g in gs] != ["ai"]:
            e.append(f"ghosts {None if not gs else [g['kind'] for g in gs]} (want exactly one ai)")
        else:
            g = gs[0]
            if g["parSub"] != d["parSub"]:
                e.append(f"parSub pool {d['parSub']} != ghost {g['parSub']}")
            if g["planT"] != d["ai"]["tHi"]:
                e.append(f"ghost planT {g['planT']} != ai.tHi {d['ai']['tHi']}")
            if (g["label"], g["hz"], g["n"]) != (C.GHOST_LABELS["ai"], C.TICK_HZ, C.n_samples(g["planT"], C.TICK_HZ)):
                e.append(f"ghost label/hz/n {g['label']}/{g['hz']}/{g['n']} (plan samples + 1 s of rest at 60 Hz)")
            try:
                e += C.check_ghost(d, g)["errors"]
            except Exception as ex:  # noqa: BLE001 -- a broken ghost is an error of the pool, not of the checker
                e.append(f"ghost does not decode: {type(ex).__name__}: {ex}")
        errs += [f"{d['id']}: {x}" for x in e]
    extra = set(ghosts_doc["ghosts"]) - {d["id"] for d in pool}
    if extra:
        errs.append(f"ghosts for unknown ids {sorted(extra)}")
    return errs


def summarise(pool_doc: dict):
    pool = pool_doc["pool"]
    print(f"\n{'id':5s} {'tier':>4s} {'template':8s} {'T':>4s} {'par':>5s} {'par/120':>7s}  name")
    for d in pool:
        print(f"{d['id']:5s} {d['tier']:4d} {d['template']:8s} {C.js_number(d['ai']['tHi']):>4s} {d['parSub']:5d} "
              f"{d['parSub'] / 120:7.3f}  {d['name']['ja']}  /  {d['name']['en']}")
    by_t = {t: sum(1 for d in pool if d["template"] == t) for t in TEMPLATES}
    by_tier = {k: sum(1 for d in pool if d["tier"] == k) for k in range(1, TIERS + 1)}
    print(f"templates {by_t}  tiers {by_tier}")


def default_out(count: int) -> Path:
    return C.DATA if count == BASE_COUNT else DAILY_CACHE / f"out-{count}"


def rename_pool(pool_doc: dict) -> tuple[dict, list[str]]:
    """The pool with every name and concept regenerated from the current rules (nothing else
    changes; no solving).  Returns (new document, list of "id: old -> new" changes)."""
    new = json.loads(json.dumps(pool_doc))
    changes = []
    for d in new["pool"]:
        name = level_name(d["template"], d["physics"])
        concept = {"ja": CONCEPT[d["template"]][0], "en": CONCEPT[d["template"]][1]}
        if d["name"] != name or d["concept"] != concept:
            changes.append(f"{d['id']}: {d['name']['ja']} / {d['name']['en']} -> {name['ja']} / {name['en']}"
                           + ("" if d["concept"] == concept else " (concept)"))
        d["name"], d["concept"] = name, concept
    strip = lambda doc: [{k: v for k, v in d.items() if k not in ("name", "concept")} for d in doc["pool"]]  # noqa: E731
    if strip(new) != strip(pool_doc):
        raise AssertionError("rename changed more than names / concepts")
    return new, changes


# ================================================================ --bisect: T_min of the existing pool to 0.1 s (R9)

def dsec(T: float) -> int:
    """T in steps of T_RES (the bisection works on integers)."""
    return round(T / T_RES)


def tsec(k: int) -> float:
    return C.r3(k * T_RES)


def grid_plans(count: int) -> dict[str, dict]:
    """levelHash -> {"tMin", "digest", "cand"} of the grid search's accepted plans (report-<count>.json),
    the bisection's starting point.  The bisection always starts from the grid result, so running it
    again on a pool it has already written repeats the same (cached) solves."""
    path = DAILY_CACHE / f"report-{count}.json"
    rep = json.loads(path.read_text(encoding="utf-8"))
    by = {c["cand"]: c for c in rep["candidates"]}
    out = {}
    for e in rep["pool"]:
        c = by[e["cand"]]
        out[e["hash"]] = {"tMin": c["tMin"], "digest": c["plan"]["digest"], "cand": e["cand"]}
    return out


class Bisector:
    """Minimum T of one pool level on the T_RES grid, the way ai_ghosts.py bisects a campaign level:
      lo:     the grid T just below the grid search's T_min (it failed there), or 0.6 T_min when
              T_min is the lowest grid T; while lo solves, lo x 0.6 again (at most 6 times, >= 0.5 s)
      bisect: [lo, T_hi] down to T_RES
      below:  T_min - 0.1 and T_min - 0.2 from the stretched T_min plan (non-monotone feasibility)
    At every T the starts are tried one after the other and the first that solves wins (as in the
    grid search): the stretched plan of the current T_hi, then the template's fresh starts
    (REFINE_FRESH).  When none solves, every start whose failure hit a time limit gets one retry with
    twice both limits (C.cand_retry), as in ai_ghosts.py.  The physics never changes."""

    def __init__(self, runner: Runner, d: dict, prio: int, grid: dict):
        self.runner = runner
        self.d = d
        self.prio = prio
        self.cand = Cand(d["template"], prio, d, None)
        self.tag = f"{d['id']} {grid['cand']}"
        self.grid_t_min = grid["tMin"]
        self.grid_plan = C.load_result_npz(C.cache_path(CACHE_LEVEL, grid["digest"]))
        if not self.grid_plan["ok"]:
            raise RuntimeError(f"{d['id']}: the grid plan {grid['digest'][:8]} is not a solved plan")
        self.found: dict[float, list[dict]] = {self.grid_t_min: [self.grid_plan]}
        self.fresh = [C.cand_morph(C.morph_seed_for(d)) if k == "morph" else C.cand_scratch()
                      for k in REFINE_FRESH[d["template"]]]
        self.t_min: float | None = None
        self.ghost: dict | None = None
        self.plan_ref: dict | None = None
        self.error: str | None = None
        self.secs = 0.0

    def step(self, T: float, starts: list[dict], tag: str) -> dict | None:
        timed = []
        for c in starts:
            r = self.runner.run_one(self.cand, self.prio, T, c, f"{tag}")
            if r["ok"]:
                self.found.setdefault(T, []).append(r)
                return r
            if C.time_limited(r):
                timed.append(c)
        for c in timed:
            r = self.runner.run_one(self.cand, self.prio, T, C.cand_retry(c), f"{tag}-retry")
            if r["ok"]:
                self.found.setdefault(T, []).append(r)
                return r
        return None

    def run(self):
        t0 = time.time()
        try:
            self._run()
        except Exception as e:  # noqa: BLE001 -- keep the other levels going; reported at the end
            import traceback
            self.error = f"{type(e).__name__}: {e}"
            log(f"[{self.d['id']}] ERROR {self.error}\n{traceback.format_exc()}")
        self.secs = time.time() - t0

    def _run(self):
        grid_t = T_GRID_WEAK if self.d["template"] == "weak" else T_GRID
        hi, P_hi = dsec(self.grid_t_min), self.grid_plan
        i = grid_t.index(self.grid_t_min)
        lo = dsec(grid_t[i - 1]) if i > 0 else dsec(0.6 * self.grid_t_min)
        for _ in range(6):  # the lower end: x 0.6 again while it still solves
            r = self.step(tsec(lo), [C.cand_stretch(P_hi)] + self.fresh, "lo")
            if not r:
                break
            hi, P_hi = lo, r
            lo = dsec(0.6 * tsec(lo))
            if tsec(lo) < 0.5:
                break
        while hi - lo > 1:
            mid = (lo + hi) // 2
            r = self.step(tsec(mid), [C.cand_stretch(P_hi)] + self.fresh, "bisect")
            if r:
                hi, P_hi = mid, r
            else:
                lo = mid
        below = [k for k in (hi - 1, hi - 2) if k > 0]
        res: dict[int, dict | None] = {}

        def probe(k):
            res[k] = self.step(tsec(k), [C.cand_stretch(P_hi)], "below")
        ths = [threading.Thread(target=probe, args=(k,)) for k in below]
        for th in ths:
            th.start()
        for th in ths:
            th.join()
        for k in sorted(below):
            if res[k]:
                log(f"[{self.d['id']}] non-monotone: T={C.js_number(tsec(k))} solves below the bisection's "
                    f"{C.js_number(tsec(hi))}")
                hi, P_hi = k, res[k]
                break
        # lowest T first; within a T the lowest effort; the ghost must pass the §8.3 gate
        errors = []
        for T in sorted(self.found):
            for r in sorted(self.found[T], key=lambda r: r["objective"]):
                try:
                    g = C.build_ghost(self.d, C.Traj.of(r), "ai", T)
                    chk = C.check_ghost(self.d, g)
                except Exception as e:  # noqa: BLE001 -- a plan the ghost builder rejects is skipped
                    errors.append(f"T={C.js_number(T)} {C.cand_name(r['cand'])}: {e}")
                    continue
                if chk["errors"]:
                    errors.append(f"T={C.js_number(T)} {C.cand_name(r['cand'])}: {'; '.join(chk['errors'])}")
                    continue
                self.t_min, self.ghost = T, g
                self.plan_ref = {"digest": r["digest"], "cand": C.cand_name(r["cand"]), "objective": r["objective"],
                                 "solvedT": sorted(self.found), "bisectT": tsec(hi)}
                if errors:
                    log(f"[{self.d['id']}] note: skipped plans failing the ghost gate: {errors}")
                return
        raise RuntimeError("every solved plan fails the ghost gate: " + " | ".join(errors))


def bisect_pool(args, out_dir: Path):
    """Re-solve T_min of every level of the existing pool (lead decision R9) and write the two
    pool files to `out_dir`: physics, names, concepts and splits stay; ai.tHi, parSub, the ai
    ghosts, the order, the ids and the tiers are recomputed.  The existing pool is read from the
    default location (src/data for 84 levels).  --ids limits the solving to some levels (the others
    keep their current T_min and ghost)."""
    src_dir = default_out(args.count)
    pool_doc = json.loads((src_dir / POOL_NAME).read_text(encoding="utf-8"))
    ghosts_doc = json.loads((src_dir / GHOSTS_NAME).read_text(encoding="utf-8"))
    pool = pool_doc["pool"]
    if len(pool) != args.count:
        sys.exit(f"{src_dir / POOL_NAME} has {len(pool)} levels, not {args.count}")
    grid = grid_plans(args.count)
    ids = set(args.ids.split(",")) if args.ids else {d["id"] for d in pool}
    unknown = ids - {d["id"] for d in pool}
    if unknown:
        sys.exit(f"unknown ids {sorted(unknown)}")
    runner = Runner(args.jobs, args.timeout, args.force)
    jobs = {}
    for i, d in enumerate(pool):
        if d["id"] in ids:
            h = C.level_hash(d["physics"])
            if h not in grid:
                sys.exit(f"{d['id']}: no grid-search plan for levelHash {h} in report-{args.count}.json")
            jobs[d["id"]] = Bisector(runner, d, i, grid[h])
    log(f"bisect: {len(jobs)} of {len(pool)} levels from {src_dir}, resolution {T_RES:g} s, jobs={args.jobs} "
        f"timeout={args.timeout:.0f}s force={args.force} out={out_dir}")
    done = {"n": 0}
    lock = threading.Lock()

    def work(b: Bisector):
        b.run()
        with lock:
            done["n"] += 1
            n = done["n"]
        if b.error is None:
            old = b.d["ai"]["tHi"]
            log(f"[{b.d['id']}] DONE {n}/{len(jobs)}: T_min {C.js_number(old)} -> {C.js_number(b.t_min)}, parSub "
                f"{b.d['parSub']} -> {b.ghost['parSub']}, solved T {[C.js_number(t) for t in sorted(b.found)]} "
                f"({b.secs:.0f}s)")
        else:
            log(f"[{b.d['id']}] FAILED {n}/{len(jobs)}: {b.error} ({b.secs:.0f}s)")
    ths = [threading.Thread(target=work, args=(b,), name=lid, daemon=True) for lid, b in jobs.items()]
    for th in ths:
        th.start()
    for th in ths:
        th.join()

    failed = [f"{lid}: {b.error}" for lid, b in jobs.items() if b.error]
    rows = []
    for d in pool:
        b = jobs.get(d["id"])
        if b is None:
            rows.append((d["template"], d, d["ai"]["tHi"], ghosts_doc["ghosts"][d["id"]][0], {"from": d["id"]}))
        elif b.error is None:
            rows.append((d["template"], d, b.t_min, b.ghost, {"from": d["id"], "gridT": b.grid_t_min,
                                                               "plan": b.plan_ref, "secs": round(b.secs, 1)}))
    rep = {"count": args.count, "secs": time.time() - T0, "scheduler": runner.sched.stats, "failed": failed}
    report_path = DAILY_CACHE / f"report-{args.count}-bisect.json"
    if failed:
        C.write_text_atomic(report_path, json.dumps(rep, ensure_ascii=False, indent=1))
        for f in failed:
            log(f"FAILED {f}")
        log(f"scheduler: {runner.sched.stats}; nothing written")
        sys.exit(1)
    new_pool, new_ghosts, order = assemble_pool(rows, args.count)
    rep["pool"] = order
    errs = check_pool(new_pool, new_ghosts, args.count, generate())
    C.write_text_atomic(report_path, json.dumps(rep, ensure_ascii=False, indent=1))
    if errs:
        for e in errs:
            log(f"ERROR {e}")
        log("the bisected pool fails its own checks; nothing written")
        sys.exit(1)
    moved = sum(1 for r in order if r["from"] != r["id"])
    lower = sum(1 for r in order if "gridT" in r and r["tMin"] < r["gridT"])
    log(f"{lower} of {len(jobs)} bisected levels got a lower T_min; {moved} of {len(order)} levels changed id")
    C.write_text_atomic(out_dir / GHOSTS_NAME, C.pretty_json(new_ghosts) + "\n")
    C.write_text_atomic(out_dir / POOL_NAME, C.pretty_json(new_pool) + "\n")
    summarise(new_pool)
    log(f"scheduler: {runner.sched.stats}")
    log(f"wrote {out_dir / POOL_NAME} and {out_dir / GHOSTS_NAME} ({len(new_pool['pool'])} levels)")


# ================================================================ main

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--count", type=int, default=BASE_COUNT, help="pool size (a multiple of 7; default 84)")
    ap.add_argument("--jobs", type=int, default=22)
    ap.add_argument("--timeout", type=float, default=C.CANDIDATE_TIMEOUT_S, help="per-candidate kill [s]")
    ap.add_argument("--force", action="store_true", help="ignore cached solves")
    ap.add_argument("--out", type=Path, help="output directory (default: src/data for 84, else the cache)")
    ap.add_argument("--slack", type=int, default=1, help="extra candidates in flight per template")
    ap.add_argument("--dry-run", action="store_true", help="only generate the candidates and print them")
    ap.add_argument("--check", action="store_true", help="only check the existing pool files")
    ap.add_argument("--rename", action="store_true",
                    help="regenerate names / concepts of the existing pool (no solving), then check it")
    ap.add_argument("--bisect", action="store_true",
                    help=f"re-solve T_min of the existing pool by bisection to {T_RES:g} s (same physics), then "
                         "rewrite parSub, ai.tHi, the ghosts, the order and the tiers")
    ap.add_argument("--ids", help="--bisect only: comma-separated pool ids to bisect (default: all)")
    args = ap.parse_args(argv)
    if args.count <= 0 or args.count % TIERS:
        ap.error("--count must be a positive multiple of 7")
    out_dir = args.out or default_out(args.count)
    if args.ids and not args.bisect:
        ap.error("--ids needs --bisect")
    if args.bisect:
        bisect_pool(args, out_dir)
        return

    if args.rename:
        path = out_dir / POOL_NAME
        old_text = path.read_text(encoding="utf-8")
        pool_doc = json.loads(old_text)
        if C.pretty_json(pool_doc) + "\n" != old_text:
            sys.exit(f"{path} is not in the tool's own format; not rewriting it")
        new_doc, changes = rename_pool(pool_doc)
        for c in changes:
            print("RENAME", c)
        if changes:
            C.write_text_atomic(path, C.pretty_json(new_doc) + "\n")
        print(f"{len(changes)} of {len(new_doc['pool'])} entries renamed in {path}")
        args.check = True
    if args.check:
        missing = [n for n in (POOL_NAME, GHOSTS_NAME) if not (out_dir / n).is_file()]
        if missing:
            print(f"CHECK FAILED: {', '.join(missing)} missing in {out_dir}")
            sys.exit(1)
        pool_doc = json.loads((out_dir / POOL_NAME).read_text(encoding="utf-8"))
        ghosts_doc = json.loads((out_dir / GHOSTS_NAME).read_text(encoding="utf-8"))
        errs = check_pool(pool_doc, ghosts_doc, args.count, generate())
        summarise(pool_doc)
        for e in errs:
            print("ERROR", e)
        print("\nCHECK", "PASSED" if not errs else f"FAILED ({len(errs)} errors)")
        sys.exit(0 if not errs else 1)

    cands = generate()
    q = quotas(args.count)
    budget = {t: cands[t][:MAX_FACTOR * q[t]] for t in TEMPLATES}
    for t in TEMPLATES:
        ok = sum(1 for c in budget[t] if c.reject is None)
        log(f"[{t}] quota {q[t]}, budget {len(budget[t])} candidates, {ok} pass the cheap rules")
    if args.dry_run:
        for t in TEMPLATES:
            for c in budget[t]:
                p = c.lv["physics"]
                ws = " ".join(f"[{C.js_number(w['x0'])},{C.js_number(w['x1'])},{C.js_number(w['h'])}]" for w in p["walls"])
                print(f"{c.cid:12s} L={C.js_number(p['L'])} m={C.js_number(p['m'])} F={C.js_number(p['Fmax'])} "
                      f"start={C.js_number(p['startX'])} walls={ws} goal={c.lv['ai']['xGoal']} "
                      f"{c.lv['name']['ja']}  {'REJECT ' + c.reject if c.reject else ''}")
        return

    log(f"count={args.count} jobs={args.jobs} timeout={args.timeout:.0f}s force={args.force} out={out_dir} "
        f"quotas={q}")
    runner = Runner(args.jobs, args.timeout, args.force)
    accepted: dict[str, list[Cand]] = {}

    def drive(t):
        try:
            accepted[t] = run_template(runner, t, budget[t], q[t], args.slack)
        except Exception:  # noqa: BLE001 -- reported as a short template below; nothing is written
            import traceback
            log(f"[{t}] ERROR\n{traceback.format_exc()}")
            accepted[t] = []
    ths = [threading.Thread(target=drive, args=(t,), name=t) for t in TEMPLATES]
    for th in ths:
        th.start()
    for th in ths:
        th.join()

    rep = {"count": args.count, "quotas": q, "secs": time.time() - T0, "scheduler": runner.sched.stats,
           "candidates": [{"cand": c.cid, "tried": c.tried, "accepted": c.accepted, "reject": c.reject, "tMin": c.t_min,
                           "parSub": c.ghost["parSub"] if c.ghost else None, "plan": c.plan_ref,
                           "secs": round(c.secs, 1), "name": c.lv["name"]["ja"]}
                          for t in TEMPLATES for c in budget[t]]}
    short = [t for t in TEMPLATES if len(accepted[t]) < q[t]]
    if short:
        C.write_text_atomic(DAILY_CACHE / f"report-{args.count}.json", json.dumps(rep, ensure_ascii=False, indent=1))
        for t in short:
            log(f"FAILED: template {t} has only {len(accepted[t])} of {q[t]} levels after {len(budget[t])} candidates")
        log(f"scheduler: {runner.sched.stats}; nothing written")
        sys.exit(1)

    pool_doc, ghosts_doc, order = build_pool(accepted, args.count)
    rep["pool"] = order
    errs = check_pool(pool_doc, ghosts_doc, args.count, cands)
    C.write_text_atomic(DAILY_CACHE / f"report-{args.count}.json", json.dumps(rep, ensure_ascii=False, indent=1))
    if errs:
        for e in errs:
            log(f"ERROR {e}")
        log("the pool fails its own checks; nothing written")
        sys.exit(1)
    # the two files are written last, each atomically (ghosts first: a reader of the pool
    # never sees a pool whose ghosts are missing)
    C.write_text_atomic(out_dir / GHOSTS_NAME, C.pretty_json(ghosts_doc) + "\n")
    C.write_text_atomic(out_dir / POOL_NAME, C.pretty_json(pool_doc) + "\n")
    summarise(pool_doc)
    log(f"scheduler: {runner.sched.stats}")
    log(f"wrote {out_dir / POOL_NAME} and {out_dir / GHOSTS_NAME} ({len(pool_doc['pool'])} levels)")


if __name__ == "__main__":
    main()
