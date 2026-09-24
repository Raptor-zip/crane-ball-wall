# promo：ゲームの宣伝素材（X 投稿用）

[ゆらしてピタッ](../game/) を X で紹介するための動画と画像。

| もの | 場所 | 作り方 |
|---|---|---|
| 宣伝動画（縦 1080×1920、27.6 秒、ずんだもんのナレーション付き） | GitHub Release [`promo-v1`](https://github.com/Raptor-zip/crane-ball-wall/releases/tag/promo-v1) | `./promo/build.sh` |
| プレイ人口のありがとうカード（3200×1800、16:9） | [thanks/thanks1000.png](thanks/thanks1000.png)、[thanks/thanks2000.png](thanks/thanks2000.png)、[thanks/thanks4000.png](thanks/thanks4000.png) | `node promo/thanks/render.mjs 3000` |

## 宣伝動画（`build.sh`）

リポジトリのルートで `./promo/build.sh` を実行すると、次を順に行う。VOICEVOX ENGINE（127.0.0.1:50021）と ffmpeg が要る。

1. `capture/`：手元でゲームの開発サーバーを立て、Playwright で本物のタッチ操作を録画する（公開中のサイトからは撮らない）。
   指の動かし方は、クリアできるものを事前にシミュレーターで探してある。
2. `tts.py`：台本からナレーションを合成し、音声の実測の長さから各場面の尺を決める（`remotion/public/timeline.json`）。
3. `remotion/`：録画・音声・字幕・見出しを合成して書き出し、音量を揃える → `remotion/out/yurapita-promo.mp4`

録画・音声・書き出しは作り直せるので、リポジトリには入れていない（[.gitignore](.gitignore)）。

## ありがとうカード（`thanks/`）

`thanks.html` が 1 枚のテンプレートで、`?k=2` のように千の位を渡すと「2,000人」になる。
「000」はクレーンから吊った赤いボール 3 つで表している。`render.mjs` はゲームの Playwright を使って PNG に書き出す
（引数は 1000〜9000 の千の倍数）。完成した PNG は投稿用の成果物なので追跡している。
