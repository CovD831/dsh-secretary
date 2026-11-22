#!/bin/bash
# 卸载 dsh-secretary，撤销受管的 workspace 配置，并与安装前备份比对。
# 用法：uninstall.sh [profile]   （默认 desktop）
set -euo pipefail

PROFILE="${1:-desktop}"
if [[ $# -gt 1 ]]; then
  echo "用法：$(basename "$0") [profile]" >&2
  exit 64
fi

DSH="${DSH_BIN:-/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh}"
PACKAGE_NAME='dsh-secretary'

die() { echo "错误：$*" >&2; exit 1; }

if [[ -n "${DSH_HOME:-}" && -n "${DSH_HOME//[[:space:]]/}" ]]; then
  HOME_DIR="${DSH_HOME/#\~/$HOME}"
else
  HOME_DIR="$HOME/.dsh"
fi
mkdir -p "$HOME_DIR"
HOME_DIR="$(cd "$HOME_DIR" && pwd -P)"
PROFILE_DIR="$HOME_DIR/profiles/$PROFILE"
[[ -f "$PROFILE_DIR/package.json" ]] || die "profile $PROFILE 不存在（缺少 $PROFILE_DIR/package.json）。"

if pgrep -f '/Contents/MacOS/DeepSeek Harness' >/dev/null 2>&1; then
  die "DeepSeek Harness 客户端正在运行；请先完全退出客户端再卸载。"
fi

# 找同一 DSH_HOME + profile 的最新备份。
BACKUP_ROOT="${DSH_SECRETARY_BACKUP_ROOT:-$HOME/Desktop/dsh-secretary/.local/desktop-backup}"
BACKUP=''
if [[ -d "$BACKUP_ROOT" ]]; then
  for manifest in "$BACKUP_ROOT"/*/manifest.env; do
    [[ -f "$manifest" ]] || continue
    if grep -qx "DSH_HOME=$HOME_DIR" "$manifest" && grep -qx "PROFILE=$PROFILE" "$manifest"; then
      BACKUP="$(dirname "$manifest")"
    fi
  done
fi
[[ -n "$BACKUP" ]] && echo "使用备份：$BACKUP" || echo "警告：未找到匹配备份，将只做无备份卸载。"

# 移除插件（仅在确实已安装时）。
INSTALLED=0
if grep -q "\"$PACKAGE_NAME\"" "$PROFILE_DIR/package.json"; then INSTALLED=1; fi
if [[ $INSTALLED -eq 1 ]]; then
  DSH_HOME="$HOME_DIR" "$DSH" plugin --profile "$PROFILE" remove "$PACKAGE_NAME"
  echo "已移除 $PACKAGE_NAME"
else
  echo "$PACKAGE_NAME 未出现在 profile 依赖中，跳过 remove。"
fi

# 精确移除受管配置块：优先恢复备份原文（仅在没有其他改动时）。
python3 -I - "$PROFILE_DIR/cordis.patch.yml" "${BACKUP:+$BACKUP/cordis.patch.yml}" <<'PY'
import os
import sys
path = sys.argv[1]
backup = sys.argv[2] if len(sys.argv) > 2 else ''
try:
    text = open(path, encoding='utf-8').read()
except FileNotFoundError:
    sys.exit(0)
begin = '# >>> dsh-secretary workspace (managed by scripts/desktop/install.sh)'
end = '# <<< dsh-secretary workspace (managed by scripts/desktop/install.sh)'
lines = text.splitlines(keepends=True)
start = next((i for i, line in enumerate(lines) if line.strip() == begin), None)
if start is None:
    print('未找到受管配置块，未修改 cordis.patch.yml。')
    sys.exit(0)
stop = next((i for i in range(start, len(lines)) if lines[i].strip() == end), None)
if stop is None:
    raise SystemExit('错误：受管配置块缺少结束标记，拒绝自动删除。')
remaining = ''.join(lines[:start] + lines[stop + 1:])
original = ''
if backup and os.path.exists(backup):
    original = open(backup, encoding='utf-8').read()
meaningful = '\n'.join(line for line in remaining.splitlines() if not line.lstrip().startswith('#')).strip()
if original and remaining.strip() == original.strip():
    open(path, 'w', encoding='utf-8').write(original)
    print('已精确恢复 cordis.patch.yml 备份原文。')
elif meaningful == '':
    open(path, 'w', encoding='utf-8').write(original if original else '[]\n')
    print('受管配置块已移除，文件已恢复为备份原文（或空数组）。')
else:
    open(path, 'w', encoding='utf-8').write(remaining.rstrip() + '\n')
    print('已移除受管配置块；保留其他配置。')
PY

# 移除演练用的镜像 profile（只删 manifest 明确记录的那一个）。
if [[ -n "$BACKUP" && -f "$BACKUP/manifest.env" ]]; then
  MIRROR="$(grep -E '^MIRROR=' "$BACKUP/manifest.env" | tail -n 1 | cut -d= -f2- || true)"
  if [[ -n "$MIRROR" && -f "$MIRROR/package.json" && "$MIRROR" == "$HOME_DIR/profiles/desktop-verify-"* ]]; then
    rm -rf "$MIRROR"
    echo "已移除验证镜像：$MIRROR"
  fi
fi

# 断言：插件项与受管块均不存在。
python3 -I - "$PROFILE_DIR/package.json" <<'PY'
import json, sys
manifest = json.load(open(sys.argv[1], encoding='utf-8'))
deps = manifest.get('dependencies') or {}
bundles = ((manifest.get('dsh') or {}).get('profile') or {}).get('bundles') or []
assert 'dsh-secretary' not in deps, '依赖中仍有 dsh-secretary'
assert 'dsh-secretary' not in bundles, 'bundles 中仍有 dsh-secretary'
PY
if grep -q 'id: dsh-secretary' "$PROFILE_DIR/cordis.patch.yml"; then
  die "cordis.patch.yml 仍含 dsh-secretary 行。"
fi

# 与备份比对并报告差异。
echo
echo '=== 与安装前备份比对 ==='
if [[ -z "$BACKUP" ]]; then
  echo '无备份，无法比对。'
  exit 0
fi
DIFF_FILES=0
for file in package.json cordis.patch.yml pnpm-lock.yaml package-lock.json npm-shrinkwrap.json yarn.lock; do
  if [[ -f "$PROFILE_DIR/$file" && ! -f "$BACKUP/$file" ]]; then
    if [[ "$file" == 'pnpm-lock.yaml' ]] && ! grep -q '^packages:' "$PROFILE_DIR/$file" \
      && ! grep -q 'dsh-secretary' "$PROFILE_DIR/$file" && grep -q '^  \.: {}$' "$PROFILE_DIR/$file"; then
      rm -f "$PROFILE_DIR/$file"
      echo "[$file] 备份中不存在且已是空 lockfile，已删除。"
    else
      echo "[$file] 当前新增（备份中不存在），保留。"
      DIFF_FILES=$((DIFF_FILES + 1))
    fi
  elif [[ -f "$BACKUP/$file" ]]; then
    if [[ ! -f "$PROFILE_DIR/$file" ]]; then
      echo "[$file] 当前不存在（备份中存在）"
      DIFF_FILES=$((DIFF_FILES + 1))
    elif ! cmp -s "$BACKUP/$file" "$PROFILE_DIR/$file"; then
      echo "--- [$file] 差异 ---"
      diff -u "$BACKUP/$file" "$PROFILE_DIR/$file" || true
      DIFF_FILES=$((DIFF_FILES + 1))
    fi
  fi
done
if [[ $DIFF_FILES -eq 0 ]]; then
  echo '所有备份文件逐字节一致。'
else
  echo "共有 $DIFF_FILES 个备份文件存在差异；请确认差异仅来自宿主默认项（如空 dependencies）或安装后的用户改动。"
fi
echo '插件项、bundle 项与受管配置块均已清除。'
