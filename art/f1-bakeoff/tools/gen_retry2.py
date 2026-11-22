# DEPS: base64, json, os, subprocess, sys, pathlib
# RESPONSIBILITY: A/C 第2次重试：主体前置 + 禁止房间/墙/场景，A走meowart C走tk1688
# MODULE: f1-bakeoff.tools
# ---
import base64
import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NEG = (" Do NOT draw a room, walls, floor, ceiling, furniture arrangement or any background scene. "
       "Do NOT draw an isometric room diorama. Only the single subject described, nothing else.")

RETRY = {
    "tile": ("One single flat diamond-shaped wooden floor tile, top-down isometric 2:1 rhombus, "
             "width exactly twice its height, warm walnut wood planks with subtle grain, "
             "1px dark outline #1A1412, flat lighting, retro pixel art with crisp square pixels, "
             "no anti-aliasing, transparent background. The tile must fill almost the entire canvas."),
    "worker": ("One single small office worker character sprite sitting on a simple task chair typing "
               "at a tiny desk with one monitor, isometric 2:1 view, navy shirt #3F5A78, dark hair #2A2220, "
               "retro pixel art, chunky visible square pixels, 1px dark outline, no anti-aliasing, "
               "transparent background. The character fills most of the canvas."),
    "portrait": ("Head-and-shoulders bust portrait of one warm attentive female secretary, neutral expression, "
                 "3/4 view, navy blouse #3F5A78 and cream collar #D8D0C0, retro pixel art, crisp square pixels, "
                 "1px dark outline, no anti-aliasing, transparent background. "
                 "Only the person from chest up, no room, no desk, no objects."),
}

which = sys.argv[1]  # A | C
assets = sys.argv[2].split(",")

if which == "A":
    palette_b64 = base64.b64encode((ROOT / "tools/palette.png").read_bytes()).decode()
    for name in assets:
        body = {"contents": [{"parts": [
            {"text": RETRY[name] + NEG + " Palette limited to the attached 46 swatches."},
            {"inlineData": {"mimeType": "image/png", "data": palette_b64}}]}],
            "generationConfig": {"responseModalities": ["IMAGE"], "imageConfig": {"aspectRatio": "1:1"}}}
        dest = ROOT / "A-meowart" / f"raw2-{name}"
        dest.mkdir(parents=True, exist_ok=True)
        r = subprocess.run(["python3", "/Users/abab/.claude/skills/game-assets/meowart_api.py",
                            "--api-base", "https://api.meowa.ai", "gemini-post",
                            "--path", "v1beta/models/gemini-3-pro-image-preview:generateContent",
                            "--json-body", json.dumps(body), "--output-dir", str(dest)],
                           capture_output=True, text=True, timeout=600)
        (dest / "run.log").write_text(r.stdout[-3000:] + r.stderr[-1000:])
        print(f"[A2] {name} rc={r.returncode}", flush=True)
else:
    BASE = os.environ["TK1688_BASE_URL"].rstrip("/")
    KEY = os.environ["TK1688_API_KEY"]
    for name in assets:
        payload = {"model": "gemini-3-pro-image", "prompt": RETRY[name] + NEG, "n": 1}
        req = urllib.request.Request(BASE + "/v1/images/generations", data=json.dumps(payload).encode(),
                                     headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=300) as resp:
                data = json.loads(resp.read())
            item = data["data"][0]
            dest = ROOT / "C-gemini" / f"raw2-{name}.png"
            if item.get("b64_json"):
                dest.write_bytes(base64.b64decode(item["b64_json"]))
            else:
                urllib.request.urlretrieve(item["url"], dest)
            print(f"[C2] {name} OK", flush=True)
        except Exception as e:
            print(f"[C2] {name} FAIL {e}", flush=True)
