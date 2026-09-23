# explainer：解説動画（YouTube、7:48）

運動方程式の立式から、軌道最適化・時変 LQR・検証までを解説する動画を作る。
数式とアニメーションは Manim、ナレーション（VOICEVOX：ずんだもん）・字幕・チャプターの組み立ては Remotion。

- 公開版：https://youtu.be/cEGxACeO0iQ
- 書き出した mp4 とサムネイル：GitHub Release [`explainer-v1`](https://github.com/Raptor-zip/crane-ball-wall/releases/tag/explainer-v1)
- タイトル案・概要欄など投稿用のメモ：[YOUTUBE.md](YOUTUBE.md)

## 作り方

リポジトリのルートで実行する。先に研究コードの 4 つのプリセット（[ballwall/README.md](../ballwall/README.md)）を走らせて `out/` を作っておく。

```bash
docker run --rm -d --name voicevox_engine -p 127.0.0.1:50021:50021 voicevox/voicevox_engine:cpu-latest
uv sync --group explainer
./explainer/build.sh        # → explainer/remotion/out/explainer.mp4, thumbnail.png, description.txt
```

## ファイル

| ファイル | 役割 |
|---|---|
| `script.py` | 台本（字幕と読みの対応）。尺・字幕・チャプターの唯一の出典 |
| `tts.py` | ナレーションを合成し、実測の長さから `timeline.json` を書く |
| `prep.py` | 図に使うデータを実際のプランナー・シミュレーターから作る |
| `manim/scenes.py` | 15 シーン。`timeline.json` の各行の開始時刻にアニメーションを合わせる |
| `render.py` / `describe.py` | Manim の書き出しと、概要欄（チャプター）の生成 |
| `remotion/` | クリップ・音声・字幕・チャプター表示・進捗バーの合成とサムネイル |
| `build.sh` | 上をすべて順に実行する |

音声・データ・クリップ・書き出しはすべて `build.sh` で作り直せるので、リポジトリには入れていない（ルートの `.gitignore`）。
