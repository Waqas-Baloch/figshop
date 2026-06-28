#!/bin/bash
# Double-click this file in Finder to start the Figshop bridge.
# Close the Terminal window to stop it.
cd "$(dirname "$0")" || exit 1

if [ ! -d node_modules ]; then
  echo "First run — installing dependencies…"
  npm install || { echo "npm install failed. Is Node installed?"; read -n1 -r -p "Press any key…"; exit 1; }
fi

echo "Starting Figshop bridge…  (close this window to stop)"
exec node server.js
