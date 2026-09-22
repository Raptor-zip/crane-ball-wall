"""Figures and table data for the paper (paper/figs/*.pdf, paper/figs/data.tex).

Everything is regenerated from the project outputs:
  out/<mission>/<preset>/{plan.npz,report.json}   final nominal plans and reports
  out/robustness/{mc_1000.json,thresholds.json} robustness evaluation
The closed loops are re-simulated here from plan.npz with the project's own
TVLQR + DOP853 simulator, so the curves are the ones the reports describe.

    uv run python paper/make_figs.py
"""

from __future__ import annotations

import json
import sys
from dataclasses import replace
from pathlib import Path

import casadi as ca
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.patches import Circle, Rectangle

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from ballwall.__main__ import PRESETS  # noqa: E402
from ballwall.dynamics import tension  # noqa: E402
from ballwall.geometry import clearances  # noqa: E402
from ballwall.params import Plant, Scene  # noqa: E402
from ballwall.planner import Plan, plan, rk4_step, time_reversed  # noqa: E402
from ballwall.search import mission_scene  # noqa: E402
from ballwall.simulate import derived, simulate  # noqa: E402

FIG = Path(__file__).parent / "figs"
CACHE = Path(__file__).parent / "cache"
RUNS = [("enter", "fast"), ("escape", "fast"), ("enter", "pump"), ("escape", "pump")]
P, BASE = Plant(), Scene()

# light, print-friendly palette (consistent across figures)
K = {"ball": "#c0392b", "trolley": "#2e6db4", "string": "#555555", "wall": "#b5563e", "mortar": "#e9dcc6",
     "floor": "#b9ae9c", "rail": "#7f7f7f", "force": "#d68910", "ok": "#1e8449", "grey": "#9a9a9a",
     "alt": "#7d3c98"}
plt.rcParams.update({
    "font.family": ["DejaVu Sans", "Noto Sans CJK JP"], "font.size": 8.5, "axes.titlesize": 9,
    "axes.labelsize": 8.5, "legend.fontsize": 7.5, "xtick.labelsize": 7.5, "ytick.labelsize": 7.5,
    "axes.spines.top": False, "axes.spines.right": False, "axes.grid": True, "grid.color": "#e3e3e3",
    "grid.linewidth": 0.6, "lines.linewidth": 1.2, "savefig.bbox": "tight", "savefig.pad_inches": 0.02,
    "pdf.fonttype": 42,
})
W_FULL = 6.3  # inches, ≈ \textwidth


# ------------------------------------------------------------------ data

def load_plan(mission, preset) -> Plan:
    """Published nominal with the planner's own RK4 Jacobians (no re-solve)."""
    z = np.load(ROOT / "out" / mission / preset / "plan.npz")
    t, X, U = z["t"], z["X"], z["U"]
    cfg = PRESETS[preset]
    N, dt = len(U), cfg.T / cfg.N
    step = rk4_step(P, dt, cfg.substeps)
    s, u = ca.SX.sym("s", 4), ca.SX.sym("u")
    z_ = step(s, u)
    jac = ca.Function("j", [s, u], [ca.jacobian(z_, s), ca.jacobian(z_, u)])
    Aa, Ba = jac.map(N)(X[:, :-1], U[None, :])
    A = np.asarray(Aa).reshape(4, N, 4).transpose(1, 0, 2)
    B = np.asarray(Ba).reshape(4, N, 1).transpose(1, 0, 2)
    return Plan(t=t, X=X, U=U, dt=dt, A=A, B=B, stats={})


def closed_loop(nominal: Plan, mission, preset, hold=2.5, rate=1000):
    scene = mission_scene(BASE, mission)
    res = simulate(nominal, P, P, scene, hold=hold, F_limit=PRESETS[preset].F_max)
    d = derived(res, np.linspace(0, res.t_final, int(res.t_final * rate) + 1))
    cb, cs = clearances(d["S"][0], d["S"][2], scene, P.L)
    d["cb"], d["cs"], d["scene"], d["T"] = cb.min(axis=0), cs.min(axis=0), scene, nominal.t[-1]
    return d


def continuation_escape_fast() -> Plan:
    """The high-force local optimum reached by plain wall-height continuation (cached)."""
    CACHE.mkdir(exist_ok=True)
    f = CACHE / "escape_fast_continuation.npz"
    scene = mission_scene(BASE, "escape")
    if f.exists():
        z = np.load(f)
        p = Plan(t=z["t"], X=z["X"], U=z["U"], dt=float(z["t"][1] - z["t"][0]), A=None, B=None, stats={})
        p.stats["objective"] = float(z["objective"])
    else:
        p = plan(P, scene, PRESETS["fast"])
        np.savez(f, t=p.t, X=p.X, U=p.U, objective=p.stats["objective"])
    # Jacobians for the tracking controller
    q = load_plan_from_arrays(p.t, p.X, p.U, "fast")
    q.stats["objective"] = p.stats["objective"]
    return q


def load_plan_from_arrays(t, X, U, preset):
    cfg = PRESETS[preset]
    N, dt = len(U), cfg.T / cfg.N
    step = rk4_step(P, dt, cfg.substeps)
    s, u = ca.SX.sym("s", 4), ca.SX.sym("u")
    z_ = step(s, u)
    jac = ca.Function("j", [s, u], [ca.jacobian(z_, s), ca.jacobian(z_, u)])
    Aa, Ba = jac.map(N)(X[:, :-1], U[None, :])
    return Plan(t=t, X=X, U=U, dt=dt, A=np.asarray(Aa).reshape(4, N, 4).transpose(1, 0, 2),
                B=np.asarray(Ba).reshape(4, N, 1).transpose(1, 0, 2), stats={})


# ------------------------------------------------------------------ drawing helpers

TW, TH = 0.26, 0.12  # trolley body (same as the animation)


def draw_scene(ax, scene: Scene, xlim, ylim=(-0.06, 1.47), rail=True):
    ax.add_patch(Rectangle((xlim[0] - 1, -1), xlim[1] - xlim[0] + 2, 1, color=K["floor"], lw=0, zorder=1))
    for w in scene.walls:
        ax.add_patch(Rectangle((w.x0, 0), w.x1 - w.x0, w.h, facecolor=K["wall"], edgecolor="#7a3325",
                               lw=0.6, zorder=2, hatch="////"))
    if rail:
        ry = scene.rail_y + TH
        ends = (scene.x_min - TW / 2, scene.x_max + TW / 2)
        ax.plot(ends, [ry, ry], color=K["rail"], lw=2.2, solid_capstyle="butt", zorder=3)
        for xe in ends:
            ax.plot([xe, xe], [ry - 0.04, ry + 0.04], color=K["rail"], lw=1.8, zorder=3)
    ax.set_xlim(*xlim)
    ax.set_ylim(*ylim)
    ax.set_aspect("equal")
    ax.set_xticks([])
    ax.set_yticks([])
    ax.grid(False)
    for sp in ax.spines.values():
        sp.set_visible(False)


def draw_pendulum(ax, scene, x, th, alpha=1.0, z=10, lw=1.0):
    bx, by = scene.ball_pos(x, th, P.L, np)
    ax.plot([x, bx], [scene.rail_y, by], color=K["string"], lw=lw, alpha=alpha, zorder=z)
    ax.add_patch(Rectangle((x - TW / 2, scene.rail_y), TW, TH, color=K["trolley"], alpha=alpha, lw=0, zorder=z + 1))
    ax.add_patch(Circle((bx, by), scene.ball_r, color=K["ball"], alpha=alpha, lw=0, zorder=z + 2))


def strobe(ax, d, n=34, title=None):
    scene, T = d["scene"], d["T"]
    t, S = d["t"], d["S"]
    keep = t <= T + 1e-9
    t, S = t[keep], S[:, keep]
    bx, by = scene.ball_pos(S[0], S[2], P.L, np)
    draw_scene(ax, scene, (-1.45, 2.2))
    idx = np.searchsorted(t, np.linspace(0, T, n))
    for k, i in enumerate(idx):
        draw_pendulum(ax, scene, S[0, i], S[2, i], alpha=0.10 + 0.45 * k / n, z=5, lw=0.7)
    ax.plot(bx, by, color=K["ball"], lw=0.9, zorder=9)
    draw_pendulum(ax, scene, S[0, 0], S[2, 0], alpha=1.0, z=20)
    draw_pendulum(ax, scene, S[0, -1], S[2, -1], alpha=1.0, z=20)
    if title:
        ax.set_title(title, pad=2, fontsize=8)


# ------------------------------------------------------------------ figures

def fig_scene():
    scene = BASE
    fig, ax = plt.subplots(figsize=(W_FULL, 2.55))
    draw_scene(ax, scene, (-1.2, 2.45), ylim=(-0.22, 1.55))
    x, th = 0.35, np.radians(28)
    draw_pendulum(ax, scene, x, th, z=10, lw=1.2)
    bx, by = scene.ball_pos(x, th, P.L, np)
    # angle and force
    ax.plot([x, x], [scene.rail_y, scene.rail_y - 0.45], ls=":", color="k", lw=0.7)
    arc = np.linspace(-np.pi / 2, -np.pi / 2 + th, 30)
    ax.plot(x + 0.3 * np.cos(arc), scene.rail_y + 0.3 * np.sin(arc), color="k", lw=0.7)
    ax.text(x + 0.07, scene.rail_y - 0.4, r"$\theta$", fontsize=10)
    ax.annotate("", xy=(x + 0.45, scene.rail_y + TH / 2), xytext=(x + TW / 2 + 0.01, scene.rail_y + TH / 2),
                arrowprops=dict(arrowstyle="-|>", color=K["force"], lw=1.6, shrinkA=0, shrinkB=0))
    ax.text(x + 0.47, scene.rail_y + TH / 2, r"$F$", va="center", fontsize=10, color=K["force"])
    ax.text(x - 0.05, scene.rail_y + TH + 0.06, r"trolley $M$, position $x$", ha="center", fontsize=8)
    ax.text(bx - 0.1, by - 0.08, r"ball $m$, radius $r$", fontsize=8, va="center", ha="right")
    ax.text(0.5 * (x + bx) + 0.1, 0.5 * (scene.rail_y + by) + 0.02, r"string $L$", fontsize=8, rotation=-62)

    def dim(x0, y0, x1, y1, label, off=(0, 0), **kw):
        ax.annotate("", xy=(x1, y1), xytext=(x0, y0),
                    arrowprops=dict(arrowstyle="<->", lw=0.6, color="k", shrinkA=0, shrinkB=0))
        ax.text(0.5 * (x0 + x1) + off[0], 0.5 * (y0 + y1) + off[1], label, ha="center", va="center", fontsize=7.5, **kw)

    wa, wb = scene.walls
    dim(wa.x1, 0.35, wb.x0, 0.35, "0.42 m", off=(0, 0.06))
    dim(2.12, 0, 2.12, wa.h, "0.75 m", off=(0.14, 0), rotation=90)
    dim(-1.07, 0, -1.07, scene.rail_y, "1.25 m", off=(-0.08, 0), rotation=90)
    ax.text(wa.cx, wa.h + 0.05, "wall A", ha="center", fontsize=8)
    ax.text(wb.cx, wb.h + 0.05, "wall B", ha="center", fontsize=8)
    for xv, lab in ((0.0, "$x = 0$"), (scene.x_goal, "$x = 1.63$ (gap centre)")):
        ax.plot([xv, xv], [-0.05, -0.0], color="k", lw=0.8)
        ax.text(xv, -0.15, lab, ha="center", fontsize=7.5)
    ax.text(scene.x_min - TW / 2, scene.rail_y + TH + 0.07, "rail end\n(x = −1.0)", ha="left", fontsize=7)
    fig.savefig(FIG / "scene.pdf")
    plt.close(fig)


def fig_scene_col():
    """Column-width scene sketch for the two-column short version."""
    scene = BASE
    fig, ax = plt.subplots(figsize=(3.4, 1.62))
    draw_scene(ax, scene, (-1.2, 2.3), ylim=(-0.2, 1.52))
    x, th = 0.35, np.radians(28)
    draw_pendulum(ax, scene, x, th, z=10, lw=1.0)
    bx, by = scene.ball_pos(x, th, P.L, np)
    ax.plot([x, x], [scene.rail_y, scene.rail_y - 0.42], ls=":", color="k", lw=0.6)
    arc = np.linspace(-np.pi / 2, -np.pi / 2 + th, 30)
    ax.plot(x + 0.28 * np.cos(arc), scene.rail_y + 0.28 * np.sin(arc), color="k", lw=0.6)
    ax.text(x + 0.05, scene.rail_y - 0.42, r"$\theta$", fontsize=8)
    ax.annotate("", xy=(x + 0.5, scene.rail_y + TH / 2), xytext=(x + TW / 2, scene.rail_y + TH / 2),
                arrowprops=dict(arrowstyle="-|>", color=K["force"], lw=1.3, shrinkA=0, shrinkB=0))
    ax.text(x + 0.53, scene.rail_y + TH / 2, r"$F$", va="center", fontsize=8, color=K["force"])
    ax.text(x - 0.02, scene.rail_y + TH + 0.07, "台車", ha="center", fontsize=6.5)
    ax.text(bx - 0.1, by - 0.06, "ボール", ha="right", fontsize=6.5, va="center")
    ax.text(0.5 * (x + bx) + 0.09, 0.5 * (scene.rail_y + by), r"$L$", fontsize=7.5)
    wa, wb = scene.walls
    ax.annotate("", xy=(wb.x0, 0.33), xytext=(wa.x1, 0.33),
                arrowprops=dict(arrowstyle="<->", lw=0.5, color="k", shrinkA=0, shrinkB=0))
    ax.text(0.5 * (wa.x1 + wb.x0), 0.4, "0.42 m", ha="center", fontsize=6)
    ax.annotate("", xy=(2.13, wa.h), xytext=(2.13, 0),
                arrowprops=dict(arrowstyle="<->", lw=0.5, color="k", shrinkA=0, shrinkB=0))
    ax.text(2.2, 0.5 * wa.h, "0.75 m", rotation=90, va="center", fontsize=6)
    ax.text(wa.cx, wa.h + 0.05, "A", ha="center", fontsize=7)
    ax.text(wb.cx, wb.h + 0.05, "B", ha="center", fontsize=7)
    for xv, lab in ((0.0, "$x=0$"), (scene.x_goal, "$x=1.63$")):
        ax.plot([xv, xv], [-0.05, 0.0], color="k", lw=0.7)
        ax.text(xv, -0.14, lab, ha="center", fontsize=6)
    fig.savefig(FIG / "scene_col.pdf")
    plt.close(fig)


def fig_forces_col(D):
    """Column-width force comparison: fast vs pump for each mission."""
    fig, axs = plt.subplots(2, 1, figsize=(3.4, 2.35), sharex=True)
    for ax, m in zip(axs, ("enter", "escape")):
        for p, c in (("fast", "#ea580c"), ("pump", "#7c3aed")):
            d = D[(m, p)]
            keep = d["t"] <= d["T"] + 1e-9
            ax.plot(d["t"][keep], d["F"][keep], color=c, lw=0.9, label=f"{p} (max {np.abs(d['F']).max():.1f} N)")
        ax.set_ylim(-25, 25)
        ax.set_ylabel(f"{m}\n$F$ [N]", fontsize=7)
        ax.tick_params(labelsize=6.5)
        ax.legend(frameon=False, fontsize=6, loc="upper right", ncol=2, handlelength=1.2, columnspacing=0.8)
    axs[1].set_xlabel("time $t$ [s]", fontsize=7)
    fig.subplots_adjust(hspace=0.12)
    fig.savefig(FIG / "forces_col.pdf")
    plt.close(fig)


def fig_strobes(D):
    fig, axs = plt.subplots(2, 2, figsize=(W_FULL, 3.55))
    names = {"enter": "enter", "escape": "escape"}
    for ax, (m, p) in zip(axs.ravel(), RUNS):
        r = json.loads((ROOT / "out" / m / p / "report.json").read_text())
        strobe(ax, D[(m, p)], title=f"{names[m]} / {p}: T = {PRESETS[p].T:g} s, max|F| = {r['peak_force_N']:.1f} N")
    fig.subplots_adjust(wspace=0.06, hspace=0.14)
    fig.savefig(FIG / "strobes.pdf")
    plt.close(fig)


def fig_timeseries(D, runs, fname):
    fig, axs = plt.subplots(5, len(runs), figsize=(W_FULL, 6.0), sharex="col")
    axs = np.atleast_2d(axs).reshape(5, len(runs))
    for j, (m, p) in enumerate(runs):
        d = D[(m, p)]
        t, S, T, sc = d["t"], d["S"], d["T"], d["scene"]
        bx, _ = sc.ball_pos(S[0], S[2], P.L, np)
        a = axs[0, j]
        for w in sc.walls:
            a.axhspan(w.x0, w.x1, color=K["wall"], alpha=0.3, lw=0)
        a.plot(t, S[0], color=K["trolley"], label="trolley $x$")
        a.plot(t, bx, color=K["ball"], label="ball $x_b$ (row 1)")
        a.set_title(f"{m} / {p}")
        axs[1, j].plot(t, np.degrees(S[2]), color=K["string"])
        axs[2, j].plot(t, d["F"], color=K["force"], lw=1.0)
        a = axs[3, j]
        a.plot(t, 100 * np.minimum(d["cb"], 0.3), color=K["ball"], ls="-", label="_nolegend_")
        a.plot(t, 100 * np.minimum(d["cs"], 0.3), color=K["string"], ls="--", label="string gap (row 4)")
        a.axhline(2.0, color="k", ls="--", lw=0.7)
        a.set_ylim(0, 30)
        axs[4, j].plot(t, d["tension"], color=K["ok"])
        axs[4, j].axhline(1.5, color="k", ls="--", lw=0.7)
        axs[4, j].set_ylim(bottom=0)
        axs[4, j].set_xlabel("time $t$ [s]")
        for i in range(5):
            axs[i, j].axvline(T, color=K["grey"], ls=":", lw=0.8)
    axs[0, 0].set_ylabel("position [m]")
    axs[1, 0].set_ylabel(r"$\theta$ [deg]")
    axs[2, 0].set_ylabel("force $F$ [N]")
    axs[3, 0].set_ylabel("gap to wall [cm]")
    axs[4, 0].set_ylabel("tension [N]")
    h0, l0 = axs[0, 0].get_legend_handles_labels()
    h3, l3 = axs[3, 0].get_legend_handles_labels()
    fig.legend(h0 + h3, ["trolley $x$", "ball $x_b$; ball gap", "string gap"], loc="lower center",
               bbox_to_anchor=(0.5, 0.995), ncol=3, frameon=False)
    fig.align_ylabels(axs[:, 0])
    fig.subplots_adjust(hspace=0.16, wspace=0.18)
    fig.savefig(FIG / fname)
    plt.close(fig)


def fig_local_optima(D, d_cont, obj_cont):
    fig = plt.figure(figsize=(W_FULL, 3.9))
    gs = fig.add_gridspec(2, 2, height_ratios=[1.35, 1], hspace=0.28, wspace=0.05)
    r = json.loads((ROOT / "out/escape/fast/report.json").read_text())
    strobe(fig.add_subplot(gs[0, 0]), d_cont,
           title=f"(a) continuation: J = {obj_cont:.1f}, max|F| = {np.abs(d_cont['F']).max():.1f} N")
    strobe(fig.add_subplot(gs[0, 1]), D[("escape", "fast")],
           title=f"(b) seed: J = {r['plan']['objective']:.1f}, max|F| = {r['peak_force_N']:.1f} N")
    ax = fig.add_subplot(gs[1, :])
    for d, c, lab in ((d_cont, K["alt"], "(a) continuation"), (D[("escape", "fast")], K["force"], "(b) seed")):
        keep = d["t"] <= d["T"] + 1e-9
        ax.plot(d["t"][keep], d["F"][keep], color=c, label=lab)
    ax.set_xlabel("time $t$ [s]")
    ax.set_ylabel("force $F$ [N]")
    ax.legend(frameon=False, ncol=2, loc="lower center", bbox_to_anchor=(0.5, 1.0))
    fig.savefig(FIG / "local_optima.pdf")
    plt.close(fig)


def fig_local_optima_compact(D, d_cont, obj_cont):
    """One-row version for the two-page summary: the two strobes only."""
    fig, axs = plt.subplots(1, 2, figsize=(6.3, 1.45))
    r = json.loads((ROOT / "out/escape/fast/report.json").read_text())
    strobe(axs[0], d_cont, title=f"(a) continuation: J = {obj_cont:.0f}, max|F| = {np.abs(d_cont['F']).max():.1f} N")
    strobe(axs[1], D[("escape", "fast")],
           title=f"(b) seed: J = {r['plan']['objective']:.0f}, max|F| = {r['peak_force_N']:.1f} N")
    fig.subplots_adjust(wspace=0.04)
    fig.savefig(FIG / "local_optima_compact.pdf")
    plt.close(fig)


def fig_mc_compact():
    data = json.loads((ROOT / "out/robustness/mc_1000.json").read_text())
    fig, axs = plt.subplots(1, 4, figsize=(6.3, 1.3), sharey=True)
    bins = np.linspace(-2.0, 2.2, 43)
    for ax, (m, p) in zip(axs, RUNS):
        rows = data["base"][f"{m}/{p}"]
        vals = np.array([r["min_ball_clear"] for r in rows]) * 100
        ok = np.array([r["ok"] for r in rows])
        ax.hist(vals[vals >= 0], bins=bins, color=K["ok"], alpha=0.85)
        ax.hist(vals[vals < 0], bins=bins, color=K["ball"], alpha=0.9)
        ax.axvline(0, color="k", lw=0.7)
        ax.set_title(f"{m}/{p}: {100 * ok.mean():.1f} %", fontsize=7.5, pad=2)
        ax.set_xlabel("min ball gap [cm]", fontsize=7, labelpad=1)
        ax.tick_params(labelsize=6.5)
    axs[0].set_ylabel("count", fontsize=7)
    fig.subplots_adjust(wspace=0.08)
    fig.savefig(FIG / "mc_compact.pdf")
    plt.close(fig)


def fig_reversal():
    """Enter nominal vs the escape nominal played backwards (both fast)."""
    en = load_plan("enter", "fast")
    es = load_plan("escape", "fast")
    rev = time_reversed(es, P)
    fig, axs = plt.subplots(1, 3, figsize=(W_FULL, 1.85))
    t = en.t
    tu = 0.5 * (t[:-1] + t[1:])
    axs[0].plot(t, en.X[0], color="#8fb3e0", lw=3.2, label="enter")
    axs[0].plot(t, rev.X[0], color="k", ls="--", lw=0.9, label="escape, reversed")
    axs[0].set_ylabel("trolley $x$ [m]")
    axs[1].plot(t, np.degrees(en.X[2]), color="#8fb3e0", lw=3.2)
    axs[1].plot(t, np.degrees(rev.X[2]), color="k", ls="--", lw=0.9)
    axs[1].set_ylabel(r"$\theta$ [deg]")
    axs[2].step(tu, en.U, where="mid", color="#8fb3e0", lw=3.2)
    axs[2].step(tu, rev.U, where="mid", color="k", ls="--", lw=0.9)
    axs[2].set_ylabel("force [N]")
    for a in axs:
        a.set_xlabel("time $t$ [s]")
    fig.legend(*axs[0].get_legend_handles_labels(), loc="lower center", bbox_to_anchor=(0.5, 0.98), ncol=2,
               frameon=False)
    fig.subplots_adjust(wspace=0.42)
    fig.savefig(FIG / "reversal.pdf")
    plt.close(fig)
    return float(np.abs(en.X[0] - rev.X[0]).max()), float(np.degrees(np.abs(en.X[2] - rev.X[2]).max()))


def fig_mc():
    data = json.loads((ROOT / "out/robustness/mc_1000.json").read_text())
    fig, axs = plt.subplots(1, 4, figsize=(W_FULL, 1.75), sharey=True)
    bins = np.linspace(-2.0, 2.2, 43)
    rates = {}
    for ax, (m, p) in zip(axs, RUNS):
        rows = data["base"][f"{m}/{p}"]
        vals = np.array([r["min_ball_clear"] for r in rows]) * 100
        ok = np.array([r["ok"] for r in rows])
        rates[(m, p)] = ok.mean()
        ax.hist(vals[vals >= 0], bins=bins, color=K["ok"], alpha=0.85)
        ax.hist(vals[vals < 0], bins=bins, color=K["ball"], alpha=0.9)
        ax.axvline(0, color="k", lw=0.7)
        ax.set_title(f"{m} / {p}\nsuccess {100 * ok.mean():.1f} %", fontsize=8)
        ax.set_xlabel("min ball gap [cm]")
    axs[0].set_ylabel("count (of 1000)")
    fig.subplots_adjust(wspace=0.08)
    fig.savefig(FIG / "mc.pdf")
    plt.close(fig)
    return rates


def main():
    FIG.mkdir(exist_ok=True)
    fig_scene()
    D = {}
    for m, p in RUNS:
        D[(m, p)] = closed_loop(load_plan(m, p), m, p)
    fig_strobes(D)
    fig_scene_col()
    fig_forces_col(D)
    fig_timeseries(D, [("escape", "fast"), ("escape", "pump")], "timeseries_escape.pdf")
    fig_timeseries(D, [("enter", "fast"), ("enter", "pump")], "timeseries_enter.pdf")
    cont = continuation_escape_fast()
    d_cont = closed_loop(cont, "escape", "fast")
    fig_local_optima(D, d_cont, cont.stats["objective"])
    fig_local_optima_compact(D, d_cont, cont.stats["objective"])
    fig_mc_compact()
    dx, dth = fig_reversal()
    rates = fig_mc()
    print(f"reversal: max|dx| = {dx * 100:.1f} cm, max|dtheta| = {dth:.1f} deg")
    print("mc:", {f"{m}/{p}": round(100 * v, 1) for (m, p), v in rates.items()})
    print("continuation escape/fast: J =", round(cont.stats["objective"], 2), "peak", round(np.abs(d_cont["F"]).max(), 2))


if __name__ == "__main__":
    main()
