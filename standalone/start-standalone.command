#!/usr/bin/env bash

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

pause_and_exit() {
  local code="$1"
  echo
  read -r -n 1 -s -p "[standalone] Press any key to close..."
  echo
  exit "$code"
}

if ! command -v node >/dev/null 2>&1; then
  echo "[standalone] Node.js was not found on PATH."
  echo "[standalone] Install Node.js from https://nodejs.org and re-run this file."
  pause_and_exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "[standalone] npm was not found on PATH."
  echo "[standalone] Install Node.js from https://nodejs.org and re-run this file."
  pause_and_exit 1
fi

if [ ! -d "node_modules" ]; then
  echo "[standalone] Dependencies missing. Running npm install..."
  npm install || pause_and_exit 1
fi

if [ ! -f "frontend/dist/index.html" ]; then
  echo "[standalone] UI build missing. Running npm run build:ui..."
  npm run build:ui || pause_and_exit 1
fi

echo "[standalone] Opening control page..."
open "http://127.0.0.1:19321" >/dev/null 2>&1 || true

echo "[standalone] Starting service..."
npm run dev
exit_code=$?

if [ "$exit_code" -ne 0 ]; then
  echo
  echo "[standalone] Service stopped with exit code $exit_code."
  pause_and_exit "$exit_code"
fi
