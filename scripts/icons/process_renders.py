"""
Turn icon renders into transparent desktop icons.

    python scripts/icons/process_renders.py <renders-dir> [mapping.json]

mapping.json: {"<render filename>": "<icon name>", ...}. Without it, renders
already named <icon>.png are used as-is.

Renders that already have a transparent background are only trimmed, squared
and resized. Renders on BLACK with a soft neon glow are extracted first. Keying black naively either
leaves a dark box or eats the dark details inside the object, so:
  1. core    = clearly-lit pixels (max channel above CORE_T)
  2. solid   = core plus every hole inside it (dark eyes, outlines, screens):
               anything not reachable from the image border without crossing
               the core stays fully opaque
  3. halo    = the rest (the glow over black): un-premultiplied against black,
               alpha = brightness, colour rescaled, so the glow fades out over
               any desktop background instead of sitting on a black square
  4. trim, pad to square with a small margin, resize to 256.
A contact sheet on a dark and a light background is written to <renders-dir>.
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage

ICONS = [
    "spare-balance", "link-wallet", "roundup-rules", "stock-mix", "auto-invest",
    "spare-activity", "viewing-key", "stock-desk", "after-hours", "portfolio-xray",
    "fund-wallet",
]
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.join(ROOT, "public", "icons", "spare")
CORE_T = 120      # max-channel brightness that counts as "object"
HALO_FLOOR = 18   # below this the halo is fully transparent
HALO_GAMMA = 1.35 # >1 tightens the glow so it doesn't haze at 32px
MARGIN = 0.06
SIZE = 128  # 2x the 64 px desktop footprint


def extract(img: Image.Image) -> Image.Image:
    rgb = np.asarray(img.convert("RGB")).astype(np.float32)
    v = rgb.max(axis=2)
    core = v >= CORE_T
    core = ndimage.binary_closing(core, iterations=2)
    # Everything enclosed by the core is object, whatever its brightness.
    solid = ndimage.binary_fill_holes(core)
    # Dark pixels hugging the core (outline strokes) join the object too.
    solid |= ndimage.binary_dilation(solid, iterations=2) & (v >= 50)

    a = np.clip((v - HALO_FLOOR) / (255.0 - HALO_FLOOR), 0, 1) ** HALO_GAMMA
    alpha = np.where(solid, 1.0, a)
    # Un-premultiply the halo against black so its hue survives.
    scale = np.where(solid, 1.0, 255.0 / np.maximum(v, 1.0))
    out_rgb = np.clip(rgb * scale[..., None], 0, 255)
    out = np.dstack([out_rgb, alpha * 255.0]).astype(np.uint8)
    return Image.fromarray(out, "RGBA")


def square(img: Image.Image, size: int) -> Image.Image:
    bbox = img.getchannel("A").point(lambda x: 255 if x > 24 else 0).getbbox()
    if bbox:
        img = img.crop(bbox)
    w, h = img.size
    side = int(max(w, h) * (1 + 2 * MARGIN))
    c = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    c.alpha_composite(img, ((side - w) // 2, (side - h) // 2))
    return c.resize((size, size), Image.LANCZOS)


def framed(img: Image.Image, stroke: int = 7, shadow: tuple[int, int] = (6, 8)) -> Image.Image:
    """Deep-violet outline + soft drop shadow (at 512 px), so pastel holographic
    icons stay legible on the pastel desktop — the Win98 icon convention."""
    a = np.asarray(img)[..., 3] > 40
    ring = ndimage.binary_dilation(a, iterations=stroke)
    w, h = img.size
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    sh = np.zeros((h, w, 4), np.uint8)
    sh[..., :3] = (20, 11, 46)
    sh[..., 3] = (ring * 120).astype(np.uint8)
    sh_img = Image.fromarray(sh, "RGBA").filter(ImageFilter.GaussianBlur(6))
    out.alpha_composite(sh_img, shadow)
    ol = np.zeros((h, w, 4), np.uint8)
    ol[..., :3] = (46, 34, 96)
    ol[..., 3] = (ring * 235).astype(np.uint8)
    out.alpha_composite(Image.fromarray(ol, "RGBA").filter(ImageFilter.GaussianBlur(0.8)))
    out.alpha_composite(img)
    return out


def sheet(paths: list[str], out: str) -> None:
    sizes = (32, 48, 96)
    bgs = ((18, 16, 42, 255), (236, 214, 245, 255))
    pad = 10
    col = pad + sum(s + pad for s in sizes)
    w = col * len(bgs)
    h = pad + len(paths) * (max(sizes) + pad)
    s = Image.new("RGBA", (w, h), (0, 0, 0, 255))
    for bi, bg in enumerate(bgs):
        s.paste(Image.new("RGBA", (col, h), bg), (bi * col, 0))
        for i, p in enumerate(paths):
            im = Image.open(p).convert("RGBA")
            x, y = bi * col + pad, pad + i * (max(sizes) + pad)
            for z in sizes:
                s.alpha_composite(im.resize((z, z), Image.LANCZOS), (x, y + (max(sizes) - z) // 2))
                x += z + pad
    s.save(out)


def main(src: str, mapping_path: str | None) -> None:
    mapping = json.load(open(mapping_path)) if mapping_path else {
        f: os.path.splitext(f)[0] for f in os.listdir(src) if os.path.splitext(f)[0] in ICONS
    }
    os.makedirs(OUT, exist_ok=True)
    done = []
    for fname, name in mapping.items():
        if name not in ICONS:
            raise SystemExit(f"unknown icon name {name!r}")
        raw = Image.open(os.path.join(src, fname)).convert("RGBA")
        # Renders that already carry real transparency are used as-is; only
        # renders on a flat black background go through extract().
        has_alpha = (np.asarray(raw)[..., 3] == 0).mean() > 0.05
        icon = raw if has_alpha else extract(raw)
        framed(square(icon, 512)).resize((SIZE, SIZE), Image.LANCZOS).save(
            os.path.join(OUT, f"{name}.png"), optimize=True
        )
        done.append(os.path.join(OUT, f"{name}.png"))
        print(f"  {fname} -> public/icons/spare/{name}.png")
    missing = sorted(set(ICONS) - set(mapping.values()))
    if missing:
        print("  missing:", ", ".join(missing))
    order = [os.path.join(OUT, f"{n}.png") for n in ICONS if os.path.join(OUT, f"{n}.png") in done]
    sheet(order, os.path.join(src, "_sheet.png"))
    print("contact sheet:", os.path.join(src, "_sheet.png"))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else ".", sys.argv[2] if len(sys.argv) > 2 else None)
