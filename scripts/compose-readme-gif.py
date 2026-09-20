"""Join four real Playwright captures; needs Pillow, only for optional GIF output."""
import sys
from pathlib import Path
from PIL import Image

source = Path(sys.argv[1])
destination = Path(__file__).resolve().parent.parent / "docs/images/review-flow.gif"
names = ["01-explanation", "02-code", "03-question", "04-posted"]
frames = []
for name in names:
    with Image.open(source / f"{name}.png") as original:
        if original.size != (1688, 1424):
            raise ValueError(f"Unexpected frame size: {name}: {original.size}")
        # CSS-pixel size keeps the text legible without a large 2x animated asset.
        frame = original.convert("RGB").resize((844, 712), Image.Resampling.LANCZOS)
        frames.append(frame.quantize(colors=128))
frames[0].save(destination, save_all=True, append_images=frames[1:],
               duration=[3000, 3000, 4000, 3000], loop=0, optimize=True, disposal=2)
with Image.open(destination) as result:
    assert result.n_frames == 4 and result.size == (844, 712)
print(f"Created {destination}: 4 frames, 13 seconds, {destination.stat().st_size} bytes")
