#!/bin/bash
# Double-click to stop the bridge and remove it from login startup.
LABEL="com.figshop.bridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

DOMAIN="gui/$(id -u)"
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
rm -f "$PLIST"
# Safety net: reap any orphaned KeepAlive process the legacy path left behind.
pkill -f "figshop/bridge/server.js" 2>/dev/null || true

echo "✓ Figshop auto-start removed. The bridge is stopped."
read -n1 -r -p "Press any key to close…"
