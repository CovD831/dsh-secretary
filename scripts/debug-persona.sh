#!/bin/bash
# 在全新隔离 home 中用真实模型检查秘书人设；不调用生产安装脚本，不写真实 ~/.dsh。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH="${DSH_BIN:-/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh}"
DEBUG_HOME="$ROOT/.local/debug-home"
SOURCE_HOME="${DSH_SECRETARY_CREDENTIAL_HOME:-$HOME/.dsh}"
PROFILE='persona-debug'
WORKSPACE_CWD="${DSH_SECRETARY_WORKSPACE_CWD:-$HOME/Desktop/dsh-secretary-dogfood}"
OUT="$DEBUG_HOME/report"
STARTED_AT="$(date +%s)"
web_pid=''

fail() { echo "错误：$*" >&2; exit 1; }
cleanup() {
  rc=$?
  trap - EXIT INT TERM
  if [[ -n "$web_pid" ]]; then
    kill -TERM "$web_pid" 2>/dev/null || true
    wait "$web_pid" 2>/dev/null || true
    echo "已停止隔离 web 进程（PID $web_pid）。"
  fi
  exit "$rc"
}
trap cleanup EXIT INT TERM

[[ "$DEBUG_HOME" == "$ROOT/.local/debug-home" ]] || fail '隔离 home 路径断言失败。'
[[ -x "$DSH" ]] || fail "找不到 dsh：$DSH"
[[ -f "$SOURCE_HOME/profiles/desktop/cordis.patch.yml" ]] || fail '缺少 desktop 模型配置。'
[[ -f "$SOURCE_HOME/.credentials.yaml" ]] || fail '缺少模型凭据文件；不会要求或输出凭据值。'
[[ -d "$WORKSPACE_CWD" ]] || fail "工作区不存在：$WORKSPACE_CWD"
[[ "$ROOT" != "$SOURCE_HOME/"* ]] || fail '仓库不得位于真实 DSH home 内。'

# 保留完整树快照，不只保留根目录 mtime（写子文件不会改变根目录 mtime）。
python3 -I - "$SOURCE_HOME" "$ROOT/.local" <<'PY'
import json, os, sys
from pathlib import Path
home, parent = map(Path, sys.argv[1:])
parent.mkdir(parents=True, exist_ok=True)
rows = []
for root, dirs, files in os.walk(home):
    dirs.sort(); files.sort()
    for name in dirs + files:
        path = Path(root) / name
        info = path.lstat()
        rows.append([str(path.relative_to(home)), info.st_mode, info.st_size, info.st_mtime_ns])
(parent / 'debug-persona-dsh-before.json').write_text(json.dumps(rows, ensure_ascii=False))
PY

rm -rf "$DEBUG_HOME"
mkdir -p "$OUT" "$ROOT/.local/packages"
export DSH_HOME="$DEBUG_HOME"
[[ "$DSH_HOME" != "$SOURCE_HOME" ]] || fail 'DSH_HOME 未隔离。'

# 只派生 web 骨架；desktop 是 CLI 保留 profile，不能直接派生。
"$DSH" --profile "$PROFILE" --from-default-profile web --dump-config \
  > "$OUT/base-config.yml" 2> "$OUT/base.stderr.log"

# 仅继承模型提供方、默认模型和模型白名单；不继承 desktop 的其他插件。
python3 -I - "$SOURCE_HOME/profiles/desktop/cordis.patch.yml" "$DEBUG_HOME/profiles/$PROFILE/cordis.patch.yml" "$WORKSPACE_CWD" <<'PY'
import sys
source, target, cwd = sys.argv[1:]
text = open(source, encoding='utf-8').read()
blocks = text.split('\n- ')
blocks = [blocks[0]] + ['- ' + block for block in blocks[1:]]
selected = []
for block in blocks:
    if '\n    providers:' in block or '\n    provider:' in block and '\n    model:' in block or '\n    allowedModels:' in block:
        selected.append(block.rstrip())
if not any('\n    providers:' in block for block in selected):
    raise SystemExit('desktop patch 中没有模型提供方配置。')
if not any('\n    provider:' in block and '\n    model:' in block for block in selected):
    raise SystemExit('desktop patch 中没有默认模型配置。')
selected.append(f'- id: dsh-secretary\n  config:\n    workspace:\n      id: debug\n      cwd: {cwd}')
with open(target, 'w', encoding='utf-8') as file:
    file.write('\n'.join(selected) + '\n')
print(f'已继承 {len(selected) - 1} 个模型配置块；未继承其他 desktop 插件。')
PY

# 原子写通过 rename 替换 inode，因此隔离 home 的写不会落到源文件。
# 硬链接不复制、不打印凭据值；之后用 stat 校验源文件身份及全树快照。
ln "$SOURCE_HOME/.credentials.yaml" "$DEBUG_HOME/.credentials.yaml"
chmod 600 "$DEBUG_HOME/.credentials.yaml"

(
  cd "$ROOT"
  npm run build
  npm pack --pack-destination "$ROOT/.local/packages"
) > "$OUT/build-pack.log" 2>&1
TGZ_NAME="$(tail -n 1 "$OUT/build-pack.log")"
TGZ="$ROOT/.local/packages/$TGZ_NAME"
[[ -f "$TGZ" ]] || fail "npm pack 未生成 $TGZ"
"$DSH" plugin --profile "$PROFILE" add "$TGZ" > "$OUT/install.log" 2>&1
python3 -I - "$TGZ" <<'PY'
import sys, tarfile
with tarfile.open(sys.argv[1]) as pack:
    assert any(name.endswith('/prompts/secretary.md') for name in pack.getnames()), '包内缺少人设文件'
PY

PORT="$(python3 -I - <<'PY'
import socket
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    print(sock.getsockname()[1])
PY
)"
"$DSH" --profile "$PROFILE" --host 127.0.0.1 --port "$PORT" --no-open \
  > "$OUT/web.stdout.log" 2> "$OUT/web.stderr.log" &
web_pid=$!

# 用启动 token 换 cookie，再经正式 HTTP Remote API 创建、提示和读取真实会话。
node - "$PORT" "$web_pid" "$OUT" "$WORKSPACE_CWD" <<'JS'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
const [port, pid, out, cwd] = process.argv.slice(2)
const base = `http://127.0.0.1:${port}`
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const speechTools = new Set(['secretary_say', 'secretary_ask', 'secretary_handover'])
const messages = ['你好', '介绍一下你自己', '帮我查一下 dsh-secretary 仓库现在有多少个测试通过']
let cookie = ''

async function waitForWeb() {
  for (let count = 0; count < 240; count++) {
    try { process.kill(Number(pid), 0) } catch { throw new Error('web 在就绪前退出。') }
    const text = fs.readFileSync(`${out}/web.stdout.log`, 'utf8')
    const match = text.match(/^dsh web: (http:\/\/[^\s]+)$/m)
    if (match) {
      const response = await fetch(match[1], { redirect: 'manual' })
      const setCookie = response.headers.get('set-cookie')
      if (![301, 302, 303, 307, 308].includes(response.status) || !setCookie) throw new Error('启动 token 未能换取认证 cookie。')
      cookie = setCookie.split(';', 1)[0]
      return
    }
    await sleep(250)
  }
  throw new Error('web 未在 60 秒内输出启动地址。')
}

async function rpc(method, request = {}) {
  const endpoint = method.replace('.', '/')
  const response = await fetch(`${base}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: endpoint, payload: { args: { request } } }),
  })
  if (!response.ok) throw new Error(`${method} HTTP ${response.status}`)
  const envelope = await response.json()
  if (envelope.type !== 'server-response' || !envelope.result?.ok) {
    throw new Error(`${method} 失败：${JSON.stringify(envelope.result?.error ?? envelope)}`)
  }
  return envelope.result.value
}

async function readAll(sessionId) {
  const address = { kind: 'session', sessionId }
  const first = await rpc('session.events', { address, maxMessages: 500 })
  const records = [...first.records]
  let hasMore = first.hasMore
  while (hasMore) {
    const beforeSeq = Math.min(...records.map(record => record.event.seq))
    const page = await rpc('session.events', { address, beforeSeq, maxMessages: 500 })
    records.unshift(...page.records)
    hasMore = page.hasMore
  }
  const unique = new Map(records.map(record => [record.event.seq, record.event]))
  return [...unique.values()].sort((a, b) => a.seq - b.seq)
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(part => part?.type === 'text').map(part => part.text ?? '').join('')
}

function callsOf(event) {
  const data = event.data ?? {}
  const candidates = [data.message, data, data.call].filter(Boolean)
  for (const candidate of candidates) {
    const content = candidate.content
    if (Array.isArray(content)) {
      const calls = content.filter(part => part?.type === 'tool-call' || part?.type === 'tool_call')
      if (calls.length) return calls.map(call => ({
        name: call.name ?? call.toolName,
        arguments: typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments ?? call.input ?? {},
      }))
    }
    if (candidate.name || candidate.toolName) return [{
      name: candidate.name ?? candidate.toolName,
      arguments: typeof candidate.arguments === 'string' ? JSON.parse(candidate.arguments) : candidate.arguments ?? {},
    }]
  }
  return []
}

function assess(message, events) {
  const calls = events.filter(event => event.type === 'tool/call').flatMap(callsOf)
  const speech = calls.filter(call => speechTools.has(call.name))
  const assistantText = events.filter(event => event.type === 'assistant/message')
    .map(event => textOf(event.data?.message?.content ?? event.data?.content)).filter(text => text.trim())
  const errors = []
  if (!speech.length) errors.push('未调用说话工具')
  if (assistantText.length) errors.push('存在自由文本')
  if (speech.length && speech.at(-1).name !== speech[0].name) errors.push('多个说话工具结果不一致')
  for (const call of speech) {
    if (call.name === 'secretary_say' && [...String(call.arguments.line ?? '')].length > 40) errors.push('say 超过 40 字')
    if (call.name === 'secretary_ask') {
      const options = call.arguments.options
      if (!Array.isArray(options) || options.length < 1 || options.length > 3) errors.push('ask 选项数应为 1–3')
      else if (!options.some(option => option.recommended === true)) errors.push('ask 缺少推荐项')
    }
    if (call.name === 'secretary_handover') {
      const args = call.arguments
      if (!args.conclusion || !args.reason || !args.impact) errors.push('handover 缺少结论、理由或影响')
    }
  }
  if (message.startsWith('帮我查')) {
    const dispatch = calls.find(call => call.name === 'secretary_dispatch')
    if (!dispatch) errors.push('未派发测试查询')
    else {
      if (!/测试/.test(dispatch.arguments.task ?? '')) errors.push('派发任务缺少测试目标')
      if (!dispatch.arguments.acceptance) errors.push('派发缺少验收标准')
      if (!dispatch.arguments.dispatchKey) errors.push('派发缺少 dispatchKey')
    }
  }
  return { message, speech: speech.map(call => ({ name: call.name, arguments: call.arguments })),
    freeText: assistantText, allCalls: calls.map(call => call.name), errors, pass: errors.length === 0 }
}

await waitForWeb()
const created = await rpc('session.create', { cwd, agentPreset: 'secretary' })
const sessionId = created.sessionId
fs.writeFileSync(`${out}/session.json`, JSON.stringify({ sessionId, preset: 'secretary', model: '继承 desktop 配置（值不输出）' }, null, 2))
const reports = []
let previousSeq = -1
for (const message of messages) {
  console.log(`发送：${message}`)
  const receipt = await rpc('session.prompt', {
    requestId: `persona-${randomUUID()}`, sessionId, mode: 'queue', content: [{ type: 'text', text: message }],
  })
  if (!receipt.accepted) throw new Error('消息未被会话接受。')
  const deadline = Date.now() + 180000
  let events = []
  let turnEnd
  while (Date.now() < deadline) {
    events = (await readAll(sessionId)).filter(event => event.seq > previousSeq)
    turnEnd = events.find(event => event.type === 'turn/end')
    if (turnEnd) break
    await sleep(1000)
  }
  if (!turnEnd) throw new Error(`等待「${message}」响应超时。`)
  const report = assess(message, events)
  reports.push(report)
  previousSeq = Math.max(...events.map(event => event.seq))
  console.log(`${report.pass ? 'PASS' : 'FAIL'}｜说话工具：${report.speech.map(call => call.name).join(', ') || '无'}｜自由文本：${report.freeText.length ? '有' : '无'}${report.errors.length ? `｜${report.errors.join('；')}` : ''}`)
  if (!report.pass) console.log('已记录人设失败；继续发送下一条，收集完整报告。')
}
fs.writeFileSync(`${out}/session-events.json`, JSON.stringify(await readAll(sessionId), null, 2))
fs.writeFileSync(`${out}/persona-report.json`, JSON.stringify({ sessionId, reports, passed: reports.every(report => report.pass) }, null, 2))
JS

kill -TERM "$web_pid"
wait "$web_pid" 2>/dev/null || true
web_pid=''
grep -q 'dsh-secretary 已激活' "$OUT/web.stdout.log"

python3 -I - "$SOURCE_HOME" "$ROOT/.local/debug-persona-dsh-before.json" "$OUT/home-stat.txt" "$STARTED_AT" <<'PY'
import json, os, sys, time
from pathlib import Path
home, before_path, out, started = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]), int(sys.argv[4])
before = json.loads(before_path.read_text())
rows = []
for root, dirs, files in os.walk(home):
    dirs.sort(); files.sort()
    for name in dirs + files:
        path = Path(root) / name
        info = path.lstat()
        rows.append([str(path.relative_to(home)), info.st_mode, info.st_size, info.st_mtime_ns])
credential = (home / '.credentials.yaml').stat()
report = [f'隔离 DSH_HOME：{Path.home() / "Desktop/dsh-secretary/.local/debug-home"}',
          f'真实 home：{home}', f'运行前全树 stat 条目：{len(before)}', f'运行后全树 stat 条目：{len(rows)}',
          f'全树路径/mode/size/mtime_ns 完全一致：{rows == before}',
          f'凭据 inode={credential.st_ino} mtime_ns={credential.st_mtime_ns}',
          f'耗时：{int(time.time()) - started} 秒']
out.write_text('\n'.join(report) + '\n')
print('\n'.join(report))
if rows != before:
    raise SystemExit('真实 ~/.dsh 的 stat 快照发生变化。')
PY
printf '脚本运行完成；人设是否通过请看上方各条 PASS/FAIL。报告：%s\n' "$OUT/persona-report.json"
