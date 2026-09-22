#!/usr/bin/env bash
# Rebuild everything shown in docs/ (README media and the two PDFs) from the
# simulation results in out/.  Run the four `python -m ballwall` presets and
# the robustness scripts first (see README).
set -euo pipefail
cd "$(dirname "$0")/.."

uv run python paper/make_figs.py
for doc in main x_summary; do
  (cd paper && lualatex -interaction=nonstopmode "$doc.tex" >/dev/null && lualatex -interaction=nonstopmode "$doc.tex" >/dev/null)
done
uv run python -m ballwall.video
uv run python -m ballwall.video --mission escape --still 3.9

mkdir -p docs/media
cp paper/main.pdf docs/paper.pdf
cp paper/x_summary.pdf docs/paper_summary.pdf
cp out/video/enter.mp4 out/video/escape.mp4 docs/media/
cp out/video/escape_t3.9.png docs/media/escape_frame.png
pdftoppm -png -r 160 -singlefile paper/figs/strobes.pdf docs/media/strobes
pdftoppm -png -r 160 -singlefile paper/figs/local_optima_compact.pdf docs/media/local_optima
echo "docs/ updated"
