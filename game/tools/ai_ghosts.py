"""AI ghosts for the 18 campaign levels (spec §8).

    uv run python game/tools/ai_ghosts.py [--levels 2-2,3-1] [--jobs 20] [--force] [--apply-fallback]
                                          [--quick] [--check] [--timeout 600] [--headroom-goals near+ai]

Full mode (M2), per level:
  1. check that ai.tHi is feasible: scratch continuation, ai.seeds, shape morph — in parallel;
     if none solves, walk ai.fallback (levels.json is rewritten only with --apply-fallback)
  2. bisect T on [0.6 tHi, tHi] to 0.05 s (lower end x0.6 again while it still solves), then try
     T_min - 0.05 / - 0.10 from the stretched T_min plan (non-monotone feasibility)
     every T: stretched last feasible plan + scratch + seeds + morph, in parallel, lowest ∫F² wins
  3b. crown headroom: human-like rules at 0.92 T_min, then 0.96 T_min (stretch + scratch), with the
     trolley goal at the zone's near edge (§8.2 3b) and, in parallel, at the AI's own goal
     ai.xGoal[0] (--headroom-goals near+ai, the default): either one solving passes.  The near edge
     alone is not a relaxation of the AI's problem: on pump levels and pockets it is the harder goal
     (3-1 and 3-2 are infeasible there even at the AI's T_min, 5-2 at 0.96 T_min), which made
     '<4%' a probe artefact.  --headroom-goals near reproduces §8.2 3b as written.
  4. calm: effort optimum at round(1.4 T_min, 0.1) (stretched ai plan first, then the others)
  5. 5-4: 2-2 ai + 0.5 s rest + 2-3 ai (calm likewise); headroom = the worse of 2-2 / 2-3
  6-8. ghosts: 60 Hz Hermite samples + 1 s rest, parSub/splitSub on 120 Hz samples, statistics
Quick mode (--quick, milestone M2a): step 1 only (T = tHi, no bisection, no headroom), calm at
  round(1.4 tHi, 0.1) (stretched ai plan, then the other candidates; if none solves, the ai plan is
  reused as calm and the summary says so).  headroom is written as null ("not measured").

Every candidate runs in its own child process (BLAS threads = 1) and is killed after --timeout s
(default 600; counted as infeasible).  When no candidate of a step solves, the candidates whose
failure hit a time limit (IPOPT's 120 s wall time or the kill; on a loaded machine that is no proof
of infeasibility) get one retry with twice both limits (240 s / 2 x --timeout) under their own
cache key; if that fails too, the step counts as infeasible.  This applies to every step (tHi,
bisection, the probes below T_min, calm, headroom).
ai.marginMm (LevelDef, §12.1 fix) sets the AI rules' margin_ball = margin_string = marginMm / 1000
for that level (default 20 mm); the summary's aiMarginMm reports it.  The human-like headroom rules
keep their 2 mm.
Solves are cached in game/tools/.cache/<id>/<digest>.npz (--force ignores the cache).
Outputs: game/src/data/ghosts/<id>.json, game/src/data/ghosts_summary.json.
--check only decodes and checks the existing ghost files (the §8.3 gate, in Python).
"""

from __future__ import annotations

import argparse
import copy
import json
import math
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import common as C  # noqa: E402

T0 = time.time()
_print_lock = threading.Lock()


def log(msg: str):
    with _print_lock:
        print(f"[{time.time() - T0:7.1f}s] {msg}", flush=True)


# ================================================================ fallback (§5.2)

def apply_fallback_step(lv: dict, step: dict) -> str | None:
    """Apply one application of a fallback op in place; None when it is exhausted."""
    ai, p = lv["ai"], lv["physics"]
    op = step["op"]
    if op == "raiseT":
        new = C.r3(min(ai["tHi"] + step["by"], step["max"]))
        if new <= ai["tHi"] + 1e-9:
            return None
        old, ai["tHi"] = ai["tHi"], new
        return f"raiseT: ai.tHi {C.js_number(old)} -> {C.js_number(new)}"
    if op == "lowerWall":
        changes = []
        for i in step["walls"]:
            w = p["walls"][i]
            new = C.r3(max(w["h"] - step["by"], step["min"]))
            if new < w["h"] - 1e-9:
                changes.append(f"wall {i} h {C.js_number(w['h'])} -> {C.js_number(new)}")
                w["h"] = new
        return "lowerWall: " + ", ".join(changes) if changes else None
    if op == "moveWall":
        i, by = step["wall"], step["by"]
        w = p["walls"][i]
        k = next((j for j, z in enumerate(p["phases"]) if z["kind"] == "pocket" and abs(z["xb"] - w["x0"]) < 1e-9), None)
        if k is None:
            return None
        z = p["phases"][k]
        if z["xb"] + by - z["xa"] > step["maxGap"] + 1e-9:
            return None
        if i + 1 < len(p["walls"]) and w["x1"] + by > p["walls"][i + 1]["x0"]:
            return None
        old = (w["x0"], w["x1"], z["xb"], ai["xGoal"][k])
        w["x0"], w["x1"], z["xb"] = C.r3(w["x0"] + by), C.r3(w["x1"] + by), C.r3(z["xb"] + by)
        ai["xGoal"][k] = C.r3(0.5 * (z["xa"] + z["xb"]))
        return (f"moveWall: wall {i} x {C.js_number(old[0])}..{C.js_number(old[1])} -> {C.js_number(w['x0'])}.."
                f"{C.js_number(w['x1'])}, pocket xb {C.js_number(old[2])} -> {C.js_number(z['xb'])} "
                f"(gap {C.js_number(C.r3(z['xb'] - z['xa']))}), xGoal[{k}] {C.js_number(old[3])} -> {C.js_number(ai['xGoal'][k])}")
    if op == "raiseTmax":
        egg = p["egg"]
        new = C.r3(min(egg["Tmax"] + step["by"], step["max"]))
        if new <= egg["Tmax"] + 1e-9:
            return None
        d = new - egg["Tmax"]
        old = (egg["Tmax"], ai.get("tensionMax"))
        egg["Tmax"] = new
        if ai.get("tensionMax") is not None:
            ai["tensionMax"] = C.r3(ai["tensionMax"] + d)
        return f"raiseTmax: egg.Tmax {C.js_number(old[0])} -> {C.js_number(new)}, ai.tensionMax {old[1]} -> {ai.get('tensionMax')}"
    raise ValueError(op)


def fallback_chain(lv: dict):
    """Yield (description, level) for each successive fallback application (§5.2)."""
    cur = copy.deepcopy(lv)
    for step in lv["ai"]["fallback"]:
        while True:
            desc = apply_fallback_step(cur, step)
            if desc is None:
                break
            C.validate_level(cur)
            yield desc, copy.deepcopy(cur)


# ================================================================ per-level pipeline

def std_cands(lv: dict, prev: dict | None):
    out = [C.cand_stretch(prev)] if prev else []
    out.append(C.cand_scratch())
    out += [C.cand_seed(s) for s in lv["ai"].get("seeds", [])]
    ms = C.morph_seed_for(lv)
    if C.canonical_json(C.seed_face(ms)) != C.canonical_json(C.level_face(lv)):
        out.append(C.cand_morph(ms))
    return out


class LevelRun:
    def __init__(self, lv: dict, sched: C.Scheduler, quick: bool, headroom_ai_goal: bool = True):
        self.headroom_ai_goal = headroom_ai_goal
        self.lv0 = lv
        self.lv = lv
        self.id = lv["id"]
        self.sched = sched
        self.quick = quick
        self.applied: list[str] = []
        self.error: str | None = None

    def solve(self, T: float, cands: list, rules: str = "ai", tag: str = "", goal: float | None = None) -> dict | None:
        """Lowest-effort plan of the candidates at T, or None.  When none solves, the ones that
        hit a time limit get one retry with longer limits (C.cand_retry).  `goal`: the human-like
        rules' trolley goal (default: the zone's near edge)."""
        face = C.level_face(self.lv, rules, goal)
        pr = C.make_problem(face, rules, T, C.ai_margin_mm(self.lv) if rules == "ai" else None)
        res = self.sched.run_many(self.id, pr, cands, tag)
        best = C.best_of(res)
        if best is None:
            again = [C.cand_retry(c) for c, r in zip(cands, res) if not c.get("attempt") and C.time_limited(r)]
            if again:
                log(f"[{self.id}] {tag} T={pr['T']:g} {rules}: nothing solved; retrying the "
                    f"{len(again)} time-limited start(s) with longer limits")
                best = C.best_of(self.sched.run_many(self.id, pr, again, tag + "-retry"))
        return best

    def run(self):
        try:
            self._run()
        except Exception as e:  # keep the other levels going
            import traceback
            self.error = f"{type(e).__name__}: {e}"
            log(f"[{self.id}] ERROR {self.error}\n{traceback.format_exc()}")

    def _run(self):
        # 1. tHi feasibility, then the fallback chain
        chain = fallback_chain(self.lv0)
        while True:
            tHi = self.lv["ai"]["tHi"]
            hi = self.solve(tHi, std_cands(self.lv, None), tag="tHi")
            if hi:
                break
            nxt = next(chain, None)
            if nxt is None:
                raise RuntimeError(f"infeasible at tHi={tHi} and the fallback chain is exhausted "
                                   f"(applied: {self.applied or 'none'})")
            desc, self.lv = nxt
            self.applied.append(desc)
            log(f"[{self.id}] FALLBACK {desc}")
        log(f"[{self.id}] feasible at tHi={tHi}: {C.cand_name(hi['cand'])} peak={hi['peak']:.2f}")

        if self.quick:
            self.tmin, self.ai = tHi, hi
        else:
            self.tmin, self.ai = self.bisect(tHi, hi)
        self.calmT = math.floor(1.4 * self.tmin * 10 + 0.5) / 10
        self.calm, self.calm_reused = self.solve_calm(self.calmT)
        self.headroom = None if self.quick else self.measure_headroom()
        log(f"[{self.id}] done: T_min={self.tmin} calmT={self.calmT}{' (reused ai)' if self.calm_reused else ''} "
            f"headroom={self.headroom}")

    def bisect(self, tHi: float, hi: dict):
        T_hi, P_hi = tHi, hi
        lo = C.r3(0.6 * tHi)
        for _ in range(6):  # lower end x0.6 again while it still solves
            r = self.solve(lo, std_cands(self.lv, P_hi), tag="lo")
            if not r:
                break
            T_hi, P_hi = lo, r
            lo = C.r3(0.6 * lo)
            if lo < 0.5:
                break
        while T_hi - lo > 0.05 + 1e-9:
            mid = C.r3(0.5 * (lo + T_hi))
            r = self.solve(mid, std_cands(self.lv, P_hi), tag="bisect")
            if r:
                T_hi, P_hi = mid, r
            else:
                lo = mid
        # non-monotone feasibility: two more steps below from the stretched T_min plan
        below = [C.r3(T_hi - 0.05), C.r3(T_hi - 0.10)]
        res = [None, None]

        def probe(i):
            res[i] = self.solve(below[i], [C.cand_stretch(P_hi)], tag="below")
        ths = [threading.Thread(target=probe, args=(i,)) for i in range(2)]
        for th in ths:
            th.start()
        for th in ths:
            th.join()
        for T, r in sorted(zip(below, res), key=lambda z: z[0]):
            if r:
                log(f"[{self.id}] non-monotone: T={T} solves below the bisection's {T_hi}")
                T_hi, P_hi = T, r
                break
        log(f"[{self.id}] T_min = {T_hi}")
        return T_hi, P_hi

    def solve_calm(self, T: float):
        r = self.solve(T, [C.cand_stretch(self.ai)], tag="calm")
        if not r:
            r = self.solve(T, std_cands(self.lv, None), tag="calm2")
        if r:
            return r, False
        log(f"[{self.id}] WARNING calm at T={T} failed from every candidate: reusing the ai plan")
        return self.ai, True

    def measure_headroom(self) -> str:
        goals = C.human_goals(self.lv, self.headroom_ai_goal)
        for frac, label in ((0.92, ">=8%"), (0.96, "4-8%")):
            T = C.r3(frac * self.tmin)
            res = {}

            def probe(g):
                res[g] = self.solve(T, [C.cand_stretch(self.ai), C.cand_scratch()], rules="human",
                                    tag=f"headroom{frac}" + (f" goal={C.js_number(g)}" if len(goals) > 1 else ""), goal=g)
            ths = [threading.Thread(target=probe, args=(g,)) for g in goals]
            for th in ths:
                th.start()
            for th in ths:
                th.join()
            if any(res.values()):
                log(f"[{self.id}] headroom {label}: solved at T={T:g} with the goal(s) "
                    f"{[C.js_number(g) for g in goals if res[g]]} of {[C.js_number(g) for g in goals]}")
                if label != ">=8%":
                    log(f"[{self.id}] WARNING headroom {label}")
                return label
        log(f"[{self.id}] WARNING headroom <4%: the crown is practically out of reach (fix per §12.1)")
        return "<4%"


# ================================================================ outputs

HEADROOM_ORDER = {">=8%": 0, "4-8%": 1, "<4%": 2}


def research_ghosts(lv: dict) -> list[dict]:
    out = []
    for name in lv["ai"].get("extras", []):
        p = C.load_seed_plan(name)
        kind = "research_fast" if name.endswith("_fast") else "research_pump"
        out.append(C.build_ghost(lv, C.Traj.of(p), kind, plan_T=float(p.t[-1])))
    return out


def write_level(lv: dict, ai_tr: C.Traj, calm_tr: C.Traj, info: dict, summary: dict, mode: str):
    ghosts = [C.build_ghost(lv, ai_tr, "ai", info["planT"]), C.build_ghost(lv, calm_tr, "calm", info["calmT"])]
    ghosts += research_ghosts(lv)
    doc = {"format": 1, "levelId": lv["id"], "physics": lv["physics"], "ghosts": ghosts}
    C.write_text_atomic(C.GHOST_DIR / f"{lv['id']}.json", C.pretty_json(doc) + "\n")
    ai = ghosts[0]
    summary["levels"][lv["id"]] = {
        "hash": C.level_hash(lv["physics"]), "parSub": ai["parSub"], "tMin": C.r3(info["tMin"]),
        "planT": ai["planT"], "calmT": C.r3(info["calmT"]), "peakF": ai["peakF"], "minGapMm": ai["minGapMm"],
        "pumps": ai["pumps"], "headroom": info["headroom"], "aiMarginMm": C.summary_margin_mm(lv),
        "aiTensionMinN": C.AI_TENSION_MIN, "fallbackApplied": info["fallbackApplied"], "mode": mode,
    }
    extra = {k: v for k, v in info.items() if k in ("ai", "calm")}
    C.write_text_atomic(C.CACHE_DIR / lv["id"] / "result.json", json.dumps({
        "hash": C.level_hash(lv["physics"]), "mode": mode, **extra,
        **{k: info[k] for k in ("tMin", "planT", "calmT", "headroom", "fallbackApplied", "calmReused")}}, indent=1))
    log(f"[{lv['id']}] wrote ghosts/{lv['id']}.json: " + ", ".join(
        f"{g['kind']} parSub={g['parSub']} planT={g['planT']}" for g in ghosts))


def load_summary() -> dict:
    if C.SUMMARY_JSON.exists():
        return json.loads(C.SUMMARY_JSON.read_text(encoding="utf-8"))
    return {"format": 1, "levels": {}}


def save_summary(summary: dict, doc: dict):
    order = [lv["id"] for lv in doc["levels"]]
    summary["levels"] = {k: summary["levels"][k] for k in order if k in summary["levels"]}
    C.write_text_atomic(C.SUMMARY_JSON, C.pretty_json(summary) + "\n")


def compose_level(lv: dict, parts: dict, summary: dict, mode: str):
    a, rest, b = lv["ai"]["compose"]
    A, B = parts[a], parts[b]
    ai_tr = C.compose([A["aiTraj"], ("rest", rest), B["aiTraj"]])
    calm_tr = C.compose([A["calmTraj"], ("rest", rest), B["calmTraj"]])
    hr = [A["headroom"], B["headroom"]]
    headroom = None if None in hr else max(hr, key=lambda h: HEADROOM_ORDER[h])
    info = {"tMin": ai_tr.T, "planT": ai_tr.T, "calmT": calm_tr.T, "headroom": headroom,
            "fallbackApplied": [], "calmReused": A["calmReused"] or B["calmReused"]}
    write_level(lv, ai_tr, calm_tr, info, summary, mode)


def part_from_cache(lid: str, lv: dict) -> dict | None:
    """ai / calm trajectories of a level from a previous run (for 5-4 alone)."""
    path = C.CACHE_DIR / lid / "result.json"
    if not path.exists():
        return None
    r = json.loads(path.read_text())
    if r["hash"] != C.level_hash(lv["physics"]):
        return None
    tr = {k: C.Traj.of(C.load_result_npz(C.cache_path(r[k]["level"], r[k]["digest"]))) for k in ("ai", "calm")}
    return {"aiTraj": tr["ai"], "calmTraj": tr["calm"], "headroom": r["headroom"], "calmReused": r["calmReused"]}


# ================================================================ check (§8.3 in Python)

def check_all(doc: dict, ids: list[str]) -> bool:
    by = C.level_by_id(doc)
    summary = load_summary()
    ok = True
    print(f"\n{'id':5s} {'kind':14s} {'parSub':>6s} {'ts':>5s} {'planT':>6s} {'peakF':>6s} {'gapMm':>6s} "
          f"{'strMm':>6s} {'top':>6s} {'maxT':>6s} {'splits':18s} errors")
    for lid in ids:
        lv = by[lid]
        path = C.GHOST_DIR / f"{lid}.json"
        if not path.exists():
            print(f"{lid:5s} MISSING ghost file")
            ok = False
            continue
        gdoc = json.loads(path.read_text(encoding="utf-8"))
        errs0 = []
        if gdoc["physics"] != lv["physics"]:
            errs0.append("physics copy differs from levels.json")
        kinds = [g["kind"] for g in gdoc["ghosts"]]
        if "ai" not in kinds or "calm" not in kinds:
            errs0.append(f"missing ai/calm (have {kinds})")
        s = summary["levels"].get(lid)
        if not s or s["hash"] != C.level_hash(lv["physics"]):
            errs0.append("summary hash missing/stale")
        elif s["headroom"] == "<4%":
            errs0.append("headroom <4%")
        if errs0:
            ok = False
            print(f"{lid:5s} FILE ERRORS: {errs0}")
        for g in gdoc["ghosts"]:
            r = C.check_ghost(lv, g)
            ok &= not r["errors"]
            gap = "-" if r["minGapMm"] is None else f"{r['minGapMm']:.1f}"
            sg = "-" if r["minStringGapMm"] is None else f"{r['minStringGapMm']:.1f}"
            print(f"{lid:5s} {g['kind']:14s} {g['parSub']:6d} {r['parSubTs'] or -1:5d} {g['planT']:6.2f} "
                  f"{g['peakF']:6.2f} {gap:>6s} {sg:>6s} {r['maxBallTop']:6.3f} {r['maxTension']:6.2f} "
                  f"{str(g['splitSub']):18s} {'; '.join(r['errors']) or 'ok'}")
    print("\nCHECK", "PASSED" if ok else "FAILED")
    return ok


# ================================================================ main

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--levels", help="comma-separated level ids (default: all 18)")
    ap.add_argument("--jobs", type=int, default=20)
    ap.add_argument("--force", action="store_true", help="ignore cached solves")
    ap.add_argument("--apply-fallback", action="store_true", help="write fallback changes to levels.json")
    ap.add_argument("--quick", action="store_true", help="M2a: solve at tHi only (no bisection, no headroom)")
    ap.add_argument("--check", action="store_true", help="only check the existing ghost files")
    ap.add_argument("--timeout", type=float, default=C.CANDIDATE_TIMEOUT_S, help="per-candidate kill [s]")
    ap.add_argument("--headroom-goals", choices=("near", "near+ai"), default="near+ai",
                    help="trolley goals of the headroom probe: the zone's near edge only (§8.2 3b as written), or "
                         "also the AI's own goal (default; makes the human-like rules a relaxation of the AI's)")
    args = ap.parse_args(argv)

    doc = C.load_levels()
    C.validate_levels_file(doc)
    by = C.level_by_id(doc)
    ids = args.levels.split(",") if args.levels else [lv["id"] for lv in doc["levels"]]
    for lid in ids:
        if lid not in by:
            ap.error(f"unknown level {lid}")
    if args.check:
        sys.exit(0 if check_all(doc, ids) else 1)

    mode = "quick" if args.quick else "full"
    compose_ids = [lid for lid in ids if by[lid]["ai"].get("compose")]
    need = set(ids)
    parts: dict[str, dict] = {}
    for lid in compose_ids:
        for dep in (by[lid]["ai"]["compose"][0], by[lid]["ai"]["compose"][2]):
            if dep not in need:
                cached = part_from_cache(dep, by[dep])
                if cached:
                    parts[dep] = cached
                    log(f"[{lid}] using the cached {dep} result")
                else:
                    need.add(dep)
    solve_ids = [lv["id"] for lv in doc["levels"] if lv["id"] in need and not lv["ai"].get("compose")]
    log(f"mode={mode} jobs={args.jobs} timeout={args.timeout:.0f}s force={args.force} "
        f"apply-fallback={args.apply_fallback} headroom-goals={args.headroom_goals} "
        f"levels={','.join(solve_ids + compose_ids)}")

    sched = C.Scheduler(args.jobs, timeout=args.timeout, force=args.force, log=log)
    runs = {lid: LevelRun(by[lid], sched, args.quick, args.headroom_goals == "near+ai") for lid in solve_ids}
    threads = [threading.Thread(target=r.run, name=lid) for lid, r in runs.items()]
    for th in threads:
        th.start()
    for th in threads:
        th.join()

    summary = load_summary()
    failed, written, proposals = [], [], []
    doc_changed = False
    for lid, r in runs.items():
        if r.error:
            failed.append(f"{lid}: {r.error}")
            continue
        phys_changed = r.lv["physics"] != r.lv0["physics"]
        ai_changed = r.lv["ai"] != r.lv0["ai"]
        if r.applied:
            if args.apply_fallback:
                idx = next(i for i, lv in enumerate(doc["levels"]) if lv["id"] == lid)
                doc["levels"][idx] = r.lv
                doc_changed = True
            else:
                proposals.append(f"{lid}: needs {r.applied} (re-run with --apply-fallback to write levels.json)")
                if phys_changed:
                    failed.append(f"{lid}: solvable only with a physics fallback; ghosts not written")
                    continue
        info = {"tMin": r.tmin, "planT": r.tmin, "calmT": r.calmT, "headroom": r.headroom,
                "fallbackApplied": r.applied if (args.apply_fallback or not ai_changed) else [],
                "calmReused": r.calm_reused,
                "ai": {"digest": r.ai["digest"], "level": r.ai["level"]},
                "calm": {"digest": r.calm["digest"], "level": r.calm["level"]}}
        lv = r.lv if args.apply_fallback else r.lv0
        try:
            write_level(lv, C.Traj.of(r.ai), C.Traj.of(r.calm), info, summary, mode)
            written.append(lid)
            parts[lid] = {"aiTraj": C.Traj.of(r.ai), "calmTraj": C.Traj.of(r.calm), "headroom": r.headroom,
                          "calmReused": r.calm_reused}
        except Exception as e:
            failed.append(f"{lid}: ghost build failed: {e}")
    if doc_changed:
        C.validate_levels_file(doc)
        C.save_levels(doc)
        log("levels.json rewritten with the applied fallbacks")
    by = C.level_by_id(doc)
    for lid in compose_ids:
        a, _, b = by[lid]["ai"]["compose"]
        if a in parts and b in parts:
            compose_level(by[lid], parts, summary, mode)
            written.append(lid)
        else:
            failed.append(f"{lid}: compose needs {a} and {b}")
    save_summary(summary, doc)

    log(f"scheduler: {sched.stats}")
    for p in proposals:
        log(f"PROPOSAL {p}")
    for lid, r in runs.items():
        if r.applied:
            log(f"FALLBACK APPLIED {lid}: {r.applied}")
    for f in failed:
        log(f"FAILED {f}")
    ok = check_all(doc, written) if written else False
    sys.exit(0 if ok and not failed else 1)


if __name__ == "__main__":
    main()
