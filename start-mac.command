#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install Node.js 18 or newer, then run this file again."
  read -r -p "Press Enter to close..."
  exit 1
fi
npm start
