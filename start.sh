#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_START="$ROOT_DIR/frontend/start.sh"

if [[ ! -f "$FRONTEND_START" ]]; then
  echo "[ERROR] frontend/start.sh not found."
  exit 1
fi

cd "$ROOT_DIR/frontend"
exec bash "$FRONTEND_START" "$@"
