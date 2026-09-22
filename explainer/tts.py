"""Narration with VOICEVOX (ずんだもん) -> remotion/public/voice/*.wav + timeline.json.

The audio is made first and its measured lengths set the scene lengths; the
Manim scenes then pace their animations on timeline.json.

Needs VOICEVOX ENGINE at 127.0.0.1:50021:
    docker run --rm -d --name voicevox_engine -p 127.0.0.1:50021:50021 voicevox/voicevox_engine:cpu-latest
Run: uv run python explainer/tts.py [--kana]   (--kana prints how each line will be read)
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

sys.path.insert(0, str(Path(__file__).parent))
from script import SCENES, lines  # noqa: E402

HOST = "http://127.0.0.1:50021"
SPEAKER = 3  # ずんだもん（ノーマル）
SPEED = 1.5
PUBLIC = Path(__file__).parent / "remotion" / "public"
VOICE = PUBLIC / "voice"
LEAD, GAP, TAIL = 0.3, 0.2, 0.6  # silence before the first line, between lines, after the last [s]
SUB_MAX = 30  # characters per subtitle row; rows are broken by hand in script.py
TARGET_SPEECH_RMS = 0.14
PEAK_CEIL = 0.92


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
    q["prePhonemeLength"] = 0.05
    q["postPhonemeLength"] = 0.1
    q["outputSamplingRate"] = 48000
    path.write_bytes(post("/synthesis", {"speaker": SPEAKER}, json.dumps(q).encode()))
    normalize(path)


def duration(path: Path) -> float:
    with wave.open(str(path)) as w:
        return w.getnframes() / w.getframerate()


def main():
    if "--kana" in sys.argv:
        for sc in SCENES:
            for sub, reading in lines(sc):
                print(f"{sc['id']}: {query(reading)['kana']}")
        return
    VOICE.mkdir(parents=True, exist_ok=True)
    keep, timeline, t0 = set(), [], 0.0
    for sc in SCENES:
        t, items = LEAD, []
        for i, (sub, reading) in enumerate(lines(sc)):
            key = hashlib.sha1(f"{SPEAKER}|{SPEED}|{reading}".encode()).hexdigest()[:10]
            f = VOICE / f"{sc['id']}_{i:02d}_{key}.wav"
            keep.add(f.name)
            if not f.exists():
                synth(reading, f)
            d = duration(f)
            for row in sub.split("\n"):
                if len(row) > SUB_MAX:
                    print(f"  ! {sc['id']} line {i}: subtitle row of {len(row)} chars: {row}")
            items.append({"text": sub, "file": f"voice/{f.name}", "start": round(t, 3), "end": round(t + d, 3)})
            t += d + GAP
        dur = round(t - GAP + TAIL, 3)
        timeline.append({"id": sc["id"], "chapter": sc["chapter"], "start": round(t0, 3), "duration": dur,
                         "lines": items})
        print(f"{sc['id']:14s} {dur:6.1f} s  ({len(items)} lines)")
        t0 += dur
    for f in VOICE.glob("*.wav"):  # drop takes of lines that were rewritten
        if f.name not in keep:
            f.unlink()
    (PUBLIC / "timeline.json").write_text(json.dumps(timeline, ensure_ascii=False, indent=1))
    print(f"total {t0:.1f} s = {int(t0 // 60)}:{t0 % 60:04.1f}")


if __name__ == "__main__":
    main()
