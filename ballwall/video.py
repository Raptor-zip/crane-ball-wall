"""Split-screen videos for posting: one per mission, fast on top, pump below.

Both halves run on the same clock (fast finishes and rests while pump is
still pumping), so the difference in force and duration is visible at once.
Reads the frame data written by `python -m ballwall` (trajectory.json and
report.json under out/<mission>/<preset>/), so nothing is re-simulated.

    uv run python -m ballwall.video                  # out/video/{enter,escape}.mp4
    uv run python -m ballwall.video --mission escape
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import matplotlib.colors as mcolors
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.animation import FFMpegWriter, FuncAnimation
from matplotlib.collections import LineCollection
from matplotlib.patches import FancyBboxPatch

from .params import Plant, Scene, Wall
from .viz import C, TROLLEY_H, PendulumArtist, draw_static

PRESETS = ("fast", "pump")
TITLE = {
    "enter": "ボールを壁のすき間に入れて止める",
    "escape": "すき間で止まったボールを外に出して止める",
}
SUBTITLE = ("クレーンの台車（青）を左右に押して、ひもで吊ったボール（赤）を運ぶ ｜ "
            "Python でシミュレーション（軌道最適化 + 時変 LQR）")
TAG = {"fast": "fast", "pump": "pump"}
DESC = {"fast": "短い時間で一気に振る", "pump": "揺れに合わせて小さく押す（共振）"}
ACCENT = {"fast": "#ea580c", "pump": "#7c3aed"}
DONE = {"enter": "すき間で静止", "escape": "外に出て静止"}
XLIM = (-1.45, 2.25)


def load(out: Path, mission: str, preset: str) -> dict:
    d = out / mission / preset
    tr = json.loads((d / "trajectory.json").read_text())
    rep = json.loads((d / "report.json").read_text())
    sc = tr["scene"]
    scene = Scene(rail_y=sc["rail_y"], ball_r=sc["ball_r"], walls=tuple(Wall(**w) for w in sc["walls"]),
                  x_start=sc["x_start"], x_goal=sc["x_goal"], x_min=sc["x_min"], x_max=sc["x_max"])
    return {"t": np.array(tr["t"]), "x": np.array(tr["x"]), "th": np.array(tr["theta"]), "F": np.array(tr["F"]),
            "fps": tr["fps"], "scene": scene, "plant": Plant(**tr["plant"]), "T": float(tr["meta"]["t_plan"]),
            "peak": rep["peak_force_N"]}


def render(mission: str, out: Path, path: Path, size=(1920, 1080), dpi=100, still: float | None = None):
    """Write the video to `path`; with `still` (seconds) write only that frame as an image."""
    runs = {p: load(out, mission, p) for p in PRESETS}
    fps = runs["fast"]["fps"]
    n_frames = max(len(r["t"]) for r in runs.values())
    t_end = (n_frames - 1) / fps
    f_lim = 1.12 * max(np.abs(r["F"]).max() for r in runs.values())  # one force scale for both rows

    fig = plt.figure(figsize=(size[0] / dpi, size[1] / dpi), dpi=dpi, facecolor=C["bg"])
    fig.text(0.025, 0.955, TITLE[mission], fontsize=34, weight="bold", color=C["text"], va="center")
    fig.text(0.025, 0.905, SUBTITLE, fontsize=16, color=C["muted"], va="center")

    rows = []
    row_h, top0 = 0.415, 0.865
    for k, preset in enumerate(PRESETS):
        r = runs[preset]
        top = top0 - k * (row_h + 0.02)
        if k:
            fig.add_artist(plt.Line2D([0.02, 0.98], [top + 0.012, top + 0.012], color=C["grid"], lw=1.5))

        ax = fig.add_axes([0.012, top - row_h, 0.6, row_h])
        draw_static(ax, r["scene"], XLIM)
        ax.set_ylim(-0.08, r["scene"].rail_y + 0.25)
        ax.set_anchor("W")
        trail = LineCollection([], linewidths=3, zorder=8)
        ax.add_collection(trail)
        pend = PendulumArtist(ax, r["scene"], r["plant"])
        pend.string.set_linewidth(2.6)
        arrow = ax.annotate("", xy=(0, 0), xytext=(0, 0), zorder=12,
                            arrowprops=dict(arrowstyle="-|>", color=ACCENT[preset], lw=3.5, mutation_scale=22,
                                            shrinkA=0, shrinkB=0))

        # right column: what this row is, live numbers, force history
        info = fig.add_axes([0.635, top - 0.19, 0.345, 0.19])
        info.set_axis_off()
        info.set_xlim(0, 1)
        info.set_ylim(0, 1)
        info.add_patch(FancyBboxPatch((0.0, 0.70), 0.15, 0.25, boxstyle="round,pad=0.0,rounding_size=0.06",
                                      color=ACCENT[preset], transform=info.transAxes, clip_on=False))
        info.text(0.075, 0.825, TAG[preset], color="white", fontsize=22, weight="bold", ha="center", va="center")
        info.text(0.18, 0.825, DESC[preset], color=C["text"], fontsize=21, weight="bold", va="center")
        info.text(0.0, 0.50, f"{r['T']:g} 秒の計画    最大の力 {r['peak']:.1f} N", color=C["muted"],
                  fontsize=17, va="center")
        live_t = info.text(0.0, 0.18, "", color=C["text"], fontsize=19, va="center")
        live_f = info.text(0.52, 0.18, "", color=ACCENT[preset], fontsize=19, va="center")
        status = info.text(1.0, 0.50, "", fontsize=18, weight="bold", ha="right", va="center")

        axF = fig.add_axes([0.665, top - row_h + 0.045, 0.315, row_h - 0.255])
        for sp in ("top", "right"):
            axF.spines[sp].set_visible(False)
        for sp in ("left", "bottom"):
            axF.spines[sp].set_color(C["muted"])
        axF.tick_params(colors=C["muted"], labelsize=13)
        axF.grid(color=C["grid"], lw=1)
        axF.set_xlim(0, t_end)
        axF.set_ylim(-f_lim, f_lim)
        axF.axhline(0, color=C["muted"], lw=0.8)
        axF.axvspan(r["T"], t_end, color=C["grid"], alpha=0.6, lw=0)
        axF.text(0.5 * (r["T"] + t_end), 0.82 * f_lim, "保持", color=C["muted"], fontsize=13,
                 ha="center", va="center")
        axF.set_ylabel("台車を押す力 [N]", color=C["muted"], fontsize=14)
        axF.set_xlabel("時間 [s]", color=C["muted"], fontsize=14)
        f_line, = axF.plot([], [], color=ACCENT[preset], lw=2.2)
        cursor = axF.axvline(0, color=C["text"], lw=1.4, zorder=3, clip_on=False)
        rows.append(dict(r=r, pend=pend, trail=trail, arrow=arrow, live_t=live_t, live_f=live_f,
                         status=status, f_line=f_line, cursor=cursor))

    ball_rgba = mcolors.to_rgba(C["ball"])
    n_trail = int(1.2 * fps)

    def frame(i):
        t_now = i / fps
        for row in rows:
            r = row["r"]
            j = min(i, len(r["t"]) - 1)  # a finished row rests on its last frame
            x, th, F = r["x"], r["th"], r["F"]
            row["pend"].update(x[j], th[j])
            bx, by = r["scene"].ball_pos(x[max(0, j - n_trail):j + 1], th[max(0, j - n_trail):j + 1], r["plant"].L, np)
            pts = np.column_stack([bx, by])
            if len(pts) > 1:
                segs = np.stack([pts[:-1], pts[1:]], axis=1)
                rgba = np.tile(ball_rgba, (len(segs), 1))
                rgba[:, 3] = np.linspace(0.0, 0.7, len(segs))
                row["trail"].set_segments(segs)
                row["trail"].set_colors(rgba)
            y_arrow = r["scene"].rail_y + TROLLEY_H / 2
            row["arrow"].set_position((x[j], y_arrow))
            row["arrow"].xy = (x[j] + F[j] * 0.8 / f_lim, y_arrow)
            row["arrow"].set_visible(abs(F[j]) > 0.1 * r["peak"])
            f_txt = np.round(F[j], 1) + 0.0  # never "-0.0"
            row["live_t"].set_text(f"時刻 {t_now:5.2f} s")  # one clock for both rows
            row["live_f"].set_text(f"力 {f_txt:+5.1f} N")
            if t_now < r["T"]:
                row["status"].set_text("動作中")
                row["status"].set_color(C["muted"])
            else:
                row["status"].set_text(f"{DONE[mission]}（{r['T']:g} 秒）")
                row["status"].set_color(C["ok"])
            k = j + 1
            if t_now > r["t"][-1]:  # at rest: keep drawing the (zero) force up to the cursor
                row["f_line"].set_data(np.r_[r["t"], t_now], np.r_[F, F[-1]])
            else:
                row["f_line"].set_data(r["t"][:k], F[:k])
            row["cursor"].set_xdata([t_now, t_now])

    path.parent.mkdir(parents=True, exist_ok=True)
    if still is not None:
        frame(min(int(round(still * fps)), n_frames - 1))
        fig.savefig(path, facecolor=C["bg"])
        plt.close(fig)
        return
    anim = FuncAnimation(fig, frame, frames=range(n_frames), blit=False)
    anim.save(str(path), writer=FFMpegWriter(
        fps=fps, codec="libx264",
        # H.264 High, yuv420p, faststart: the format X (Twitter) accepts for upload
        extra_args=["-pix_fmt", "yuv420p", "-profile:v", "high", "-crf", "18", "-movflags", "+faststart"]))
    plt.close(fig)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--mission", choices=("enter", "escape"), action="append",
                    help="mission(s) to render (default: both)")
    ap.add_argument("--out", default="out", help="directory holding <mission>/<preset>/ results")
    ap.add_argument("--still", type=float, help="write a single frame at this time [s] as PNG instead")
    args = ap.parse_args(argv)
    out = Path(args.out)
    for mission in args.mission or ("enter", "escape"):
        suffix = f"_t{args.still:g}.png" if args.still is not None else ".mp4"
        path = out / "video" / f"{mission}{suffix}"
        render(mission, out, path, still=args.still)
        print(f"-> {path}")


if __name__ == "__main__":
    main()
