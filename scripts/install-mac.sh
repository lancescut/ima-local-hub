#!/bin/bash
# ImaLocalHub macOS 安装脚本（beta）
set -e
SRC="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$HOME/Applications/ImaLocalHub"
PLIST="$HOME/Library/LaunchAgents/com.imalocalhub.plist"
LOG_DIR="$HOME/Library/Application Support/ImaLocalHub/logs"

echo "== ImaLocalHub macOS 安装 =="

# 1. Node 检测
if ! command -v node >/dev/null || [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt 18 ]; then
  echo "[1/4] 未检测到 Node.js >= 18"
  if command -v brew >/dev/null; then
    echo "  通过 Homebrew 安装…"; brew install node
  else
    echo "  请先安装 Node.js 18+：https://nodejs.org 或先安装 Homebrew"; exit 1
  fi
else
  echo "[1/4] Node.js $(node -v) 已安装"
fi

# 2. 复制程序
echo "[2/4] 复制程序到 $APP_DIR"
mkdir -p "$APP_DIR"
rsync -a --exclude node_modules --exclude devdata --exclude test "$SRC/" "$APP_DIR/"

# 3. launchd 常驻
echo "[3/4] 注册 LaunchAgent（登录自启）"
mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"
NODE_BIN="$(command -v node)"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.imalocalhub</string>
  <key>ProgramArguments</key><array>
    <string>$NODE_BIN</string><string>$APP_DIR/hub.js</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG_DIR/hub.out.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/hub.err.log</string>
</dict></plist>
EOF
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

# 4. 打开管理页
echo "[4/4] 完成，打开管理页…"
sleep 2
open "http://127.0.0.1:18080"
echo "卸载: bash $APP_DIR/scripts/uninstall-mac.sh"
