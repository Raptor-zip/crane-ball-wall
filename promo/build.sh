#!/usr/bin/env bash
# X promo of 「ゆらしてピタッ」 (9:16, ~28 s): gameplay capture -> ずんだもん narration -> Remotion -> loudness-normalised mp4.
# Needs VOICEVOX ENGINE at 127.0.0.1:50021 (see tts.py) and ffmpeg. Captures from a local game server, never the live site.
set -euo pipefail
cd "$(dirname "$0")/.."

(cd game && npx vite --port 5311 --strictPort >/dev/null 2>&1 &)
until curl -s -o /dev/null localhost:5311/; do sleep 0.5; done
node promo/capture/capture.mjs
fuser -k 5311/tcp >/dev/null 2>&1 || true

uv run python promo/tts.py

cd promo/remotion
[ -d node_modules ] || npm ci
mkdir -p out
npx remotion render src/index.ts Promo out/promo-raw.mp4 --codec=h264 --crf=18 --pixel-format=yuv420p --concurrency=50%
ffmpeg -v error -y -i out/promo-raw.mp4 -c:v copy -af "loudnorm=I=-14:TP=-1.5:LRA=11" -ar 48000 -c:a aac -b:a 192k \
  -movflags +faststart out/yurapita-promo.mp4
echo "-> promo/remotion/out/yurapita-promo.mp4"
