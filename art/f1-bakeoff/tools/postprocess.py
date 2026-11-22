# DEPS: json, sys, pathlib, PIL | palette (PALETTE_RGB, nearest_palette_index), prompts (ASSETS)
# RESPONSIBILITY: 三方统一后处理：去背景→裁bbox→最近邻缩到原生→Oklab量化46色→2x预览，输出指标
# MODULE: f1-bakeoff.tools
# ---
import json
import sys
from pathlib import Path

from PIL import Image

from palette import PALETTE_RGB, nearest_palette_index
from prompts import ASSETS

ROOT = Path(__file__).resolve().parent.parent


def remove_background(img):
    """角点泛洪去背景（容忍近白/近纯色底），保留主体。返回 RGBA。"""
    img = img.convert("RGBA")
    w, h = img.size
    px = img.load()
    # 角点颜色均值作为底色
    corners = [px[0, 0], px[w - 1, 0], px[0, h - 1], px[w - 1, h - 1]]
    br = sum(c[0] for c in corners) / 4
    bg = sum(c[1] for c in corners) / 4
    bb = sum(c[2] for c in corners) / 4
    tol = 28

    def near(p, c):
        return abs(p[0] - c[0]) < tol and abs(p[1] - c[1]) < tol and abs(p[2] - c[2]) < tol

    # 棋盘格假透明：角点通常是白或浅灰。把角点色与"另一格色"都当背景
    light = (238, 238, 238)
    gray = (200, 200, 200)
    checkerish = all(abs(c[0] - c[1]) < 12 and abs(c[1] - c[2]) < 12 and c[0] > 175 for c in corners)

    def is_bg(p):
        if near(p, (br, bg, bb)):
            return True
        if checkerish:
            # 背景为无彩色浅灰白，且接近白/灰两档
            if abs(p[0] - p[1]) < 14 and abs(p[1] - p[2]) < 14 and p[0] > 175:
                return near(p, light) or near(p, gray) or p[0] > 230
        return False

    seen = bytearray(w * h)
    stack = [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]
    while stack:
        x, y = stack.pop()
        if x < 0 or y < 0 or x >= w or y >= h:
            continue
        i = y * w + x
        if seen[i]:
            continue
        seen[i] = 1
        p = px[x, y]
        if p[3] == 0 or is_bg(p):
            px[x, y] = (0, 0, 0, 0)
            stack.extend(((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)))
    return img


def process(raw_path, asset, out_dir):
    spec = ASSETS[asset]
    nw, nh = spec["native"]
    img = Image.open(raw_path)
    orig_size = img.size
    img = remove_background(img)
    bbox = img.getbbox()
    if bbox:
        img = img.crop(bbox)
    # 最近邻缩到原生：地砖强制铺满 32x16（菱形应已贴合），人物/立绘等比缩放后居中贴底
    if asset == "tile":
        native = img.resize((nw, nh), Image.NEAREST)
    else:
        scale = min(nw / img.width, nh / img.height)
        sw = max(1, round(img.width * scale))
        sh = max(1, round(img.height * scale))
        img = img.resize((sw, sh), Image.NEAREST)
        native = Image.new("RGBA", (nw, nh), (0, 0, 0, 0))
        native.paste(img, ((nw - sw) // 2, nh - sh))
    # 量化到 46 色
    px = native.load()
    total = colored = 0
    err_sum = 0.0
    hist = {}
    semi = 0
    for y in range(nh):
        for x in range(nw):
            r, g, b, a = px[x, y]
            if a < 128:
                if a:
                    semi += 1
                px[x, y] = (0, 0, 0, 0)
                continue
            total += 1
            idx, dist = nearest_palette_index((r, g, b))
            err_sum += dist
            hist[idx] = hist.get(idx, 0) + 1
            pr, pg, pb = PALETTE_RGB[idx]
            px[x, y] = (pr, pg, pb, 255)
            colored += 1
    out_dir.mkdir(parents=True, exist_ok=True)
    native_path = out_dir / f"{asset}.png"
    native.save(native_path)
    preview = native.resize((nw * 2, nh * 2), Image.NEAREST)
    preview.save(out_dir / f"{asset}@2x.png")
    metrics = {
        "orig_size": list(orig_size),
        "pixels": total,
        "colors_used": len(hist),
        "mean_oklab_err": round(err_sum / max(total, 1), 4),
        "semi_alpha_cleared": semi,
        "corner_alpha": [native.getpixel(p)[3] for p in
                         [(0, 0), (nw - 1, 0), (0, nh - 1), (nw - 1, nh - 1)]],
    }
    (out_dir / f"{asset}.metrics.json").write_text(json.dumps(metrics, ensure_ascii=False, indent=2))
    print(f"{out_dir.name}/{asset}: colors={len(hist)} err={metrics['mean_oklab_err']} semi={semi}")
    return metrics


if __name__ == "__main__":
    src = Path(sys.argv[1])   # 原图路径
    asset = sys.argv[2]
    out_dir = Path(sys.argv[3])
    process(src, asset, out_dir)
