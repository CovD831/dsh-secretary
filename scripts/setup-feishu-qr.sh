#!/usr/bin/env bash
# 一键扫码创建并绑定飞书秘书机器人（零手动复制 App Secret，自动锁定 bot 严格模式）
set -euo pipefail

CONFIG_DIR="${LARKSUITE_CLI_SECRETARY_DIR:-$HOME/.lark-cli-dsh-secretary}"
WRAPPER_BIN="${LARK_SECRETARY_BIN:-$HOME/.local/bin/lark-secretary-bot}"

if ! command -v lark-cli >/dev/null 2>&1; then
  echo "❌ 未检测到 lark-cli，请先安装（例如 brew install lark-cli 或 npm i -g @larksuite/cli）" >&2
  exit 1
fi

mkdir -p "$CONFIG_DIR" "$(dirname "$WRAPPER_BIN")"
chmod 700 "$CONFIG_DIR"

echo "=========================================================="
echo " 📱 第一步：飞书扫码一键创建秘书机器人"
echo "    接下来终端会显示验证链接 / 二维码，请用手机飞书扫码或点开链接确认创建。"
echo "    （无需手动复制粘贴 App ID 或 App Secret）"
echo "=========================================================="

LARKSUITE_CLI_CONFIG_DIR="$CONFIG_DIR" \
LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1 \
LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1 \
  lark-cli config init --new --brand feishu --lang zh

echo ""
echo "🔒 第二步：锁定机器人严格身份（禁止任何执行器借用个人用户身份）..."
LARKSUITE_CLI_CONFIG_DIR="$CONFIG_DIR" \
LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1 \
LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1 \
  lark-cli config strict-mode bot --global

cat > "$WRAPPER_BIN" <<EOF
#!/bin/sh
export LARKSUITE_CLI_CONFIG_DIR="$CONFIG_DIR"
export LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1
export LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1
exec lark-cli "\$@"
EOF
chmod +x "$WRAPPER_BIN"

echo ""
echo "🔍 第三步：核验机器人连通性与身份..."
"$WRAPPER_BIN" auth status
BOT_JSON=$("$WRAPPER_BIN" api GET /open-apis/bot/v3/info --as bot --format ndjson | head -n 1)
echo "Bot Info: $BOT_JSON"

echo ""
echo "✅ 飞书秘书机器人配置完成！"
echo "   专用包装命令路径: $WRAPPER_BIN"
echo "   提示：首次私聊请先在飞书客户端搜索打开该机器人会话发一句任意消息激活会话。"
