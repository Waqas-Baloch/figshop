#!/bin/bash
# Double-click once. Installs the bridge as a background service that starts
# automatically every time you log in — you never have to start it manually again.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "Node.js not found. Install it from https://nodejs.org first."; read -n1 -r -p "Press any key…"; exit 1; }

LABEL="com.figshop.bridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

echo "Installing Figshop auto-start"
echo "  bridge: $DIR/server.js"
echo "  node:   $NODE"

[ -d node_modules ] || { echo "Installing dependencies…"; npm install; }
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.figshop"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$DIR/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/.figshop/bridge.log</string>
  <key>StandardErrorPath</key><string>$HOME/.figshop/bridge.log</string>
</dict>
</plist>
EOF

DOMAIN="gui/$(id -u)"
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
pkill -f "$DIR/server.js" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"

echo ""
echo "✓ Done. The Figshop bridge is running now and will start automatically at login."
echo "  Log:       ~/.figshop/bridge.log"
echo "  To remove: double-click uninstall-autostart.command"
read -n1 -r -p "Press any key to close…"
