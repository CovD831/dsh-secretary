#!/usr/bin/env python3
"""Self-contained Pixel Diorama density & composition gate.

Measures both full-screen and central diorama-ROI (center 78%x78% stage region)
after normalizing to 450px width (NEAREST) and 32-color median-cut quantization,
matching the canonical metric in PIXEL-ART-PLAN.md:
  - Grade A (Passable):   edge >= 0.20, block_median >= 0.20, small_step >= 0.10
  - Grade B (Good):       edge >= 0.35, block_median >= 0.35, small_step >= 0.22
  - Grade C (Reference):  edge >= 0.46, block_median >= 0.42, small_step >= 0.28
"""
from __future__ import annotations

import sys
from PIL import Image
import numpy as np

TARGET_W = 450
QUANT_COLORS = 32
BLOCKS = 6


def compute_metrics(im: Image.Image) -> dict[str, float]:
    scale = im.width / TARGET_W
    resized = im.resize((TARGET_W, max(1, int(im.height / scale))), Image.NEAREST)
    quant = resized.quantize(colors=QUANT_COLORS, method=Image.MEDIANCUT).convert("RGB")
    arr = np.array(quant, dtype=np.int16)
    h, w, _ = arr.shape

    dx = np.any(arr[:, 1:] != arr[:, :-1], axis=2).mean()
    dy = np.any(arr[1:, :] != arr[:-1, :], axis=2).mean()
    edge = float((dx + dy) / 2.0)

    diff = np.abs(arr[:, 1:] - arr[:, :-1]).max(axis=2)
    small = float(((diff >= 1) & (diff <= 40)).mean())

    ph, pw = max(1, h // BLOCKS), max(1, w // BLOCKS)
    blocks: list[float] = []
    for r in range(BLOCKS):
        for c in range(BLOCKS):
            cell = arr[r * ph : (r + 1) * ph, c * pw : (c + 1) * pw]
            if cell.shape[0] < 2 or cell.shape[1] < 2:
                continue
            bx = np.any(cell[:, 1:] != cell[:, :-1], axis=2).mean()
            by = np.any(cell[1:, :] != cell[:-1, :], axis=2).mean()
            blocks.append(float((bx + by) / 2.0))
    blocks.sort()
    block_med = blocks[len(blocks) // 2] if blocks else 0.0
    return {
        "edge": round(edge, 4),
        "block": round(block_med, 4),
        "small": round(small, 4),
    }


def grade_of(m: dict[str, float]) -> str:
    if m["edge"] >= 0.46 and m["block"] >= 0.42 and m["small"] >= 0.28:
        return "C"
    if m["edge"] >= 0.35 and m["block"] >= 0.32 and m["small"] >= 0.22:
        return "B"
    if m["edge"] >= 0.20 and m["block"] >= 0.20 and m["small"] >= 0.10:
        return "A"
    return "D"


def main(argv: list[str]) -> int:
    req_grade: str | None = None
    paths: list[str] = []
    for arg in argv[1:]:
        if arg.startswith("--require-grade="):
            req_grade = arg.split("=", 1)[1].strip().upper()
        else:
            paths.append(arg)
    if not paths:
        print(__doc__)
        return 2

    order = {"D": 0, "A": 1, "B": 2, "C": 3}
    exit_code = 0
    print(f"{'file':<44} {'scope':<8} {'edge':>6} {'block':>6} {'small':>6}  grade")
    for p in paths:
        im = Image.open(p).convert("RGB")
        full = compute_metrics(im)
        # Central diorama ROI (excludes outer dark stage vignette border)
        x0, y0 = int(im.width * 0.10), int(im.height * 0.08)
        x1, y1 = int(im.width * 0.90), int(im.height * 0.88)
        roi = compute_metrics(im.crop((x0, y0, x1, y1)))
        fg, rg = grade_of(full), grade_of(roi)
        short = p.split("/")[-1][:44]
        print(f"{short:<44} {'full':<8} {full['edge']:>6.3f} {full['block']:>6.3f} {full['small']:>6.3f}  {fg}")
        print(f"{short:<44} {'diorama':<8} {roi['edge']:>6.3f} {roi['block']:>6.3f} {roi['small']:>6.3f}  {rg}")
        best = rg if order[rg] >= order[fg] else fg
        if req_grade and order[best] < order.get(req_grade, 3):
            exit_code = 1
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
