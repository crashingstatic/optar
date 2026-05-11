#!/usr/bin/env bash
# Run the Puppeteer test suite for sloptar-lite/sloptar-lite.html.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d node_modules/puppeteer ]; then
  echo "Installing puppeteer..."
  npm install --no-audit --no-fund
fi

export PUPPETEER_EXECUTABLE_PATH="${PUPPETEER_EXECUTABLE_PATH:-/usr/bin/chromium}"
exec node sloptar-lite.test.js "$@"
