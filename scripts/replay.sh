#!/bin/bash
# 在独立 home 中复跑正式安装、无模型原生轮次、事件日志、client 与卸载。
set -euo pipefail
ROOT='/Users/abab/Desktop/dsh-secretary'
RUN_ID="$(date +%s)-$$"
export DSH_HOME="$ROOT/.local/home"
DSH='/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
OUT="$ROOT/.local/evidence"
PROFILE='secretary-replay'
PORT="${DSH_SECRETARY_PORT:-43215}"
DEFAULT_PORT="${DSH_SECRETARY_DEFAULT_PORT:-43216}"
PACK="$ROOT/.local/dsh-secretary-$RUN_ID.tgz"
RUN_ID="$(basename "$PACK" .tgz)"
PACK="$ROOT/.local/dsh-secretary-$RUN_ID.tgz"
DEFAULT_HOME="$ROOT/.local/default-home-$RUN_ID"
DEFAULT_OUT="$DEFAULT_HOME/.dsh/evidence-default-home"
web_pid=''
installed=false
cleanup() {
  if [[ -n "$web_pid" ]]; then
    kill -TERM "$web_pid" 2>/dev/null || true
    wait "$web_pid" 2>/dev/null || true
  fi
  if [[ "$installed" = true ]]; then
    "$DSH" plugin --profile "$PROFILE" remove dsh-secretary > "$OUT/remove.stdout.log" 2> "$OUT/remove.stderr.log" || true
  fi
  if [[ "${default_installed:-false}" = true ]]; then
    env -u DSH_HOME HOME="$DEFAULT_HOME" "$DSH" plugin --profile "$PROFILE" remove dsh-secretary > "$DEFAULT_OUT/remove.stdout.log" 2> "$DEFAULT_OUT/remove.stderr.log" || true
  fi
}
trap cleanup EXIT INT TERM
test "$DSH_HOME" = "$ROOT/.local/home"
mkdir -p "$OUT" "$DSH_HOME/evidence" "$ROOT/.local/packages"
python3 -I - "$DSH_HOME/evidence/tools-view.json" <<'PY'
from pathlib import Path
import sys
Path(sys.argv[1]).unlink(missing_ok=True)
PY
"$DSH" plugin --profile "$PROFILE" remove dsh-secretary > "$OUT/reset.stdout.log" 2> "$OUT/reset.stderr.log" || true
npm --prefix "$ROOT" run typecheck
npm --prefix "$ROOT" test
npm pack "$ROOT" --pack-destination "$ROOT/.local/packages" > /dev/null
cp "$ROOT/.local/packages/dsh-secretary-0.1.0.tgz" "$PACK"
! tar -tzf "$PACK" | grep -q 'dist/agent.js'
! tar -xOf "$PACK" package/dist/client.js | grep -Eq '^import |^export '
"$DSH" --profile "$PROFILE" --from-default-profile web --dump-config > "$OUT/base.yml" 2> "$OUT/base.stderr.log"
python3 -I - "$DSH_HOME/profiles/$PROFILE/cordis.patch.yml" "$DSH_HOME/evidence" <<'PY'
import sys
path, out = sys.argv[1:]
with open(path, 'w') as file:
    file.write(f'- id: dsh-secretary\n  config:\n    selfTestDirectory: {out}\n')
PY
"$DSH" plugin --profile "$PROFILE" add "$PACK" > "$OUT/install.stdout.log" 2> "$OUT/install.stderr.log"
installed=true
cp "$DSH_HOME/profiles/$PROFILE/cordis.patch.yml" "$OUT/patch.before.yml"
"$DSH" --profile "$PROFILE" --host 127.0.0.1 --port "$PORT" --no-open > "$OUT/web.stdout.log" 2> "$OUT/web.stderr.log" &
web_pid=$!
node - "$PORT" "$web_pid" <<'JS'
const [port, pid] = process.argv.slice(2)
const delay = () => new Promise(resolve => setTimeout(resolve, 250))
for (let count = 0; count < 120; count++) {
  try { process.kill(Number(pid), 0) } catch { throw new Error('Web 在就绪前退出。') }
  try { if ((await fetch(`http://127.0.0.1:${port}/`)).status === 401) process.exit(0) } catch {}
  await delay()
}
throw new Error('Web 未在 30 秒内就绪。')
JS
for unused in $(seq 1 120); do
  test -f "$DSH_HOME/evidence/tools-view.json" && break
  sleep 0.25
done
test -f "$DSH_HOME/evidence/tools-view.json"
cp "$DSH_HOME/evidence/tools-view.json" "$OUT/tools-view.json"
! grep -q '秘书无模型自检失败' "$OUT/web.stdout.log"
! grep -q '秘书无模型自检失败' "$OUT/web.stderr.log"
grep -q 'dsh-secretary 已激活' "$OUT/web.stdout.log"
node "$ROOT/scripts/browser-check.mjs" "$OUT"
kill -TERM "$web_pid"
wait "$web_pid"
web_pid=''
node - "$OUT" <<'JS'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const out = process.argv[2]
const tools = JSON.parse(fs.readFileSync(`${out}/tools-view.json`, 'utf8'))
assert.deepEqual(tools.tools, ['secretary_say'])
assert.equal(tools.result.type, 'tool/result')
const events = fs.readFileSync(`${process.env.DSH_HOME}/plugins/dsh-secretary/event-log/events.jsonl`, 'utf8').trim().split('\n').map(JSON.parse)
for (const event of events) {
  assert.equal(event.v, '0')
  for (const key of ['id', 'ts', 'kind', 'sessionId', 'workspaceId', 'source', 'causedBy', 'payload']) assert.ok(Object.hasOwn(event, key))
  assert.ok(['dsh', 'plugin'].includes(event.source))
  assert.equal(typeof event.payload, 'object')
  assert.ok(Number.isFinite(Date.parse(event.ts)))
}
const kinds = new Set(events.map(event => event.kind))
for (const kind of ['dsh.session', 'dsh.tool', 'dsh.agent-status', 'secretary.say']) assert.ok(kinds.has(kind), `缺少 ${kind}`)
const say = events.find(event => event.kind === 'secretary.say')
assert.equal(say.payload.text, '骨架已就位。')
assert.equal(say.payload.mood, 'happy')
assert.ok(events.some(event => event.kind === 'dsh.agent-status' && event.payload.status === 'running'))
assert.ok(events.some(event => event.kind === 'dsh.agent-status' && event.payload.status === 'idle'))
assert.equal(new Set(events.map(event => event.id)).size, events.length)
fs.writeFileSync(`${out}/assertions.json`, `${JSON.stringify({ tools: tools.tools, kinds: [...kinds].sort(), eventCount: events.length }, null, 2)}\n`)
console.log('真实激活、唯一工具、原生轮次、四类事件、v0 信封及幂等 id 均通过断言。')
JS
"$DSH" plugin --profile "$PROFILE" remove dsh-secretary > "$OUT/remove.stdout.log" 2> "$OUT/remove.stderr.log"
installed=false
! grep -q 'name: dsh-secretary' "$DSH_HOME/profiles/$PROFILE/cordis.patch.yml"
! grep -q 'name: dsh-secretary' "$DSH_HOME/profiles/$PROFILE/cordis.yml"

mkdir -p "$DEFAULT_OUT"
env -u DSH_HOME HOME="$DEFAULT_HOME" "$DSH" --profile "$PROFILE" --from-default-profile web --dump-config > "$DEFAULT_OUT/base.yml" 2> "$DEFAULT_OUT/base.stderr.log"
python3 -I - "$DEFAULT_HOME/.dsh/profiles/$PROFILE/cordis.patch.yml" "$DEFAULT_OUT" <<'PY'
import sys
path, out = sys.argv[1:]
with open(path, 'w') as file:
    file.write(f'- id: dsh-secretary\n  config:\n    selfTestDirectory: {out}\n')
PY
env -u DSH_HOME HOME="$DEFAULT_HOME" "$DSH" plugin --profile "$PROFILE" add "$PACK" > "$DEFAULT_OUT/install.stdout.log" 2> "$DEFAULT_OUT/install.stderr.log"
default_installed=true
env -u DSH_HOME HOME="$DEFAULT_HOME" "$DSH" --profile "$PROFILE" --host 127.0.0.1 --port "$DEFAULT_PORT" --no-open > "$DEFAULT_OUT/web.stdout.log" 2> "$DEFAULT_OUT/web.stderr.log" &
web_pid=$!
node - "$DEFAULT_PORT" "$web_pid" <<'JS'
const [port, pid] = process.argv.slice(2)
const delay = () => new Promise(resolve => setTimeout(resolve, 250))
for (let count = 0; count < 120; count++) {
  try { process.kill(Number(pid), 0) } catch { throw new Error('默认 home Web 在就绪前退出。') }
  try { if ((await fetch(`http://127.0.0.1:${port}/`)).status === 401) process.exit(0) } catch {}
  await delay()
}
throw new Error('默认 home Web 未在 30 秒内就绪。')
JS
for unused in $(seq 1 120); do
  test -f "$DEFAULT_OUT/tools-view.json" && break
  sleep 0.25
done
test -f "$DEFAULT_OUT/tools-view.json"
kill -TERM "$web_pid"
wait "$web_pid"
web_pid=''
grep -q 'dsh-secretary 已激活' "$DEFAULT_OUT/web.stdout.log"
test ! -s "$DEFAULT_OUT/web.stderr.log"
test -f "$DEFAULT_HOME/.dsh/plugins/dsh-secretary/event-log/events.jsonl"
node -e 'const fs = require("node:fs"); const path = process.argv[1]; const lines = fs.readFileSync(path, "utf8").trim().split("\n"); for (const line of lines) { const event = JSON.parse(line); if (event.v !== "0") process.exit(1) } console.log(`默认 home 日志事件数：${lines.length}`)' "$DEFAULT_HOME/.dsh/plugins/dsh-secretary/event-log/events.jsonl"
env -u DSH_HOME HOME="$DEFAULT_HOME" "$DSH" plugin --profile "$PROFILE" remove dsh-secretary > "$DEFAULT_OUT/remove.stdout.log" 2> "$DEFAULT_OUT/remove.stderr.log"
default_installed=false
printf '无 DSH_HOME 启动通过；日志落在临时 HOME 的 .dsh 下。\n'
printf '复跑通过；证据位于 %s。\n' "$OUT"
