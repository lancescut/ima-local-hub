#!/bin/bash
# ImaLocalHub macOS 启动器（.app 双击运行：注册自启、启动守护、打开管理页）
DIR="$(cd "$(dirname "$0")/../Resources" && pwd)"
APP_DIR="$DIR/app"
RUNTIME="$DIR/runtime/bin/node"
DATA_DIR="$HOME/Library/Application Support/ImaLocalHub"
LOG_DIR="$DATA_DIR/logs"
mkdir -p "$LOG_DIR"

# 清理残留实例
pkill -f "ImaLocalHub.*hub.js" 2>/dev/null
sleep 1

# 注册/刷新 LaunchAgent（登录自启）
PLIST="$HOME/Library/LaunchAgents/com.imalocalhub.plist"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.imalocalhub</string>
  <key>ProgramArguments</key><array>
    <string>$RUNTIME</string><string>$APP_DIR/hub.js</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG_DIR/hub.out.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/hub.err.log</string>
</dict></plist>
EOF
launchctl unload "$PLIST" 2>/dev/null
launchctl load "$PLIST"

sleep 2
open "http://127.0.0.1:18080"
