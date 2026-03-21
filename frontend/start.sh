#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-8333}"
NO_BUILD=0

if [[ "${1:-}" == "--no-build" ]]; then
  NO_BUILD=1
fi

ensure_npm_dependencies() {
  if [[ -d node_modules && -x node_modules/.bin/node ]] || [[ -d node_modules && -x node_modules/.bin/vite ]]; then
    return 0
  fi

  echo "[INFO] frontend dependencies missing. Running npm ci..."
  npm ci
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
    echo "[INFO] Killing PID $pid on port $port"
    kill -TERM "$pid" 2>/dev/null || true
  done

  sleep 1
}

echo "[INFO] Starting CPA Console Backend and Frontend Delivery on port $PORT..."
echo "[INFO] Checking and killing processes listening on port $PORT..."
kill_port "$PORT"
ensure_npm_dependencies

if [[ "$NO_BUILD" != "1" ]]; then
  echo "[INFO] Building frontend assets..."
  if ! npm run build; then
    echo "[WARN] Build failed. Trying fallback to existing dist..."
    if [[ ! -f dist/index.html ]]; then
      echo "[ERROR] dist/index.html not found. Cannot start in production mode."
      exit 1
    fi
    echo "[INFO] Found existing dist. Continue starting server."
  fi
else
  echo "[INFO] Skip build enabled: --no-build. Using existing dist."
fi

exec node server.js
