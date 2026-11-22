# DEPS: pathlib, PIL | palette (PALETTE_HEX)
# RESPONSIBILITY: 用冻结色板绘制 32x16 与 64x32 地砖、两面剖面墙和地面底版
# MODULE: f1-parts.tools
# ---
from pathlib import Path
from PIL import Image, ImageDraw
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from palette import PALETTE_HEX

ROOT = Path(__file__).resolve().parent.parent
C = {h: tuple(int(h[i:i+2], 16) for i in (1, 3, 5)) + (255,) for h in PALETTE_HEX}
DARK, MID, LIGHT, GRAIN = (C[h] for h in ("#3B2A22", "#7C5A3E", "#96704C", "#5E4130"))


def floor_tile(w, h, path):
    img = Image.new("RGBA", (w, h))
    d = ImageDraw.Draw(img)
    d.polygon([(w//2, 0), (w-1, h//2), (w//2, h-1), (0, h//2)], fill=DARK)
    d.polygon([(w//2, 1), (w-3, h//2), (w//2, h-3), (2, h//2)], fill=MID)
    # 平行于等距长边的木板缝和少量短木纹
    step = max(2, w//16)
    for offset in range(-h//2+step, h//2, step):
        x1, y1 = max(1, offset*2), h//2-max(0, -offset)
        x2, y2 = min(w-2, w//2+offset*2), h//2+min(0, offset)
        if x1 < x2:
            d.line((x1, y1, x2, y2), fill=LIGHT, width=1)
    d.line((w//4, h//4, w//4+w//8, h//4+h//16), fill=GRAIN)
    d.line((w*3//5, h*3//5, w*3//5+w//10, h*3//5+h//20), fill=GRAIN)
    # 所有纹理必须裁回严格 2:1 菱形，禁止越过地砖外轮廓
    mask = Image.new("L", (w, h))
    ImageDraw.Draw(mask).polygon([(w//2, 0), (w-1, h//2), (w//2, h-1), (0, h//2)], fill=255)
    img.putalpha(mask)
    img.save(path)


def wall_strip(length, height, path):
    img = Image.new("RGBA", (length, height))
    d = ImageDraw.Draw(img)
    d.rectangle((0, 0, length-1, height-1), fill=C["#BFA48C"])
    d.rectangle((0, 0, length-1, 3), fill=C["#D9C4A8"])
    d.line((0, 4, length-1, 4), fill=C["#9C8069"])
    d.rectangle((0, height-12, length-1, height-1), fill=C["#4A3428"])
    d.rectangle((0, height-12, length-1, height-10), fill=C["#8A6242"])
    for x in range(0, length, 16):
        d.line((x, height-9, x, height-2), fill=C["#6B4A32"])
    img.save(path)


def floor_plane(tile_w, tile_h, cols, rows, path):
    tw, th = tile_w//2, tile_h//2
    img = Image.new("RGBA", ((cols+rows)*tw, (cols+rows)*th))
    tile = Image.open(ROOT / "floor" / f"tile-{tile_w}x{tile_h}.png")
    for y in range(rows):
        for x in range(cols):
            img.alpha_composite(tile, ((x-y+rows-1)*tw, (x+y)*th))
    img.save(path)


if __name__ == "__main__":
    for w, h in ((32, 16), (64, 32)):
        floor_tile(w, h, ROOT / "floor" / f"tile-{w}x{h}.png")
        wall_strip(192, h*2, ROOT / "floor" / f"wall-{w}.png")
        floor_plane(w, h, 6, 5, ROOT / "floor" / f"floor-{w}x{h}.png")
