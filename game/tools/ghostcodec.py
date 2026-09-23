"""Ghost channel codec (spec §8.2 "チャンネルの符号化"); mirrored by src/core/ghostcodec.ts.

  quantise : x -> round(x * 1e4)   (0.1 mm)
             th -> round(th * 1e4) (0.1 mrad)
             f -> round(F * 10)    (0.1 N)
             round() is JS Math.round (half up, towards +inf) so both sides agree.
  layout   : first value as is, then differences to the previous value
  varint   : zigzag (n >= 0 ? 2n : -2n-1), then unsigned LEB128 (7 bits, low first)
  text     : base64url without padding
"""

from __future__ import annotations

import base64
import math

SCALE = {"x": 1e4, "th": 1e4, "f": 10.0}


def js_round(v: float) -> int:
    """Math.round: floor(v + 0.5) (ties go towards +inf, -0.5 -> -0)."""
    return int(math.floor(v + 0.5))


def zigzag(n: int) -> int:
    return 2 * n if n >= 0 else -2 * n - 1


def unzigzag(z: int) -> int:
    return z >> 1 if (z & 1) == 0 else -((z + 1) >> 1)


def b64url_encode(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode("ascii")


def b64url_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def encode_ints(ints) -> str:
    out = bytearray()
    prev = 0
    for i, n in enumerate(ints):
        n = int(n)
        d = n if i == 0 else n - prev
        prev = n
        z = zigzag(d)
        while True:
            byte = z & 0x7F
            z >>= 7
            if z:
                out.append(byte | 0x80)
            else:
                out.append(byte)
                break
    return b64url_encode(bytes(out))


def decode_ints(s: str) -> list[int]:
    data = b64url_decode(s)
    out, prev, z, shift = [], 0, 0, 0
    for byte in data:
        z |= (byte & 0x7F) << shift
        if byte & 0x80:
            shift += 7
            continue
        d = unzigzag(z)
        prev = d if not out else prev + d
        out.append(prev)
        z, shift = 0, 0
    if shift:
        raise ValueError("truncated varint")
    return out


def quantize(values, channel: str) -> list[int]:
    k = SCALE[channel]
    return [js_round(float(v) * k) for v in values]


def dequantize(ints, channel: str) -> list[float]:
    k = SCALE[channel]
    return [n / k for n in ints]


def encode_channel(values, channel: str) -> str:
    return encode_ints(quantize(values, channel))


def decode_channel(s: str, channel: str) -> list[float]:
    return dequantize(decode_ints(s), channel)


if __name__ == "__main__":
    import random
    rng = random.Random(0)
    for _ in range(2000):
        n = rng.randint(0, 50)
        ints = [rng.randint(-2**27, 2**27) for _ in range(n)]
        assert decode_ints(encode_ints(ints)) == ints
    assert js_round(-0.5) == 0 and js_round(0.5) == 1 and js_round(-1.5) == -1
    print("ghostcodec self-test ok")
