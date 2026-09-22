"""YouTube description with chapter timestamps, from the same timeline Remotion uses.

Run: uv run python explainer/describe.py > explainer/remotion/out/description.txt
"""

import json
import math
from pathlib import Path

FPS = 30
tl = json.loads((Path(__file__).parent / "remotion" / "public" / "timeline.json").read_text())

chapters, t = [], 0
for s in tl:
    if not chapters or chapters[-1][1] != s["chapter"]:
        chapters.append((t / FPS, s["chapter"]))
    t += math.ceil(s["duration"] * FPS)  # same frame rounding as Explainer.tsx

print("""台車を左右に押すだけで、紐で吊ったボールを壁のすき間（42 cm）に入れて止める。ガントリークレーンの運動方程式をラグランジュの方法で立て、直接多重シューティング法（CasADi / IPOPT）で軌道を最適化し、時変LQRで追いかけて、高精度なシミュレーション（DOP853）で確かめるまでを解説します。

コード（MIT）：https://github.com/Raptor-zip/crane-ball-wall
元ネタ：MathWorks Blog「Simulate in MATLAB, Animate in Blender」（Ned Gulley）
https://blogs.mathworks.com/community/2026/07/31/simulate-in-matlab-animate-in-blender/
""")
for sec, name in chapters:
    print(f"{int(sec // 60)}:{int(sec % 60):02d} {name}")
print("""
使ったもの：Python（NumPy / SciPy / CasADi）、Manim、Remotion
音声：VOICEVOX:ずんだもん""")
