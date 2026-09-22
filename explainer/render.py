"""Render every Manim scene at 1920x1080/30 fps into remotion/public/manim/<id>.mp4.

Run: uv run python explainer/render.py [-ql] [S03Lagrange ...]
"""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCENES = HERE / "manim" / "scenes.py"
DEST = HERE / "remotion" / "public" / "manim"
MEDIA = HERE / "manim" / "media"


def classes() -> list[tuple[str, str]]:
    src = SCENES.read_text()
    return re.findall(r"^class (\w+)\(NarratedScene\):\n    sid = \"(\w+)\"", src, re.M)


def main():
    args = sys.argv[1:]
    low = "-ql" in args
    wanted = [a for a in args if not a.startswith("-")]
    DEST.mkdir(parents=True, exist_ok=True)
    failed = []
    for cls, sid in classes():
        if wanted and cls not in wanted and sid not in wanted:
            continue
        q = ["-ql"] if low else ["--resolution", "1920,1080", "--frame_rate", "30"]
        cmd = [sys.executable, "-m", "manim", *q, "--media_dir", str(MEDIA), "--disable_caching",
               "-o", sid, str(SCENES), cls]
        print("+", " ".join(cmd[2:]), flush=True)
        if subprocess.run(cmd, cwd=HERE).returncode:
            failed.append(cls)
            continue
        out = next(MEDIA.glob(f"videos/scenes/*/{sid}.mp4"), None) if low else \
            MEDIA / "videos" / "scenes" / "1080p30" / f"{sid}.mp4"
        if not low:
            shutil.copy(out, DEST / f"{sid}.mp4")
    if failed:
        sys.exit(f"failed: {' '.join(failed)}")


if __name__ == "__main__":
    main()
