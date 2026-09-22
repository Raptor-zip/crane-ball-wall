# YouTube 投稿用メモ（解説動画）

公開済み（2026-09-22）：https://youtu.be/cEGxACeO0iQ 。投稿した mp4 とサムネイルは GitHub Release [`explainer-v1`](https://github.com/Raptor-zip/crane-ball-wall/releases/tag/explainer-v1) に置いてある。

対象の動画は `explainer/remotion/out/explainer.mp4`（7:48、1920×1080）、サムネイルは `explainer/remotion/out/thumbnail.png`（1280×720）。

## タイトル案

1. 台車を押すだけでボールを壁のすき間に入れて止める｜運動方程式から軌道最適化・時変LQRまで
2. 【制御工学】紐で吊ったボールを42cmのすき間に入れるクレーンを数式から解く
3. ラグランジュ → 多重シューティング → 時変LQR：クレーンでボールをすき間に入れる

## 概要欄（そのまま貼る）

以下のブロックをそのまま貼る。段落の途中には改行を入れていない（YouTube 側で折り返される）。

```text
台車を左右に押すだけで、紐で吊ったボールを壁のすき間（42 cm）に入れて止める。ガントリークレーンの運動方程式をラグランジュの方法で立て、直接多重シューティング法（CasADi / IPOPT）で軌道を最適化し、時変LQRで追いかけて、高精度なシミュレーション（DOP853）で確かめるまでを解説します。

▼ コード（MIT ライセンス）
https://github.com/Raptor-zip/crane-ball-wall

▼ 元ネタ
MathWorks Blog「Simulate in MATLAB, Animate in Blender」（Ned Gulley）
https://blogs.mathworks.com/community/2026/07/31/simulate-in-matlab-animate-in-blender/
元記事は MATLAB で「壁を1枚越える」問題。この動画では MATLAB を使わずに Python で作り直し、剛体の棒ではなく紐で吊ったボールを、2枚の壁のすき間に入れて止める問題に広げています。

▼ チャプター
0:00 はじめに
0:28 問題の設定
1:02 運動方程式を立てる
2:36 紐はたるむ
3:09 軌道最適化として書く
3:39 多重シューティング法
4:22 壁とのすき間
4:44 ホモトピー法と局所解
5:23 時間反転
5:49 時変LQRで追いかける
6:26 検証
7:03 おまけ：共振で押す
7:28 まとめ

▼ 主な数値（シミュレーション、モデル誤差なし）
・台車 2 kg、ボール 1 kg、紐 1 m、壁の高さ 75 cm、すき間 42 cm
・4 秒で入れる（fast）：力の最大値 20.6 N
・12 秒かけて揺らしながら入れる（pump）：力の最大値 12.3 N
・ボールと壁の最小すき間 1.96 cm、紐の最小張力 約 1.5 N（たるまない）
・ただしモデル誤差には弱く、紐が 1.8 % 長いだけで壁に当たる（1000 回のモンテカルロで成功率 91 %）

▼ 使ったもの
Python（NumPy / SciPy / CasADi / IPOPT）、Manim（数式アニメーション）、Remotion（動画の組み立て）

▼ 音声
VOICEVOX:ずんだもん

#制御工学 #軌道最適化 #Python
```

## タグ

```text
制御工学, 軌道最適化, 最適制御, LQR, 時変LQR, 多重シューティング法, ラグランジュ方程式, 運動方程式, クレーン, ガントリークレーン, 振り子, CasADi, IPOPT, Python, Manim, シミュレーション, ずんだもん, VOICEVOX
```

## 投稿前のチェック

- [ ] 説明文に `VOICEVOX:ずんだもん` が入っている（VOICEVOX とずんだもんの利用規約で必須のクレジット）
- [ ] チャプターの時刻が最新の書き出しと合っている。台本を直して作り直したら `uv run python explainer/describe.py` で時刻を出し直し、上のブロックの「▼ チャプター」を差し替える（`explainer/build.sh` は `explainer/remotion/out/description.txt` にも書き出す）
- [ ] チャプターの条件：最初が `0:00`、3 つ以上、各 10 秒以上（今は最短 22 秒）
- [ ] 概要欄の数値が `out/<mission>/<preset>/report.json` と README の表に一致している
- [ ] サムネイルを `thumbnail.png` に差し替えた
- [ ] 言語：日本語、字幕は動画に焼き込み済み（自動字幕はオフでもよい）
- [ ] 元記事の画像や映像は使っていない（シーンは自作。寸法だけ元動画の比率から決めた）
