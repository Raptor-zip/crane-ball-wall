#!/usr/bin/env bash
# Explainer video: data -> narration -> Manim clips -> Remotion -> loudness-normalised mp4.
# Needs the four default runs in out/ and VOICEVOX ENGINE at 127.0.0.1:50021 (see tts.py).
set -euo pipefail
cd "$(dirname "$0")/.."

uv run python explainer/prep.py
uv run python explainer/tts.py
uv run python explainer/render.py
uv run python explainer/describe.py > explainer/remotion/out/description.txt 2>/dev/null || true

cd explainer/remotion
mkdir -p out
[ -d node_modules ] || npm ci
ffmpeg -v error -y -ss 14.2 -i public/manim/s01_intro.mp4 -frames:v 1 \
  -vf "crop=1920:760:0:250,pad=1920:1080:0:320:color=#101318" public/thumb_bg.png
npx remotion render src/index.ts Explainer out/explainer-raw.mp4 \
  --codec=h264 --crf=18 --pixel-format=yuv420p --concurrency=50%
npx remotion still src/index.ts Thumbnail out/thumbnail.png
ffmpeg -v error -y -i out/explainer-raw.mp4 -c:v copy \
  -af "loudnorm=I=-14:TP=-1.5:LRA=11" -ar 48000 -c:a aac -b:a 192k out/explainer.mp4
echo "-> explainer/remotion/out/explainer.mp4"
