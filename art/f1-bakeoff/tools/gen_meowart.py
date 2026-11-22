# DEPS: base64, json, os, subprocess, sys, pathlib | prompts (ASSETS)
# RESPONSIBILITY: 来源A MeowArt 通用生图（nano banana），附 46 色色板参考图，三张素材各一次
# MODULE: f1-bakeoff.tools
# ---
import base64
import json
import os
import subprocess
import sys
from pathlib import Path

from prompts import ASSETS

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "A-meowart"
API = "/Users/abab/.claude/skills/game-assets/meowart_api.py"

palette_b64 = base64.b64encode((ROOT / "tools/palette.png").read_bytes()).decode()
log = []

for name, spec in ASSETS.items():
    body = {
        "contents": [{
            "parts": [
                {"text": spec["prompt"]},
                {"inlineData": {"mimeType": "image/png", "data": palette_b64}},
            ]
        }],
        "generationConfig": {"responseModalities": ["IMAGE"], "imageConfig": {"aspectRatio": "1:1"}},
    }
    dest = OUT / f"raw-{name}"
    dest.mkdir(parents=True, exist_ok=True)
    cmd = [
        "python3", API, "--api-base", "https://api.meowa.ai",
        "gemini-post", "--path", "v1beta/models/gemini-3-pro-image-preview:generateContent",
        "--json-body", json.dumps(body), "--output-dir", str(dest),
    ]
    print(f"[A] generating {name} ...", flush=True)
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=600,
                       env={**os.environ, "MEOWART_API_KEY": os.environ["MEOWART_API_KEY"]})
    (dest / "run.log").write_text(r.stdout[-4000:] + "\n---STDERR---\n" + r.stderr[-2000:])
    log.append({"asset": name, "rc": r.returncode})
    print(f"[A] {name} rc={r.returncode}", flush=True)

print(json.dumps(log))
