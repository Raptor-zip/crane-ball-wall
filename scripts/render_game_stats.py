"""Render README charts from the saved aggregate D1 snapshot.

Refresh: node game/tools/readme-stats.mjs && uv run python scripts/render_game_stats.py
Render only: uv run python scripts/render_game_stats.py
"""
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.dates as mdates
from matplotlib import font_manager
import matplotlib.pyplot as plt
from matplotlib.ticker import StrMethodFormatter

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs/stats"
data = json.loads((OUT / "snapshot.json").read_text())
sampled = datetime.fromisoformat(data["sampled_at_utc"].replace("Z", "+00:00"))
sampled = sampled.astimezone(timezone(timedelta(hours=9)))
stamp = sampled.strftime("%Y-%m-%d %H:%M JST")
rows = {r["date_jst"]: r for r in data["daily"]}
start = datetime.fromisoformat(min(rows))
dates = [start + timedelta(days=i) for i in range((sampled.date() - start.date()).days + 1)]
series = lambda key: [rows.get(d.strftime("%Y-%m-%d"), {}).get(key, 0) for d in dates]
new_users = series("new_users")
levels, dailies = series("level_clears"), series("daily_entries")
assert sum(new_users) == data["totals"]["users"]
assert sum(levels) + sum(dailies) == data["totals"]["recorded_plays"]

font = Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc")
if font.exists():
    font_manager.fontManager.addfont(str(font))
    plt.rcParams["font.family"] = "Noto Sans CJK JP"
plt.rcParams.update({"font.size": 11, "axes.spines.top": False, "axes.spines.right": False})

for kind, title, counts, total, unit in [
    ("users", "利用者数の推移", new_users, data["totals"]["users"], "ブラウザ"),
    ("plays", "記録されたプレイ数の推移", [a + b for a, b in zip(levels, dailies)],
     data["totals"]["recorded_plays"], "件"),
]:
    fig, (ax, bx) = plt.subplots(2, 1, figsize=(11, 6), sharex=True,
                               gridspec_kw={"height_ratios": [1.6, 1]}, layout="constrained")
    fig.suptitle(f"ゆらしてピタッ ｜ {title}   {total:,} {unit}", fontsize=19)
    cumulative = []
    for n in counts:
        cumulative.append(n + (cumulative[-1] if cumulative else 0))
    ax.plot(dates, cumulative, color="#13866b", marker="o", markersize=4)
    ax.fill_between(dates, cumulative, alpha=.12, color="#13866b")
    ax.set_ylabel(f"累計（{unit}）")
    ax.set_ylim(bottom=0)
    if kind == "users":
        bx.bar(dates, counts, color="#13866b", width=.75, label="初めて記録されたブラウザ")
    else:
        bx.bar(dates, levels, color="#13866b", width=.75, label="面ごとの初回クリア")
        bx.bar(dates, dailies, bottom=levels, color="#ea7953", width=.75, label="今日の5球への参加")
    bx.set_ylabel(f"日別（{unit}）")
    bx.legend(loc="upper right", fontsize=10)
    for axis in (ax, bx):
        axis.grid(axis="y", alpha=.2)
        axis.set_axisbelow(True)
        axis.yaxis.set_major_formatter(StrMethodFormatter("{x:,.0f}"))
    bx.xaxis.set_major_locator(mdates.DayLocator(interval=max(1, len(dates) // 9)))
    bx.xaxis.set_major_formatter(mdates.DateFormatter("%m/%d"))
    bx.set_xlabel(f"日本時間・サーバー初記録日 ｜ {stamp} 集計（最終日は途中）")
    fig.savefig(OUT / f"{kind}.png", dpi=160)
    plt.close(fig)

t = data["totals"]
section = f"""<!-- game-stats:start -->
## ゲームの利用状況

**累計利用者数：{t['users']:,} ブラウザ**（{stamp} 時点）。本番 D1 の記録から集計したスナップショット。

| 指標 | 累計 |
|---|---:|
| 利用者数（記録のあるブラウザ数） | {t['users']:,} |
| 記録されたプレイ数 | {t['recorded_plays']:,} 件 |
| 内訳：面ごとの初回クリア | {t['level_clears']:,} 件 |
| 内訳：今日の5球への参加 | {t['daily_entries']:,} 件 |

![利用者数グラフ：累計と日別の新規ブラウザ数](docs/stats/users.png)

![プレイ数グラフ：累計と日別の初回クリア・日替わり参加件数](docs/stats/plays.png)

- **利用者数**：通常面のクリアまたは「今日の5球」への参加がサーバーに記録されたブラウザIDの重複なし件数。同じ人が複数の端末・ブラウザを使うと別に数える。訪問しただけの人は含まない。
- **プレイ数**：ブラウザ × 面（ボード）ごとの初回クリアと、ブラウザ × 日替わりボードごとの参加を各1件として数える。全試行数は保存していないため、リトライ・同じ面の再クリア回数は含まない。日替わりは失敗した参加も含む。
- `plays` と `runs` を `(board, pidh)` で重複排除して集計。横軸はサーバーに残る最初の記録日（JST）で、実際に遊んだ日とずれる場合がある。`plays` の記録開始（2026-09-23 20:44 JST）より前は不完全で、未送信のオフラインプレイ・アシスト・練習なども含まないため下限値。最終日は集計時刻まで。

集計データ：[docs/stats/snapshot.json](docs/stats/snapshot.json)。手動更新（Wrangler の本番 D1 読み取り権限が必要）：

```bash
node game/tools/readme-stats.mjs
uv run python scripts/render_game_stats.py
```

画像だけ作り直す場合は2行目のみ実行する。自動更新は行わない。
<!-- game-stats:end -->"""
readme = ROOT / "README.md"
text = readme.read_text()
begin, end = "<!-- game-stats:start -->", "<!-- game-stats:end -->"
if begin in text:
    a, b = text.index(begin), text.index(end) + len(end)
    text = text[:a] + section + text[b:]
else:
    text = text.replace("## ここにあるもの", section + "\n\n## ここにあるもの", 1)
readme.write_text(text)
print(f"README statistics updated: {stamp}, {t['users']:,} browsers, {t['recorded_plays']:,} recorded plays")
