"""Compose real UI frames with recorded cursor positions; requires Pillow."""
import json
import math
import sys
from pathlib import Path
from PIL import Image

source = Path(sys.argv[1])
manifest = json.loads((source / "frames.json").read_text())
size = (manifest["width"], manifest["height"])
capture_size = tuple(value * manifest["scale"] for value in size)
destination = Path(__file__).resolve().parent.parent / "docs/images/review-flow.gif"
frames = []
for entry in manifest["frames"]:
    with Image.open(source / entry["file"]) as original:
        if original.size != capture_size:
            raise ValueError(f"Unexpected capture size: {entry['file']}: {original.size}")
        frames.append(original.convert("RGB").resize(size, Image.Resampling.LANCZOS))

# One palette across the sequence keeps static text and code colors from flickering.
samples = Image.new("RGB", (160 * 8, 107 * math.ceil(len(frames) / 8)))
for index, frame in enumerate(frames):
    samples.paste(frame.resize((160, 107)), ((index % 8) * 160, (index // 8) * 107))
palette = samples.quantize(colors=192)
frames = [frame.quantize(palette=palette, dither=Image.Dither.NONE) for frame in frames]
durations = [entry["duration"] for entry in manifest["frames"]]
assert sum(durations) == manifest["duration"] == 7500
frames[0].save(destination, save_all=True, append_images=frames[1:],
               duration=durations, loop=0, optimize=False, disposal=1)
with Image.open(destination) as result:
    assert result.size == size and result.n_frames > 10
    total = 0
    for index in range(result.n_frames):
        result.seek(index)
        total += result.info["duration"]
    assert total == manifest["duration"]
    print(f"Created {destination}: {result.n_frames} frames, {total / 1000}s, "
          f"{destination.stat().st_size} bytes")
