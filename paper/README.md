# paper：論文

| ディレクトリ | 内容 | 組版済み |
|---|---|---|
| [research/](research/) | 研究：吊り下げボールを壁のすき間に出し入れするクレーン（軌道最適化・時変 LQR・独立検証） | [本文 12 ページ](../docs/paper.pdf)、[2 段組の要約 2 ページ](../docs/paper_summary.pdf) |
| [game_dev/](game_dev/) | 開発記録：Claude Code の ultracode モードでゲーム「ゆらしてピタッ」を作った過程 | [本文 14 ページ](../docs/game_dev_paper.pdf)、[X 用の 2 段組 3 ページ](../docs/game_dev_summary.pdf)（[画像](../docs/media/game_dev_summary-1.png)） |

どちらも LuaLaTeX（`ltjsarticle`、LuaTeX-ja）で組む。図の文字には Noto Sans CJK JP を使う。

## research/

図の元データは研究コードの出力（`out/`）なので、先に [ballwall/README.md](../ballwall/README.md) の 4 つのプリセットと
頑健性の評価を走らせる。そのうえで、リポジトリのルートで次を実行すると、図・PDF・README 用の画像と動画を作り直して `docs/` に置く。

```bash
./scripts/build_docs.sh
```

## game_dev/

資料は Claude Code のセッション記録（会話ログ、ワークフローの台本、サブエージェントの実行ログ）で、
そこから集計した値を `agents.tsv`（サブエージェントごとの時刻・ツール呼び出し数）と
`reception_cloudflare.json`（公開日の Cloudflare の分析値）に残してある。
`figs/shot_*.png` は宣伝動画の録画から切り出したゲーム画面。

```bash
uv run python paper/game_dev/make_figs.py        # figs/gantt.pdf, gantt_compact.pdf, toolmix.pdf
cd paper/game_dev
lualatex main.tex && lualatex main.tex            # 本文
lualatex x_summary.tex && lualatex x_summary.tex  # X 用の 2 段組
cp main.pdf ../../docs/game_dev_paper.pdf && cp x_summary.pdf ../../docs/game_dev_summary.pdf
pdftoppm -r 200 -png x_summary.pdf ../../docs/media/game_dev_summary
```
