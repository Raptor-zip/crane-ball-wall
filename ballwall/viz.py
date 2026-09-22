"""matplotlib views: side-view animation, stroboscopic still, time-series summary."""

from __future__ import annotations

import subprocess

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt
import numpy as np
from matplotlib import font_manager
from matplotlib.animation import FFMpegWriter, FuncAnimation
from matplotlib.collections import LineCollection
from matplotlib.patches import Circle, Rectangle

from .geometry import clearances
from .params import Plant, Scene

# white background, print-like palette
C = {
    "bg": "#ffffff",
    "panel": "#ffffff",
    "floor": "#d8d0c2",
    "brick": "#c4553b",
    "mortar": "#efe3cf",
    "ball": "#dc2626",
    "trolley": "#2563eb",
    "rail": "#9ca3af",
    "string": "#374151",
    "text": "#1f2937",
    "muted": "#6b7280",
    "grid": "#e5e7eb",
    "force": "#d97706",
    "ok": "#15803d",
    "bad": "#dc2626",
}

FONT = "Noto Sans JP"


def use_font(family: str = FONT) -> str:
    """Register `family` with matplotlib (fontconfig lookup, so user-installed
    fonts work even when matplotlib's cache predates them) and make it the
    default.  Falls back to Noto Sans CJK JP, the same design in a TTC."""
    names = {f.name for f in font_manager.fontManager.ttflist}
    if family not in names:
        try:
            files = subprocess.run(["fc-list", f"{family}", "file"], capture_output=True, text=True,
                                   check=True).stdout.split()
        except (OSError, subprocess.CalledProcessError):
            files = []
        for f in files:
            font_manager.fontManager.addfont(f.rstrip(":"))
        names = {f.name for f in font_manager.fontManager.ttflist}
    chosen = family if family in names else "Noto Sans CJK JP"
    plt.rcParams["font.family"] = [chosen, "DejaVu Sans"]
    return chosen


use_font()

TROLLEY_W, TROLLEY_H = 0.26, 0.12


def _style_axes(ax):
    ax.set_facecolor(C["panel"])
    for sp in ax.spines.values():
        sp.set_color(C["grid"])
    ax.tick_params(colors=C["muted"], labelsize=8)
    ax.xaxis.label.set_color(C["muted"])
    ax.yaxis.label.set_color(C["muted"])
    ax.title.set_color(C["text"])
    ax.grid(color=C["grid"], lw=0.6)


def draw_static(ax, scene: Scene, xlim):
    """Floor, brick walls and rail."""
    ax.set_facecolor(C["bg"])
    ax.add_patch(Rectangle((xlim[0] - 1, -1), xlim[1] - xlim[0] + 2, 1, color=C["floor"], zorder=1))
    course, brick = 0.05, 0.12
    for w in scene.walls:
        ax.add_patch(Rectangle((w.x0, 0), w.x1 - w.x0, w.h, color=C["mortar"], zorder=2))
        n_rows = int(np.ceil(w.h / course))
        for r in range(n_rows):
            y0 = r * course
            hgt = min(course, w.h - y0) - 0.008
            off = (r % 2) * brick / 2
            xs = np.arange(w.x0 - off, w.x1, brick)
            for xb in xs:
                a, b = max(xb, w.x0) + 0.004, min(xb + brick, w.x1) - 0.004
                if b > a:
                    ax.add_patch(Rectangle((a, y0 + 0.004), b - a, hgt, color=C["brick"], zorder=3))
    # end stops where the trolley's edge sits at the travel limits
    ry = scene.rail_y + TROLLEY_H
    ends = (scene.x_min - TROLLEY_W / 2, scene.x_max + TROLLEY_W / 2)
    ax.plot(ends, [ry, ry], color=C["rail"], lw=4, solid_capstyle="butt", zorder=4)
    for xe in ends:
        ax.plot([xe, xe], [ry - 0.05, ry + 0.05], color=C["rail"], lw=3, zorder=4)
    ax.set_xlim(*xlim)
    ax.set_ylim(-0.08, scene.rail_y + 0.3)
    ax.set_aspect("equal")
    ax.set_xticks([])
    ax.set_yticks([])
    for sp in ax.spines.values():
        sp.set_visible(False)


class PendulumArtist:
    def __init__(self, ax, scene: Scene, plant: Plant, alpha=1.0, zorder=10):
        self.scene, self.L = scene, plant.L
        self.string, = ax.plot([], [], color=C["string"], lw=2, alpha=alpha, zorder=zorder,
                               solid_capstyle="round")
        self.trolley = Rectangle((0, 0), TROLLEY_W, TROLLEY_H, color=C["trolley"], alpha=alpha,
                                 zorder=zorder + 1)
        self.ball = Circle((0, 0), scene.ball_r, color=C["ball"], alpha=alpha, zorder=zorder + 2)
        ax.add_patch(self.trolley)
        ax.add_patch(self.ball)

    def update(self, x, th):
        bx, by = self.scene.ball_pos(x, th, self.L, np)
        py = self.scene.rail_y
        self.string.set_data([x, bx], [py, by])
        self.trolley.set_xy((x - TROLLEY_W / 2, py))
        self.ball.center = (bx, by)
        return self.string, self.trolley, self.ball


def _xlim(scene: Scene, x, th, L):
    bx = x + L * np.sin(th)
    lo = min(x.min(), bx.min(), scene.walls[0].x0) - 0.35
    hi = max(x.max(), bx.max(), scene.walls[-1].x1) + 0.35
    return lo, hi


def animate(data: dict, scene: Scene, plant: Plant, path, fps=30, title=""):
    t, S, F = data["t"], data["S"], data["F"]
    x, th = S[0], S[2]
    bx, by = scene.ball_pos(x, th, plant.L, np)

    fig = plt.figure(figsize=(12.8, 7.2), dpi=100, facecolor=C["bg"])
    gs = fig.add_gridspec(2, 2, height_ratios=[3.2, 1], hspace=0.28, wspace=0.14,
                          left=0.05, right=0.98, top=0.93, bottom=0.08)
    ax = fig.add_subplot(gs[0, :])
    draw_static(ax, scene, _xlim(scene, x, th, plant.L))
    fig.text(0.05, 0.955, title, color=C["text"], fontsize=13, weight="bold", va="center")

    trail = LineCollection([], linewidths=2, zorder=8)
    ax.add_collection(trail)
    pend = PendulumArtist(ax, scene, plant)
    arrow = ax.annotate("", xy=(0, 0), xytext=(0, 0), zorder=12,
                        arrowprops=dict(arrowstyle="-|>", color=C["force"], lw=2.2, mutation_scale=14,
                                        shrinkA=0, shrinkB=0))
    # one line above the rail, so it never covers the rail or the trolley
    txt = ax.text(0.99, 0.995, "", transform=ax.transAxes, color=C["text"], fontsize=11,
                  va="top", ha="right", zorder=30)

    axF = fig.add_subplot(gs[1, 0])
    axH = fig.add_subplot(gs[1, 1])
    for a in (axF, axH):
        _style_axes(a)
        a.set_xlim(t[0], t[-1])
    axF.plot(t, F, color=C["force"], lw=1.2)
    axF.set_ylabel("force F [N]")
    axF.set_xlabel("time [s]")
    cb, cs = clearances(x, th, scene, plant.L)
    axH.axhline(0, color=C["bad"], lw=1)
    axH.plot(t, np.minimum(cb.min(axis=0), 0.5), color=C["ball"], lw=1.2, label="ball")
    axH.plot(t, np.minimum(cs.min(axis=0), 0.5), color=C["string"], lw=1.2, label="string")
    axH.set_ylabel("gap to wall [m]")
    axH.set_xlabel("time [s]")
    axH.set_ylim(-0.02, 0.5)
    axH.legend(loc="upper right", fontsize=8, facecolor=C["panel"], labelcolor=C["text"], edgecolor=C["grid"])
    # above the spines (zorder 2.5), so the cursor stays visible on the first and last frame
    curF = axF.axvline(t[0], color=C["text"], lw=1, clip_on=False, zorder=3)
    curH = axH.axvline(t[0], color=C["text"], lw=1, clip_on=False, zorder=3)

    F_peak = max(np.max(np.abs(F)), 1e-9)
    f_scale = 0.4 / F_peak
    n_trail = int(1.2 * fps)
    step = max(1, int(round((len(t) - 1) / (t[-1] - t[0]) / fps)))
    frames = range(0, len(t), step)

    def frame(i):
        arts = pend.update(x[i], th[i])
        j0 = max(0, i - n_trail * step)
        pts = np.column_stack([bx[j0:i + 1:step], by[j0:i + 1:step]])
        if len(pts) > 1:
            segs = np.stack([pts[:-1], pts[1:]], axis=1)
            alpha = np.linspace(0.0, 0.8, len(segs))
            rgba = np.tile(matplotlib.colors.to_rgba(C["ball"]), (len(segs), 1))
            rgba[:, 3] = alpha
            trail.set_segments(segs)
            trail.set_colors(rgba)
        y_arrow = scene.rail_y + TROLLEY_H / 2
        arrow.set_position((x[i], y_arrow))
        arrow.xy = (x[i] + F[i] * f_scale, y_arrow)
        arrow.set_visible(abs(F[i]) > 0.1 * F_peak)  # shorter than its head, the arrow misstates |F|
        f_txt, th_txt = np.round(F[i], 1) + 0.0, np.round(np.degrees(th[i]), 1) + 0.0  # no "-0.0"
        txt.set_text(f"t = {t[i]:5.2f} s    F = {f_txt:+6.1f} N    θ = {th_txt:+6.1f}°")
        curF.set_xdata([t[i], t[i]])
        curH.set_xdata([t[i], t[i]])
        return (*arts, trail, arrow, txt, curF, curH)

    anim = FuncAnimation(fig, frame, frames=frames, blit=True)
    anim.save(str(path), writer=FFMpegWriter(fps=fps, bitrate=6000, codec="libx264",
                                             extra_args=["-pix_fmt", "yuv420p"]))
    plt.close(fig)


def strobe(data: dict, scene: Scene, plant: Plant, path, n_shots=36, t_end=None, title=""):
    """Stroboscopic still: faded snapshots of the manoeuvre (up to t_end)."""
    t, S = data["t"], data["S"]
    if t_end is not None:
        keep = t <= t_end + 1e-9
        t, S = t[keep], S[:, keep]
    every = (t[-1] - t[0]) / n_shots
    x, th = S[0], S[2]
    bx, by = scene.ball_pos(x, th, plant.L, np)
    fig, ax = plt.subplots(figsize=(12.8, 5.6), dpi=120, facecolor=C["bg"])
    fig.subplots_adjust(left=0.01, right=0.99, top=0.9, bottom=0.02)
    draw_static(ax, scene, _xlim(scene, x, th, plant.L))
    ax.set_title(title, color=C["text"], fontsize=12, weight="bold")
    idx = np.searchsorted(t, np.arange(t[0], t[-1], every))
    for k, i in enumerate(idx):
        PendulumArtist(ax, scene, plant, alpha=0.12 + 0.5 * k / len(idx), zorder=6).update(x[i], th[i])
    ax.plot(bx, by, color=C["ball"], lw=1, alpha=0.9, zorder=9)
    PendulumArtist(ax, scene, plant, zorder=20).update(x[-1], th[-1])
    fig.savefig(path, facecolor=C["bg"])
    plt.close(fig)


def summary(data: dict, scene: Scene, plant: Plant, path, clear_ball, clear_string, t_plan=None,
            title=""):
    t, S, F, ten = data["t"], data["S"], data["F"], data["tension"]
    x, th = S[0], S[2]
    bx, _ = scene.ball_pos(x, th, plant.L, np)
    fig, axs = plt.subplots(5, 1, figsize=(10, 11), dpi=120, sharex=True, facecolor=C["bg"])
    fig.subplots_adjust(left=0.1, right=0.97, top=0.95, bottom=0.05, hspace=0.12)
    fig.suptitle(title, color=C["text"], fontsize=13, weight="bold")
    for a in axs:
        _style_axes(a)
        if t_plan is not None:
            a.axvline(t_plan, color=C["muted"], lw=1, ls=":")

    a = axs[0]
    for w in scene.walls:
        a.axhspan(w.x0, w.x1, color=C["brick"], alpha=0.35, lw=0)
    a.plot(t, x, color=C["trolley"], lw=1.4, label="trolley x")
    a.plot(t, bx, color=C["ball"], lw=1.4, label="ball x")
    a.set_ylabel("position [m]")
    a.legend(loc="lower right", fontsize=8, facecolor=C["panel"], labelcolor=C["text"], edgecolor=C["grid"])

    axs[1].plot(t, np.degrees(th), color=C["string"], lw=1.2)
    axs[1].set_ylabel("θ [deg]")

    axs[2].plot(t, F, color=C["force"], lw=1.2)
    pk = np.max(np.abs(F))
    axs[2].axhline(pk, color=C["force"], lw=0.8, ls="--")
    axs[2].axhline(-pk, color=C["force"], lw=0.8, ls="--")
    axs[2].set_ylabel("force [N]")

    a = axs[3]
    cb, cs = clear_ball.min(axis=0), clear_string.min(axis=0)
    a.plot(t, np.minimum(cb, 0.5), color=C["ball"], lw=1.2, label="ball ↔ wall")
    a.plot(t, np.minimum(cs, 0.5), color=C["string"], lw=1.2, label="string ↔ wall")
    a.axhline(0, color=C["bad"], lw=1)
    a.set_ylim(-0.05, 0.5)
    a.set_ylabel("clearance [m]")
    a.legend(loc="upper right", fontsize=8, facecolor=C["panel"], labelcolor=C["text"], edgecolor=C["grid"])

    axs[4].plot(t, ten, color=C["ok"], lw=1.2)
    axs[4].axhline(0, color=C["bad"], lw=1)
    axs[4].set_ylabel("string tension [N]")
    axs[4].set_xlabel("time [s]")
    fig.savefig(path, facecolor=C["bg"])
    plt.close(fig)
