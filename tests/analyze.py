"""Inspect an exported video: streams, full decode, dominant audio frequency per segment, frame pixels.

usage: python3 analyze.py FILE '{"segments": [[t0, t1, hz_or_0_for_silence], ...], "frames": [t, ...]}'
"""
import json
import subprocess
import sys

import numpy as np

path, spec = sys.argv[1], json.loads(sys.argv[2])


def run(*args, **kw):
    return subprocess.run(list(args), capture_output=True, **kw)


probe = json.loads(run("ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", path).stdout)
v = next(s for s in probe["streams"] if s["codec_type"] == "video")
a = next((s for s in probe["streams"] if s["codec_type"] == "audio"), None)
dec = run("ffmpeg", "-v", "error", "-i", path, "-f", "null", "-")

SR = 48000
pcm = np.frombuffer(
    run("ffmpeg", "-v", "error", "-i", path, "-vn", "-ac", "1", "-ar", str(SR), "-f", "f32le", "-").stdout,
    dtype=np.float32,
)

segments = []
for t0, t1, hz in spec["segments"]:
    x = pcm[int(t0 * SR) : int(t1 * SR)]
    rms = float(np.sqrt(np.mean(x**2))) if len(x) else 0.0
    if hz == 0:
        segments.append({"t": [t0, t1], "rms": round(rms, 4), "pass": bool(rms < 0.003)})
        continue
    spec_ = np.abs(np.fft.rfft(x * np.hanning(len(x))))
    peak = float(np.fft.rfftfreq(len(x), 1 / SR)[np.argmax(spec_)])
    segments.append({"t": [t0, t1], "peak": round(peak), "rms": round(rms, 4), "pass": bool(abs(peak - hz) < 8 and rms > 0.01)})

W, H = v["width"], v["height"]
frames = []
for f in spec["frames"]:
    raw = run("ffmpeg", "-v", "error", "-ss", str(f["t"]), "-i", path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-").stdout
    img = np.frombuffer(raw, dtype=np.uint8).reshape(H, W, 3).astype(int)
    out = {"t": f["t"]}
    for name, (x0, y0, x1, y1) in f.get("regions", {}).items():
        out[name] = round(float(img[y0:y1, x0:x1].mean()), 1)
    if "title_band" in f:
        x0, y0, x1, y1 = f["title_band"]
        out["title_px"] = int(((img[y0:y1, x0:x1] > 235).all(axis=2)).sum())
    frames.append(out)

print(json.dumps({
    "video_codec": v["codec_name"],
    "audio_codec": a["codec_name"] if a else None,
    "width": v["width"],
    "height": v["height"],
    "duration": float(probe["format"]["duration"]),
    "decode_ok": dec.returncode == 0 and not dec.stderr.strip(),
    "decode_err": dec.stderr.decode()[:300],
    "segments": segments,
    "frames": frames,
}))
