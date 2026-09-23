"""Figures for the development-process report (agents.tsv comes from the session transcripts)."""
import ast
import csv
import datetime as dt
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.dates as mdates
import matplotlib.pyplot as plt
from matplotlib import font_manager

HERE = Path(__file__).parent
for f in font_manager.findSystemFonts():
    if "NotoSansCJK-Regular" in f:
        font_manager.fontManager.addfont(f)
plt.rcParams["font.family"] = ["Noto Sans CJK JP", "DejaVu Sans"]
plt.rcParams["font.size"] = 8

JST = dt.timedelta(hours=9)
WF = [
    ("design(killed)", "設計（中止）", "#bbbbbb"),
    ("design", "① 設計", "#4c78a8"),
    ("foundation", "② 土台", "#72b7b2"),
    ("modules", "③ モジュール実装", "#f58518"),
    ("integrate", "④ 統合・磨き込み", "#54a24b"),
    ("balance-review", "⑤ バランス・総点検", "#e45756"),
    ("casadi", "⑥ CasADi WASM 検証", "#b279a2"),
]
rows = list(csv.DictReader(open(HERE / "agents.tsv"), delimiter="\t"))
for r in rows:
    r["t0"] = dt.datetime.strptime("2026-" + r["start"], "%Y-%m-%dT%H:%M") + JST
    r["t1"] = r["t0"] + dt.timedelta(minutes=float(r["min"]))
    r["mix"] = ast.literal_eval(r["toolmix"])

# ---- Fig 1: agent Gantt chart -------------------------------------------------
fig, ax = plt.subplots(figsize=(7.2, 7.6))
y = 0
yt, yl = [], []
for key, name, col in WF:
    rs = sorted([r for r in rows if r["wf"] == key], key=lambda r: (r["t0"], r["label"]))
    for r in rs:
        ax.barh(y, (r["t1"] - r["t0"]).total_seconds() / 86400, left=mdates.date2num(r["t0"]),
                height=0.75, color=col, edgecolor="none")
        yt.append(y)
        yl.append(r["label"])
        y += 1
    y += 0.8
human = [
    ("2026-09-22 13:47", "最初の依頼"),
    ("2026-09-22 13:56", "Cloudflare/D1 指定"),
    ("2026-09-22 17:52", "起動方法の質問"),
    ("2026-09-23 02:07", "CasADi WASM の示唆"),
    ("2026-09-23 02:22", "Opus 5.5 へ切替依頼"),
]
for i, (t, lab) in enumerate(human):
    x = mdates.date2num(dt.datetime.strptime(t, "%Y-%m-%d %H:%M"))
    ax.axvline(x, color="k", lw=0.6, ls=":")
    ha = "right" if i in (0, 3) else "left"
    ax.text(x + (-0.004 if ha == "right" else 0.004), -3.3 + 1.4 * (i % 2), f"U{i + 1} {lab}",
            ha=ha, va="center", fontsize=6.5)
ax.set_yticks(yt)
ax.set_yticklabels(yl, fontsize=5.6)
ax.invert_yaxis()
ax.set_ylim(y, -4.5)
ax.xaxis.set_major_formatter(mdates.DateFormatter("%H:%M"))
ax.xaxis.set_major_locator(mdates.HourLocator(interval=1))
ax.set_xlabel("時刻（JST，2026-09-22 13:47 〜 09-23 04:12）")
ax.grid(axis="x", lw=0.3, alpha=0.5)
handles = [plt.Rectangle((0, 0), 1, 1, color=c) for _, _, c in WF]
ax.legend(handles, [n for _, n, _ in WF], loc="lower left", fontsize=6.5, frameon=True)
fig.tight_layout()
fig.savefig(HERE / "figs" / "gantt.pdf")

# ---- Fig 2: tool mix per workflow -----------------------------------------------
cats = [("Bash", "#4c78a8"), ("Read", "#72b7b2"), ("Edit/Write", "#f58518"), ("その他", "#bab0ac")]
fig, ax = plt.subplots(figsize=(7.2, 2.3))
names = []
for i, (key, name, _) in enumerate(WF[1:]):
    tot = {c: 0 for c, _ in cats}
    for r in rows:
        if r["wf"] != key:
            continue
        for k, v in r["mix"].items():
            c = k if k in ("Bash", "Read") else "Edit/Write" if k in ("Edit", "Write") else "その他"
            tot[c] += v
        tot["その他"] += int(r["tools"]) - sum(r["mix"].values())
    left = 0
    for c, col in cats:
        ax.barh(i, tot[c], left=left, color=col, height=0.7)
        left += tot[c]
    ax.text(left + 15, i, f"{left}", va="center", fontsize=7)
    names.append(name)
ax.set_yticks(range(len(names)))
ax.set_yticklabels(names)
ax.invert_yaxis()
ax.set_xlabel("サブエージェントのツール呼び出し回数")
ax.legend([plt.Rectangle((0, 0), 1, 1, color=c) for _, c in cats], [c for c, _ in cats],
          fontsize=7, loc="lower right", ncol=4)
ax.set_xlim(0, 2700)
fig.tight_layout()
fig.savefig(HERE / "figs" / "toolmix.pdf")
print("ok")

# ---- Fig 1b: compact Gantt for the 2-column X version ----------------------------
fig, ax = plt.subplots(figsize=(7.2, 2.9))
y = 0
for key, name, col in WF:
    rs = sorted([r for r in rows if r["wf"] == key], key=lambda r: (r["t0"], r["label"]))
    y0 = y
    for r in rs:
        ax.barh(y, (r["t1"] - r["t0"]).total_seconds() / 86400, left=mdates.date2num(r["t0"]),
                height=0.8, color=col, edgecolor="none")
        y += 1
    x0 = min(mdates.date2num(r["t0"]) for r in rs)
    ax.text(x0 - 0.004, (y0 + y - 1) / 2, f"{name}（{len(rs)}体）", ha="right", va="center", fontsize=6.5)
    y += 1.5
for i, (t, lab) in enumerate(human):
    x = mdates.date2num(dt.datetime.strptime(t, "%Y-%m-%d %H:%M"))
    ax.axvline(x, color="k", lw=0.6, ls=":")
    ha = "right" if i in (0, 3) else "left"
    ax.text(x + (-0.003 if ha == "right" else 0.003), -7.4 + 2.2 * (i % 2), f"U{i + 1} {lab}",
            ha=ha, va="center", fontsize=6)
ax.set_yticks([])
ax.invert_yaxis()
ax.set_ylim(y, -8.8)
ax.set_xlim(mdates.date2num(dt.datetime(2026, 9, 22, 11, 20)), mdates.date2num(dt.datetime(2026, 9, 23, 4, 20)))
ax.xaxis.set_major_formatter(mdates.DateFormatter("%H:%M"))
ax.xaxis.set_major_locator(mdates.HourLocator(interval=1))
ax.tick_params(axis="x", labelsize=6.5)
ax.set_xlabel("時刻（JST，2026-09-22 13:47 〜 09-23 04:12）", fontsize=7)
ax.grid(axis="x", lw=0.3, alpha=0.5)
for s in ("left", "right", "top"):
    ax.spines[s].set_visible(False)
fig.tight_layout()
fig.savefig(HERE / "figs" / "gantt_compact.pdf")
print("ok compact")
