#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIR="$ROOT_DIR/frontend"

if [[ ! -f "$FRONTEND_DIR/package.json" ]]; then
  echo "[ERROR] frontend/package.json not found."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "[ERROR] npm not found in PATH."
  exit 1
fi

ensure_npm_dependencies() {
  if [[ -d "$FRONTEND_DIR/node_modules" && -x "$FRONTEND_DIR/node_modules/.bin/vite" ]]; then
    return 0
  fi

  echo "[INFO] frontend dependencies missing. Running npm ci..."
  (cd "$FRONTEND_DIR" && npm ci)
}

kill_port() {
  local port="$1"
  local pids=""

  if command -v lsof >/dev/null 2>&1; then
    pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  elif command -v fuser >/dev/null 2>&1; then
    pids="$(fuser "$port"/tcp 2>/dev/null || true)"
  elif command -v ss >/dev/null 2>&1; then
    pids="$(ss -ltnp 2>/dev/null | awk -v target=":$port" '$4 ~ target { if (match($NF, /pid=([0-9]+)/, m)) print m[1] }' | sort -u || true)"
  fi

  if [[ -z "${pids// }" ]]; then
    echo "[INFO] Port $port is free."
    return 0
  fi

  for pid in $pids; do
    [[ -z "$pid" ]] && continue
    echo "[INFO] Port $port is occupied by PID $pid. Killing..."
    kill -TERM "$pid" 2>/dev/null || true
  done

  sleep 1
}

cleanup() {
  local exit_code=$?
  if [[ -n "${API_PID:-}" ]]; then
    kill -TERM "$API_PID" 2>/dev/null || true
  fi
  if [[ -n "${WEB_PID:-}" ]]; then
    kill -TERM "$WEB_PID" 2>/dev/null || true
  fi
  wait 2>/dev/null || true
  exit "$exit_code"
}

trap cleanup INT TERM EXIT

kill_port 8333
kill_port 5173
ensure_npm_dependencies

echo "[INFO] Starting CPA dev servers with hot reload..."
echo "[INFO] API  : http://127.0.0.1:8333"
echo "[INFO] Web  : http://127.0.0.1:5173"

cd "$FRONTEND_DIR"
npm run dev:api &
API_PID=$!
npm run dev:web &
WEB_PID=$!

wait "$API_PID" "$WEB_PID"
