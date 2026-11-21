#!/usr/bin/env bash
set -u
cd "$(dirname "$0")"
URL="http://127.0.0.1:8080/"
echo "Starting Milestones Group HR at $URL"
(
  sleep 2
  if [[ "$(uname -s)" == "Darwin" ]]; then
    open -a "Google Chrome" "$URL" 2>/dev/null || open "$URL"
  elif command -v google-chrome >/dev/null 2>&1; then
    google-chrome "$URL"
  elif command -v chromium >/dev/null 2>&1; then
    chromium "$URL"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$URL"
  fi
) >/dev/null 2>&1 &
python3 -m http.server 8080 --bind 127.0.0.1
