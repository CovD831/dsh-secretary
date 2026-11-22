# DEPS: pathlib, PIL | prompts (ASSETS)
# RESPONSIBILITY: 3来源 x 3素材 2x 对比拼图，带文字标注，棋盘格衬底显示透明区
# MODULE: f1-bakeoff.tools
# ---
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SOURCES = [("A-meowart", "A MeowArt"), ("B-gpt-image", "B gpt-image-2.6"), ("C-gemini", "C gemini-3-pro-image")]
ASSETS = [("tile", "Tile 32x16 @2x"), ("worker", "Worker 24x32 @2x"), ("portrait", "Portrait 192x240 @2x")]
CELL_W, CELL_H = 400, 520
LABEL_L, LABEL_T = 170, 34


def checker(size, c=8):
    img = Image.new("RGB", size, (72, 72, 76))
    d = ImageDraw.Draw(img)
    for y in range(0, size[1], c):
        for x in range(0, size[0], c):
            if (x // c + y // c) % 2 == 0:
                d.rectangle([x, y, x + c - 1, y + c - 1], fill=(88, 88, 92))
    return img


canvas = Image.new("RGB", (LABEL_L + CELL_W * 3, LABEL_T + CELL_H * 3), (30, 28, 26))
d = ImageDraw.Draw(canvas)
for col, (_, title) in enumerate(ASSETS):
    d.text((LABEL_L + col * CELL_W + 12, 10), title, fill=(240, 230, 215))
for row, (dirname, title) in enumerate(SOURCES):
    d.text((12, LABEL_T + row * CELL_H + 20), title, fill=(240, 230, 215))
    for col, (asset, _) in enumerate(ASSETS):
        ox, oy = LABEL_L + col * CELL_W, LABEL_T + row * CELL_H
        bg = checker((CELL_W, CELL_H))
        canvas.paste(bg, (ox, oy))
        p = ROOT / dirname / f"{asset}@2x.png"
        if p.exists():
            img = Image.open(p).convert("RGBA")
            canvas.paste(img, (ox + (CELL_W - img.width) // 2, oy + (CELL_H - img.height) // 2), img)
        else:
            d.text((ox + 150, oy + 250), "MISSING", fill=(230, 90, 80))
        d.rectangle([ox, oy, ox + CELL_W - 1, oy + CELL_H - 1], outline=(60, 55, 50))
canvas.save(ROOT / "compare.png")
print("saved", ROOT / "compare.png", canvas.size)
