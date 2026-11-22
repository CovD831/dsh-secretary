#!/bin/bash
# 把 dsh-secretary 正式安装进指定 DSH profile，并写入 workspace 配置。
# 用法：install.sh [profile]   （默认 desktop）
# 仅写 DSH_HOME 指向的 profile；所有中间产物在仓库 .local/ 下。
set -euo pipefail

PROFILE="${1:-desktop}"
if [[ $# -gt 1 ]]; then
  echo "用法：$(basename "$0") [profile]" >&2
  exit 64
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DSH="${DSH_BIN:-/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh}"
PACKAGE_NAME='dsh-secretary'
WORKSPACE_ID="${DSH_SECRETARY_WORKSPACE_ID:-dogfood}"
WORKSPACE_CWD="${DSH_SECRETARY_WORKSPACE_CWD:-/Users/abab/Desktop/dsh-secretary-dogfood}"

die() { echo "错误：$*" >&2; exit 1; }

# 与宿主 resolveDshHome 一致：DSH_HOME 非空（去空白）优先，否则 ~/.dsh；支持 ~ 前缀。
if [[ -n "${DSH_HOME:-}" && -n "${DSH_HOME//[[:space:]]/}" ]]; then
  HOME_DIR="${DSH_HOME/#\~/$HOME}"
else
  HOME_DIR="$HOME/.dsh"
fi
mkdir -p "$HOME_DIR"
HOME_DIR="$(cd "$HOME_DIR" && pwd -P)"
PROFILE_DIR="$HOME_DIR/profiles/$PROFILE"
[[ -f "$PROFILE_DIR/package.json" ]] || die "profile $PROFILE 未初始化（缺少 $PROFILE_DIR/package.json）。desktop 必须先启动一次客户端。"

# ① 客户端运行中则退出。
if pgrep -f '/Contents/MacOS/DeepSeek Harness' >/dev/null 2>&1; then
  die "DeepSeek Harness 客户端正在运行；请先完全退出客户端再安装。"
fi

# ② 备份非凭据文件。
TS="$(date +%Y%m%d-%H%M%S)"
BACKUP_ROOT="${DSH_SECRETARY_BACKUP_ROOT:-$HOME/Desktop/dsh-secretary/.local/desktop-backup}"
BACKUP="$BACKUP_ROOT/$TS-$PROFILE"
mkdir -p "$BACKUP"
BACKED_UP=()
for file in package.json cordis.patch.yml pnpm-lock.yaml package-lock.json npm-shrinkwrap.json yarn.lock; do
  if [[ -f "$PROFILE_DIR/$file" ]]; then
    cp -p "$PROFILE_DIR/$file" "$BACKUP/$file"
    BACKED_UP+=("$file")
  fi
done
if [[ ${#BACKED_UP[@]} -gt 0 ]]; then
  (cd "$PROFILE_DIR" && shasum -a 256 "${BACKED_UP[@]}" > "$BACKUP/SHA256SUMS")
fi
cat > "$BACKUP/manifest.env" <<EOF
DSH_HOME=$HOME_DIR
PROFILE=$PROFILE
CREATED=$TS
PACKAGE=$PACKAGE_NAME
BACKUP=$BACKUP
EOF
echo "已备份到 $BACKUP"

# ③ 构建并打包。
mkdir -p "$ROOT/.local/packages"
( cd "$ROOT" && npm run build )
( cd "$ROOT" && npm run typecheck )
TGZ_NAME="$(cd "$ROOT" && npm pack --pack-destination "$ROOT/.local/packages" | tail -n 1)"
TGZ="$ROOT/.local/packages/$TGZ_NAME"
[[ -f "$TGZ" ]] || die "npm pack 未生成 $TGZ"
TGZ="$(cd "$(dirname "$TGZ")" && pwd -P)/$(basename "$TGZ")"
echo "已打包：$TGZ"

# ④ 正式安装。
DSH_HOME="$HOME_DIR" "$DSH" plugin --profile "$PROFILE" add "$TGZ"

# ⑤ 在 profile 的 cordis.patch.yml 追加按 id 的配置 patch。
#    注意：宿主按 id 的 patch 会整段替换 config，不做深合并。
python3 -I - "$PROFILE_DIR/cordis.patch.yml" "$WORKSPACE_ID" "$WORKSPACE_CWD" <<'PY'
import sys
path, workspace_id, cwd = sys.argv[1:]
begin = '# >>> dsh-secretary workspace (managed by scripts/desktop/install.sh)'
end = '# <<< dsh-secretary workspace (managed by scripts/desktop/install.sh)'
block = f'''{begin}
- id: dsh-secretary
  config:
    workspace:
      id: {workspace_id}
      cwd: {cwd}
{end}
'''
try:
    text = open(path, encoding='utf-8').read()
except FileNotFoundError:
    text = ''
meaningful = '\n'.join(line for line in text.splitlines() if not line.lstrip().startswith('#')).strip()
if begin in text:
    raise SystemExit('错误：cordis.patch.yml 已存在受管配置块，拒绝重复写入。')
if meaningful in ('', '[]'):
    result = block
else:
    result = text.rstrip('\n') + '\n\n' + block
open(path, 'w', encoding='utf-8').write(result)
PY
echo "已写入 workspace 配置：$WORKSPACE_ID -> $WORKSPACE_CWD"

# ⑥ --dump-config 验证。desktop 是 CLI 保留 profile，不能直接 dump；
#    用同一 package.json/patch 的临时镜像 profile 验证（不写真实 profile）。
if [[ "$PROFILE" == 'desktop' ]]; then
  if [[ "${DSH_SECRETARY_KEEP_VERIFY:-0}" == '1' ]]; then
    DUMP_HOME="$HOME_DIR"
    MIRROR="desktop-verify-$TS"
  else
    DUMP_HOME="$(mktemp -d)"
    MIRROR='desktop-verify'
  fi
  MIRROR_DIR="$DUMP_HOME/profiles/$MIRROR"
  mkdir -p "$MIRROR_DIR"
  cp "$PROFILE_DIR/package.json" "$PROFILE_DIR/cordis.patch.yml" "$MIRROR_DIR/"
  [[ -f "$PROFILE_DIR/pnpm-workspace.yaml" ]] && cp "$PROFILE_DIR/pnpm-workspace.yaml" "$MIRROR_DIR/"
  if [[ "$DUMP_HOME" == "$HOME_DIR" ]]; then
    [[ -d "$PROFILE_DIR/node_modules" ]] && ln -s ../desktop/node_modules "$MIRROR_DIR/node_modules"
    printf 'MIRROR=%s\n' "$MIRROR_DIR" >> "$BACKUP/manifest.env"
  else
    [[ -d "$PROFILE_DIR/node_modules" ]] && ln -s "$PROFILE_DIR/node_modules" "$MIRROR_DIR/node_modules"
  fi
else
  DUMP_HOME="$HOME_DIR"
  MIRROR="$PROFILE"
fi

set +e
DSH_HOME="$DUMP_HOME" "$DSH" --profile "$MIRROR" --dump-config > "$BACKUP/dump-config.yml" 2> "$BACKUP/dump-config.err"
DUMP_RC=$?
set -e
if [[ "$DUMP_HOME" != "$HOME_DIR" ]]; then rm -rf "$DUMP_HOME"; fi
[[ $DUMP_RC -eq 0 ]] || { cat "$BACKUP/dump-config.err" >&2; die "--dump-config 失败（退出码 $DUMP_RC）。"; }
if ! grep -A12 '^- id: dsh-secretary$' "$BACKUP/dump-config.yml" | grep -q "id: $WORKSPACE_ID"; then
  cat "$BACKUP/dump-config.err" >&2
  die "dump 中未找到 $PACKAGE_NAME 行或 workspace 配置。详见 $BACKUP/dump-config.yml"
fi
if ! grep -A12 '^- id: dsh-secretary$' "$BACKUP/dump-config.yml" | grep -q "cwd: $WORKSPACE_CWD"; then
  die "dump 中 workspace cwd 与预期不符。详见 $BACKUP/dump-config.yml"
fi
echo "dump 验证通过：插件行与 workspace 配置均存在。"

# ⑦ 回滚命令。
printf '\n安装完成。回滚命令：\n  DSH_HOME=%q %q %q\n' "$HOME_DIR" "$ROOT/scripts/desktop/uninstall.sh" "$PROFILE"
printf '备份目录：%s\n' "$BACKUP"