# DEPS: PIL | 无本地依赖
# RESPONSIBILITY: 冻结 46 色色板定义、色板参考图生成、Oklab 最近色量化
# MODULE: f1-bakeoff.tools
# ---
from PIL import Image

PALETTE_HEX = [
    # 墙 6
    "#3A2E28", "#5A463A", "#7A6150", "#9C8069", "#BFA48C", "#D9C4A8",
    # 木作 4
    "#4A3428", "#6B4A32", "#8A6242", "#A87A52",
    # 地面 4
    "#3B2A22", "#5E4130", "#7C5A3E", "#96704C",
    # 描边 2
    "#1A1412", "#2C211B",
    # 家具 6
    "#2E2A2A", "#4A4440", "#6E665E", "#8C8478", "#3E4A44", "#6B3A32",
    # 皮肤/头发 6
    "#D8C0A8", "#C09070", "#8F6046", "#2A2220", "#7A5438", "#C9C0B4",
    # 衣物 5
    "#3F5A78", "#7A3A3A", "#4A6A50", "#D8D0C0", "#6B7F96",
    # UI 5
    "#201A18", "#302722", "#4A3C34", "#E8DCCB", "#C9A46A",
    # 状态 8
    "#2FA8E0", "#17688F", "#F2A93B", "#A86A17",
    "#E8544E", "#9E2F2C", "#3FCB6B", "#247A42",
]
assert len(PALETTE_HEX) == 46
PALETTE_RGB = [tuple(int(h[i:i + 2], 16) for i in (1, 3, 5)) for h in PALETTE_HEX]


def _srgb_to_linear(c):
    c = c / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def rgb_to_oklab(r, g, b):
    lr, lg, lb = _srgb_to_linear(r), _srgb_to_linear(g), _srgb_to_linear(b)
    l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb
    m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb
    s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb
    l_, m_, s_ = l ** (1 / 3), m ** (1 / 3), s ** (1 / 3)
    return (
        0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
        1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
        0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
    )


PALETTE_LAB = [rgb_to_oklab(*c) for c in PALETTE_RGB]


def nearest_palette_index(rgb):
    lab = rgb_to_oklab(*rgb)
    best, best_d = 0, float("inf")
    for i, pl in enumerate(PALETTE_LAB):
        d = (lab[0] - pl[0]) ** 2 + (lab[1] - pl[1]) ** 2 + (lab[2] - pl[2]) ** 2
        if d < best_d:
            best, best_d = i, d
    return best, best_d ** 0.5


def make_palette_image(path):
    """46 色色板参考图：8 列 x 6 行（末两格留白），每格 64px。"""
    cell, cols = 64, 8
    rows = (46 + cols - 1) // cols
    img = Image.new("RGB", (cols * cell, rows * cell), (255, 255, 255))
    for i, rgb in enumerate(PALETTE_RGB):
        x, y = (i % cols) * cell, (i // cols) * cell
        for yy in range(y, y + cell):
            for xx in range(x, x + cell):
                img.putpixel((xx, yy), rgb)
    img.save(path)
    return path


if __name__ == "__main__":
    import sys
    make_palette_image(sys.argv[1] if len(sys.argv) > 1 else "palette.png")
