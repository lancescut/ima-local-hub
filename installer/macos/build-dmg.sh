#!/bin/bash
# 在 macOS 上构建 ImaLocalHub .app 与 .dmg（CI 使用）
# 用法: build-dmg.sh <arch: arm64|x64> <node_version: 22.14.0> <out.dmg>
set -euo pipefail
ARCH="${1:?arm64|x64}"
NODE_VER="${2:?node version}"
OUT="${3:?output dmg path}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STAGE="$(mktemp -d)"
APP="$STAGE/ImaLocalHub.app"
RES="$APP/Contents/Resources"

mkdir -p "$APP/Contents/MacOS" "$RES/app" "$RES/runtime"

# 1) 应用文件
cp "$ROOT/hub.js" "$ROOT/package.json" "$ROOT/README.md" "$RES/app/"
cp -r "$ROOT/lib" "$ROOT/public" "$RES/app/"
# 2) 启动器 + plist
cp "$ROOT/installer/macos/ImaLocalHub-launcher.sh" "$APP/Contents/MacOS/ImaLocalHub"
chmod +x "$APP/Contents/MacOS/ImaLocalHub"
cp "$ROOT/installer/macos/Info.plist" "$APP/Contents/Info.plist"
# 3) 内嵌 Node 运行时
curl -fsSL -o /tmp/node.tar.gz "https://nodejs.org/dist/v${NODE_VER}/node-v${NODE_VER}-darwin-${ARCH}.tar.gz"
tar -xzf /tmp/node.tar.gz -C /tmp
cp -r "/tmp/node-v${NODE_VER}-darwin-${ARCH}/bin" "$RES/runtime/"
chmod +x "$RES/runtime/bin/node"
# 4) 图标（如有 PNG 则生成 icns）
if [ -f "$ROOT/installer/macos/AppIcon.png" ]; then
  ICONSET="$STAGE/icon.iconset"; mkdir -p "$ICONSET"
  for size in 16 32 64 128 256 512; do
    sips -z $size $size "$ROOT/installer/macos/AppIcon.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
    double=$((size*2))
    if [ $double -le 1024 ]; then
      sips -z $double $double "$ROOT/installer/macos/AppIcon.png" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
    fi
  done
  iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/App.icns"
  plutil -replace CFBundleIconFile -string App.icns "$APP/Contents/Info.plist"
fi
# 5) 桌面说明
cat > "$STAGE/安装说明.txt" <<'EOF'
ImaLocalHub 安装（macOS）
1. 把 ImaLocalHub.app 拖入「应用程序」文件夹
2. 双击打开（首次如提示安全验证，右键→打开）
3. 浏览器会自动打开管理页，按引导完成安装
4. 完成后在 ima → 设置 → 模型管理 粘贴配置卡内容
卸载：应用程序里删除 ImaLocalHub.app，并执行
  launchctl unload ~/Library/LaunchAgents/com.imalocalhub.plist && rm ~/Library/LaunchAgents/com.imalocalhub.plist
EOF
# 6) 生成 dmg（含 /Applications 快捷方式）
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "ImaLocalHub" -srcfolder "$STAGE" -ov -format UDZO "$OUT"
echo "DMG built: $OUT"
