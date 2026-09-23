"""Promo narration with VOICEVOX (ずんだもん, 1.5x) -> remotion/public/voice/*.wav + timeline.json.

Scene lengths follow the measured audio (explainer/tts.py does the same). Every claim is checked against the game:
AI ghosts = the research planner's minimum-time plans (game/tools/ai_ghosts.py, bisected), the steady assist
(GAME_DESIGN.md §3.7), medals and crowns (§7.3), phone and PC layouts (§3.3).

Needs VOICEVOX ENGINE at 127.0.0.1:50021:
    docker run --rm -d --name voicevox_engine -p 127.0.0.1:50021:50021 voicevox/voicevox_engine:cpu-latest
Run: uv run python promo/tts.py [--kana]
"""

from __future__ import annotations

import hashlib
import json
import sys
import urllib.parse
import urllib.request
import wave
from pathlib import Path

import numpy as np

HOST = "http://127.0.0.1:50021"
SPEAKER = 3  # ずんだもん（ノーマル）
SPEED = 1.5
PUBLIC = Path(__file__).parent / "remotion" / "public"
VOICE = PUBLIC / "voice"
LEAD, GAP, TAIL = 0.15, 0.12, 0.35  # short gaps (feedback: 行間短め)
TARGET_SPEECH_RMS = 0.14
PEAK_CEIL = 0.92

# (subtitle, reading); the reading is only given where VOICEVOX would misread
SCENES = [
    {"id": "hook", "min": 3.6, "lines": [("クレーンで吊るしたボールを", "クレーンでつるしたボールを"),
                             ("壁の向こうで\nピタッと止めるのだ！", "かべのむこうでピタッと止めるのだ！")]},
    {"id": "crash", "min": 2.6, "lines": [("勢いまかせだと…ゴンッ！", "いきおいまかせだと、ゴンッ！")]},
    {"id": "play", "min": 5.8, "lines": [("引いて、振って、\n壁を越えたら指を離す。", "ひいて、ふって、かべをこえたら指をはなす。"),
                             ("揺れはクレーンが\n止めてくれるのだ", "ゆれはクレーンがとめてくれるのだ")]},
    {"id": "ai", "min": 5.4, "lines": [("ライバルは最適制御のAI。", "ライバルは、さいてきせいぎょのエーアイ。"),
                           ("研究で計算した\n最短時間の動きなのだ", "けんきゅうでけいさんした、さいたんじかんのうごきなのだ")]},
    {"id": "result", "min": 3.6, "lines": [("AIとの差を縮めて、\nメダルと王冠をねらうのだ！", "エーアイとの差をちぢめて、メダルとおうかんをねらうのだ！")]},
    {"id": "cta", "min": 6.5, "lines": [("スマホでもパソコンでも、\nブラウザですぐ遊べるのだ。", "スマホでもパソコンでも、ブラウザですぐあそべるのだ。"),
                            ("ゆらしてピタッ！", "ゆらしてピタッ！")]},
]


def post(path: str, params: dict, body: bytes | None = None) -> bytes:
    req = urllib.request.Request(f"{HOST}{path}?{urllib.parse.urlencode(params)}", data=body or b"",
                                 method="POST", headers={"Content-Type": "application/json"} if body else {})
    with urllib.request.urlopen(req, timeout=180) as r:
        return r.read()


def query(text: str) -> dict:
    return json.loads(post("/audio_query", {"text": text, "speaker": SPEAKER}))


def normalize(path: Path) -> None:
    """Match the RMS of the voiced part (plain peak normalisation is fooled by pauses)."""
    with wave.open(str(path)) as w:
        params = w.getparams()
        a = np.frombuffer(w.readframes(w.getnframes()), "<i2").astype(float) / 32768
    win = max(1, int(params.framerate * 0.02))
    rms = np.sqrt((a[: len(a) // win * win].reshape(-1, win) ** 2).mean(axis=1))
    speech = rms[rms > rms.max() * 0.15]
    a *= TARGET_SPEECH_RMS / max(speech.mean(), 1e-9)
    a = np.where(np.abs(a) > PEAK_CEIL, np.sign(a) * (PEAK_CEIL + np.tanh(np.abs(a) - PEAK_CEIL) * (1 - PEAK_CEIL)), a)
    with wave.open(str(path), "wb") as w:
        w.setparams(params)
        w.writeframes((np.clip(a, -1, 1) * 32767).astype("<i2").tobytes())


def synth(reading: str, path: Path) -> None:
    q = query(reading)
    q["speedScale"] = SPEED
    q["prePhonemeLength"] = 0.03
    q["postPhonemeLength"] = 0.06
    q["outputSamplingRate"] = 48000
    path.write_bytes(post("/synthesis", {"speaker": SPEAKER}, json.dumps(q).encode()))
    normalize(path)


def duration(path: Path) -> float:
    with wave.open(str(path)) as w:
        return w.getnframes() / w.getframerate()


def main() -> None:
    if "--kana" in sys.argv:
        for sc in SCENES:
            for _, reading in sc["lines"]:
                print(f"{sc['id']}: {query(reading)['kana']}")
        return
    VOICE.mkdir(parents=True, exist_ok=True)
    keep, timeline, t0 = set(), [], 0.0
    for sc in SCENES:
        t, items = LEAD, []
        for i, (sub, reading) in enumerate(sc["lines"]):
            key = hashlib.sha1(f"{SPEAKER}|{SPEED}|{reading}".encode()).hexdigest()[:10]
            f = VOICE / f"{sc['id']}_{i:02d}_{key}.wav"
            keep.add(f.name)
            if not f.exists():
                synth(reading, f)
            d = duration(f)
            items.append({"text": sub, "file": f"voice/{f.name}", "start": round(t, 3), "end": round(t + d, 3)})
            t += d + GAP
        dur = round(max(t - GAP + TAIL, sc.get("min", 0.0)), 3)
        timeline.append({"id": sc["id"], "start": round(t0, 3), "duration": dur, "lines": items})
        print(f"{sc['id']:8s} {dur:5.2f} s  ({len(items)} lines)")
        t0 += dur
    for f in VOICE.glob("*.wav"):
        if f.name not in keep:
            f.unlink()
    (PUBLIC / "timeline.json").write_text(json.dumps(timeline, ensure_ascii=False, indent=1))
    print(f"total {t0:.1f} s")


if __name__ == "__main__":
    main()
