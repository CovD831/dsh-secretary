# DEPS: json, sys, pathlib, PIL | palette (PALETTE_RGB, nearest_palette_index)
# RESPONSIBILITY: 去除 AI 原图背景并裁切、缩放、量化到冻结色板，记录占地和底部中心锚点
# MODULE: f1-parts.tools
# ---
import json
from pathlib import Path
import sys
from PIL import Image
sys.path.insert(0, str(Path(__file__).resolve().parent))
from palette import PALETTE_RGB, nearest_palette_index

ROOT = Path(__file__).resolve().parent.parent
SPECS = {
    "desk-64": (64, 64, [2, 2], "furniture"),
    "desk-128": (128, 128, [2, 2], "furniture"),
    "bookshelf-64": (64, 64, [1, 1], "furniture"),
    "bookshelf-128": (128, 128, [1, 1], "furniture"),
    "worker-direct": (48, 64, [1, 1], "worker"),
    "worker-large": (48, 64, [1, 1], "worker"),
}


def clear_background(img):
    img = img.convert("RGBA")
    p = img.load()
    corners = [p[0, 0], p[img.width-1, 0], p[0, img.height-1], p[img.width-1, img.height-1]]
    gray = all(abs(c[0]-c[1]) < 18 and abs(c[1]-c[2]) < 18 and c[0] > 155 for c in corners)
    for y in range(img.height):
        for x in range(img.width):
            r, g, b, a = p[x, y]
            if a and gray and abs(r-g) < 19 and abs(g-b) < 19 and r > 155:
                p[x, y] = (0, 0, 0, 0)
            elif a < 128:
                p[x, y] = (0, 0, 0, 0)
    return img


def process(name, spec):
    w, h, footprint, group = spec
    source = clear_background(Image.open(ROOT / "raw" / f"{name}.png"))
    bbox = source.getbbox()
    source = source.crop(bbox)
    scale = min((w-4)/source.width, (h-4)/source.height)
    size = (max(1, round(source.width*scale)), max(1, round(source.height*scale)))
    source = source.resize(size, Image.Resampling.LANCZOS)
    out = Image.new("RGBA", (w, h))
    out.alpha_composite(source, ((w-size[0])//2, h-size[1]-2))
    error = 0
    count = 0
    p = out.load()
    for y in range(h):
        for x in range(w):
            r, g, b, a = p[x, y]
            if a < 128:
                p[x, y] = (0, 0, 0, 0)
                continue
            idx, dist = nearest_palette_index((r, g, b))
            p[x, y] = PALETTE_RGB[idx] + (255,)
            error += dist
            count += 1
    folder = ROOT / group
    out.save(folder / f"{name}.png")
    out.resize((w*2, h*2), Image.Resampling.NEAREST).save(folder / f"{name}@2x.png")
    meta = {
        "native_size": [w, h], "footprint_tiles_32x16": footprint,
        "anchor": "bottom_center", "anchor_px": [w//2, h-1],
        "palette_colors": len(set(out.getdata())), "mean_oklab_error": round(error/max(count, 1), 4),
    }
    (folder / f"{name}.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2))
    print(name, size, meta["palette_colors"], meta["mean_oklab_error"])


if __name__ == "__main__":
    for asset_name, asset_spec in SPECS.items():
        process(asset_name, asset_spec)
