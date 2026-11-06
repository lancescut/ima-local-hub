#!/bin/bash
# ImaLocalHub macOS 卸载
PLIST="$HOME/Library/LaunchAgents/com.imalocalhub.plist"
launchctl unload "$PLIST" 2>/dev/null || true
rm -f "$PLIST"
rm -rf "$HOME/Applications/ImaLocalHub"
echo "已卸载。配置保留在 ~/Library/Application Support/ImaLocalHub（可手动删除）"
echo "如需清理 funnel: tailscale funnel --https=8443 off"
