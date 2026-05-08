#!/usr/bin/env bash
# Start the full local-dev stack for iPhone testing in one command.
#
# Spawns five long-running processes (plus the docker containers `npm run dev`
# manages internally). Ctrl+C kills everything.
#
# What runs:
#   1. backend          — Hono server + tsx watch, on localhost:3000
#   2. mobile           — Expo web bundler, on localhost:8081
#   3. cloudflared:3000 — HTTPS tunnel for the backend
#   4. cloudflared:8081 — HTTPS tunnel for the mobile bundle
#   5. cloudflared:9000 — HTTPS tunnel for MinIO (so iPhone can PUT bills via
#                         the presigned S3 URL)
#
# Why three tunnels: iOS Safari restricts Web Crypto + camera APIs to HTTPS
# origins. Plain http://192.168.x.x doesn't qualify. cloudflared "quick
# tunnels" hand out fresh https://*.trycloudflare.com URLs each run.
#
# Caveat: cloudflared quick tunnels generate a NEW URL on every run. After
# starting, copy the URLs into gdp-mobile's env (EXPO_PUBLIC_API_BASE_URL,
# EXPO_PUBLIC_PUBLIC_BASE_URL) and the backend's S3_ENDPOINT, then restart
# the relevant processes so the new URLs are baked into the bundle. To
# avoid this dance, set up cloudflared "named tunnels" with a config.yml
# (one process, stable URLs). See docs/local-dev.md for the topology.
#
# Assumes ../gdp-mobile is a sibling of this repo. Override with
# GDP_MOBILE_DIR=/path/to/gdp-mobile if not.

set -e

GDP_MOBILE_DIR="${GDP_MOBILE_DIR:-../gdp-mobile}"
if [ ! -d "$GDP_MOBILE_DIR" ]; then
  echo "✗ gdp-mobile not found at $GDP_MOBILE_DIR (set GDP_MOBILE_DIR to override)"
  exit 1
fi
if ! command -v cloudflared > /dev/null 2>&1; then
  echo "✗ cloudflared not installed. brew install cloudflared"
  exit 1
fi

PIDS=()
cleanup() {
  echo ""
  echo "→ Stopping all dev processes..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  exit 0
}
trap cleanup INT TERM

start() {
  local label="$1"
  shift
  echo "→ Starting $label: $*"
  ( "$@" 2>&1 | sed -u "s/^/[$label] /" ) &
  PIDS+=($!)
}

start backend bash -c 'set -a && source .env.local && set +a && npm run dev'
start mobile  bash -c "cd $GDP_MOBILE_DIR && npm run web"
start tun-be  cloudflared tunnel --url http://localhost:3000
start tun-fe  cloudflared tunnel --url http://localhost:8081
start tun-s3  cloudflared tunnel --url http://localhost:9000

echo ""
echo "All 5 processes started. Ctrl+C to stop everything."
echo "URLs will appear above as each cloudflared tunnel comes up."
echo ""
wait
