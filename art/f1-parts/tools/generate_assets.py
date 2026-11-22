# DEPS: base64, concurrent.futures, json, os, urllib.request, pathlib | 无本地依赖
# RESPONSIBILITY: 调用 gpt-image-2.6 生成四件家具与两种坐姿人物原图
# MODULE: f1-parts.tools
# ---
import base64
import concurrent.futures
import json
import os
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
PREFIX = (
    "Isometric 2:1 pixel art single game asset, warm walnut and cream office palette, "
    "expressive illustration-like pixel clusters, crisp square pixels, 1px dark brown outline, "
    "low saturation materials, no anti-aliasing, no gradients, no text, no shadow. "
)
SUFFIX = (
    " Isolated single object, subject fills 85 percent of the square canvas, front 3/4 view. "
    "NO room, NO walls, NO floor, NO floor tile, NO rug, NO background scenery, "
    "transparent background only, no checkerboard."
)
SPECS = {
    "desk-64": PREFIX + "A compact walnut office desk with ONE computer monitor, keyboard and small mug, designed as a native 64x64 pixel sprite; bold readable shapes, large monitor, two tile wide footprint." + SUFFIX,
    "desk-128": PREFIX + "A compact walnut office desk with ONE computer monitor, keyboard and small mug, designed as a native 128x128 pixel sprite; bold readable shapes, large monitor, two tile wide footprint." + SUFFIX,
    "bookshelf-64": PREFIX + "A small walnut office bookshelf with cream books and a green plant, designed as a native 64x64 pixel sprite; bold readable shapes, one tile wide footprint." + SUFFIX,
    "bookshelf-128": PREFIX + "A small walnut office bookshelf with cream books and a green plant, designed as a native 128x128 pixel sprite; bold readable shapes, one tile wide footprint." + SUFFIX,
    "worker-direct": PREFIX + "One seated office worker typing, side-facing three-quarter view, navy shirt, dark brown hair, expressive face, entire seated person and simple chair visible, native 48x64 pixel sprite, generous clear pixel clusters. NO desk, NO computer, NO furniture except chair." + SUFFIX,
    "worker-large": PREFIX + "One seated office worker typing, side-facing three-quarter view, navy shirt, dark brown hair, expressive face, entire seated person and simple chair visible, large detailed 192x256 pixel sprite intended for exact 4x nearest-neighbor reduction to 48x64, broad pixel clusters. NO desk, NO computer, NO furniture except chair." + SUFFIX,
}


def generate(item):
    name, prompt = item
    payload = {"model": "gpt-image-2.6", "prompt": prompt, "n": 1, "size": "1024x1024"}
    req = urllib.request.Request(
        os.environ["TK1688_BASE_URL"].rstrip("/") + "/v1/images/generations",
        data=json.dumps(payload).encode(),
        headers={"Authorization": "Bearer " + os.environ["TK1688_API_KEY"], "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=240) as response:
        data = json.loads(response.read())
    image = data["data"][0]
    target = ROOT / "raw" / (name + ".png")
    if image.get("b64_json"):
        target.write_bytes(base64.b64decode(image["b64_json"]))
    else:
        with urllib.request.urlopen(image["url"], timeout=120) as response:
            target.write_bytes(response.read())
    (ROOT / "raw" / (name + ".prompt.txt")).write_text(prompt)
    return name


if __name__ == "__main__":
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        for name in pool.map(generate, SPECS.items()):
            print(name, flush=True)
