# DEPS: base64, json, os, sys, urllib.request, pathlib | prompts (ASSETS)
# RESPONSIBILITY: 来源B/C tk1688 生图（images/generations 优先，回退 chat/completions 多模态），每素材最多 2 次
# MODULE: f1-bakeoff.tools
# ---
import base64
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

from prompts import ASSETS

ROOT = Path(__file__).resolve().parent.parent
MODEL = sys.argv[1]           # gpt-image-2.6 | gemini-3-pro-image
OUTDIR = sys.argv[2]          # B-gpt-image | C-gemini
BASE = os.environ["TK1688_BASE_URL"].rstrip("/")
KEY = os.environ["TK1688_API_KEY"]
OUT = ROOT / OUTDIR
OUT.mkdir(parents=True, exist_ok=True)
LOG = OUT / "calls.jsonl"


def post(path, payload, timeout=300):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return e.code, {"error": e.read().decode()[:500]}


def save_b64(b64, path):
    path.write_bytes(base64.b64decode(b64))
    return True


def try_images(prompt, dest):
    payload = {"model": MODEL, "prompt": prompt, "n": 1, "size": "1024x1024"}
    if MODEL.startswith("gemini"):
        payload = {"model": MODEL, "prompt": prompt, "n": 1}
    status, data = post("/v1/images/generations", payload)
    with LOG.open("a") as f:
        f.write(json.dumps({"api": "images", "model": MODEL, "status": status,
                            "keys": list(data.keys())}) + "\n")
    if status == 200:
        item = (data.get("data") or [{}])[0]
        if item.get("b64_json"):
            return save_b64(item["b64_json"], dest)
        if item.get("url"):
            urllib.request.urlretrieve(item["url"], dest)
            return True
    return False


def try_chat(prompt, dest):
    payload = {"model": MODEL, "messages": [{"role": "user", "content": prompt}],
               "modalities": ["text", "image"]}
    status, data = post("/v1/chat/completions", payload)
    with LOG.open("a") as f:
        f.write(json.dumps({"api": "chat", "model": MODEL, "status": status,
                            "keys": list(data.keys())}) + "\n")
    if status != 200:
        return False
    msg = (data.get("choices") or [{}])[0].get("message", {})
    # 多模态图片可能在 message.images 或 content 里
    for img in msg.get("images") or []:
        url = img.get("image_url", {}).get("url", "")
        if url.startswith("data:"):
            return save_b64(url.split(",", 1)[1], dest)
        if url:
            urllib.request.urlretrieve(url, dest)
            return True
    content = msg.get("content")
    if isinstance(content, list):
        for part in content:
            if part.get("type") == "image_url":
                url = part["image_url"]["url"]
                if url.startswith("data:"):
                    return save_b64(url.split(",", 1)[1], dest)
                urllib.request.urlretrieve(url, dest)
                return True
    return False


results = {}
for name, spec in ASSETS.items():
    dest = OUT / f"raw-{name}.png"
    prompt = spec["prompt"] + " Output exactly one square image with the single asset on a transparent background."
    ok = False
    for attempt in (1, 2):
        if try_images(prompt, dest) or try_chat(prompt, dest):
            ok = True
            break
        print(f"[{OUTDIR}] {name} attempt {attempt} failed", flush=True)
    results[name] = ok
    print(f"[{OUTDIR}] {name}: {'OK' if ok else 'FAILED'}", flush=True)

print(json.dumps(results))
