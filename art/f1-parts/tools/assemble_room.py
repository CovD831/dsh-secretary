# DEPS: pathlib, PIL | 无本地依赖
# RESPONSIBILITY: 按等距底部中心锚点和 x+y 深度组装两档测试房
# MODULE: f1-parts.tools
# ---
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent


def wall_polygon(length, height, slope, reverse=False):
    wall = Image.open(ROOT / "floor" / f"wall-{32 if slope == 16 else 64}.png").convert("RGBA")
    if reverse:
        wall = wall.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    out = Image.new("RGBA", (length, height + length//2))
    # 水平墙段剪成 2:1 等距斜边；左墙镜像
    return wall.transform(out.size, Image.Transform.AFFINE,
                          (1, slope if reverse else -slope, 0, 0, 1, 0),
                          resample=Image.Resampling.NEAREST)


def build(tile_w, suffix=""):
    tile_h = tile_w//2
    tw, th = tile_w//2, tile_h//2
    cols, rows, wall_h = 6, 5, tile_w*2
    margin = 16
    origin = (rows*tw+margin, wall_h+margin)
    floor = Image.open(ROOT / "floor" / f"floor-{tile_w}x{tile_h}.png")
    room = Image.new("RGBA", (floor.width+margin*2, floor.height+wall_h+margin*2), (32, 26, 24, 255))
    right_wall = wall_polygon(cols*tw, wall_h, th)
    left_wall = wall_polygon(rows*tw, wall_h, th, True).transpose(Image.Transpose.FLIP_TOP_BOTTOM)
    room.alpha_composite(right_wall, (origin[0], origin[1]-wall_h))
    room.alpha_composite(left_wall, (origin[0]-rows*tw, origin[1]-wall_h-rows*th))
    room.alpha_composite(floor, (origin[0]-rows*tw, origin[1]))

    def anchor(cell):
        x, y = cell
        return origin[0]+(x-y)*tw, origin[1]+(x+y+2)*th

    furniture_size = 64 if tile_w == 32 else 128
    items = [
        ((0, 0), ROOT / "furniture" / f"bookshelf-{furniture_size}.png"),
        ((2, 1), ROOT / "furniture" / f"desk-{furniture_size}.png"),
        ((3, 2), ROOT / "worker" / "worker-large.png"),
    ]
    for cell, path in sorted(items, key=lambda item: sum(item[0])):
        sprite = Image.open(path)
        x, y = anchor(cell)
        room.alpha_composite(sprite, (x-sprite.width//2, y-sprite.height+1))
    name = f"room-test{suffix}.png"
    room.save(ROOT / "room" / name)
    room.resize((room.width*2, room.height*2), Image.Resampling.NEAREST).save(ROOT / "room" / name.replace(".png", "@2x.png"))
    # 灰底更能检查透明轮廓；预览仍为整数 2 倍
    preview_bg = Image.new("RGBA", room.size, (217, 196, 168, 255))
    preview_bg.alpha_composite(room)
    preview_bg.resize((room.width*2, room.height*2), Image.Resampling.NEAREST).convert("RGB").save(ROOT / "room" / name.replace(".png", "@2x-light.png"))


if __name__ == "__main__":
    build(32)
    build(64, "-64x32")
