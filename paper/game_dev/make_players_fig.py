"""Player time series after launch (players_timeseries.json: Cloudflare GraphQL + production D1, read-only)."""
import datetime as dt
import json
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
D = json.load(open(HERE / "players_timeseries.json"))
END = dt.datetime(2026, 9, 25, 17)  # last complete JST hour is 16:00-17:00


def utc_series(m):
    xs = sorted((dt.datetime.strptime(k, "%Y-%m-%dT%H:%M:%SZ") + JST, v) for k, v in m.items())
    return [(t, v) for t, v in xs if t < END]


def jst_series(rows, key):
    xs = [(dt.datetime.strptime(r["h"], "%Y-%m-%d %H"), r[key]) for r in rows]
    return [(t, v) for t, v in xs if t < END]


def hours(series, start, end):
    m = dict(series)
    t, out = start, []
    while t < end:
        out.append((t, m.get(t, 0)))
        t += dt.timedelta(hours=1)
    return out


START = dt.datetime(2026, 9, 23, 11)
inv = hours(utc_series(D["inv"]), START, END)
act = hours(jst_series(D["d1_hourly"], "d"), START, END)
new = hours(jst_series(D["d1_new"], "new"), START, END)

fig, (a1, a2) = plt.subplots(2, 1, figsize=(7.2, 4.6), sharex=True)
a1.bar([t + dt.timedelta(minutes=30) for t, _ in inv], [v for _, v in inv], width=1 / 24 * 0.9, color="#4c78a8")
a1.set_ylabel("API 要求 [件/時]")
a1.set_title("(a) Worker の実行回数（Cloudflare 分析 API）", loc="left", fontsize=8)

a2.bar([t + dt.timedelta(minutes=30) for t, _ in act], [v for _, v in act], width=1 / 24 * 0.9, color="#f58518", label="その時間にクリアを記録した端末")
a2.plot([t + dt.timedelta(minutes=30) for t, _ in new], [v for _, v in new], color="#54a24b", lw=1.2, label="うち初めての端末")
a2.set_ylabel("端末数 [台/時]")
a2.set_title("(b) クリアの記録が届いた端末（本番 D1 の plays 表）", loc="left", fontsize=8)
cum, s = [], 0
for t, v in new:
    s += v
    cum.append((t + dt.timedelta(hours=1), s))
a3 = a2.twinx()
a3.plot([t for t, _ in cum], [v for _, v in cum], color="#333333", lw=1, ls="--", label="初めての端末の累計（右軸）")
a3.set_ylabel("累計 [台]")
a3.set_ylim(0, s * 1.1)
h1, l1 = a2.get_legend_handles_labels()
h2, l2 = a3.get_legend_handles_labels()
a2.legend(h1 + h2, l1 + l2, loc="center right", fontsize=6.5, framealpha=0.95)

for ax in (a1, a2):
    ax.axvline(dt.datetime(2026, 9, 23, 11, 59), color="k", lw=0.8, ls=":")
    ax.axvline(dt.datetime(2026, 9, 23, 20, 44), color="gray", lw=0.8, ls=":")
    for d in (24, 25):
        ax.axvline(dt.datetime(2026, 9, d), color="#cccccc", lw=0.6)
a1.text(dt.datetime(2026, 9, 23, 12, 10), a1.get_ylim()[1] * 0.9, "公開 11:59", fontsize=6.5)
a2.text(dt.datetime(2026, 9, 23, 20, 55), a2.get_ylim()[1] * 0.9, "plays 表の追加 20:44（以前は下限）", fontsize=6.5, color="gray", bbox=dict(fc="white", ec="none", pad=1))
a2.xaxis.set_major_locator(mdates.HourLocator(byhour=[0, 6, 12, 18]))
a2.xaxis.set_major_formatter(mdates.DateFormatter("%m/%d\n%H時"))
a2.set_xlim(START, END)
fig.tight_layout()
fig.savefig(HERE / "figs" / "players.pdf")

tot = lambda xs: sum(v for _, v in xs)
peak = max(inv, key=lambda x: x[1])
print("peak inv", peak, "last 6h inv", tot(inv[-6:]), "new total", s, "active peak", max(act, key=lambda x: x[1]))
for d in (23, 24, 25):
    day = [x for x in act if x[0].day == d]
    print(d, "inv", tot([x for x in inv if x[0].day == d]), "new", tot([x for x in new if x[0].day == d]))
print("last 12h new per hour", [v for _, v in new[-12:]])
print("last 12h inv per hour", [v for _, v in inv[-12:]])
print("same hours 24th vs 25th inv", [ (t.hour,v) for t,v in inv if t.day==24 and t.hour<17], )
