#!/usr/bin/env bash
#
# Run the multiqlti server ON THE HOST (not in Docker).
#
# Why: the `anthropic` provider runs in CLI mode (spawns `claude`) and the
# `antigravity` provider spawns `agy`. Both are host-installed binaries with
# host-side auth (~/.claude, ~/.gemini/antigravity-cli). A Linux container
# cannot see them on its PATH, and `agy` is a macOS-native binary that would
# not execute inside the container anyway. So the server has to run on the host.
#
# Infra (Postgres + Redis) still runs in Docker. Start it first:
#     docker compose up -d postgres redis
#
# Then run this script from the multiqlti root:
#     ./scripts/dev-host.sh
#
set -euo pipefail
cd "$(dirname "$0")/.."

# ── Load .env (the same file docker compose uses) so we reuse its secrets ──────
# The Node app does NOT auto-load .env (no dotenv dependency), so we export it
# here for the host process.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

# ── Point the app at the Dockerised infra via host-published ports ────────────
# Inside Docker the app reaches the DB at host `postgres`; on the host that name
# does not resolve, so override it to localhost:5432 (published by the override
# compose file). Same for Redis on localhost:6379.
export DATABASE_URL="postgres://${POSTGRES_USER:-multiqlti}:${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD in .env}@localhost:5432/${POSTGRES_DB:-multiqlti}"
export REDIS_URL="redis://localhost:6379"
export PORT="${APP_PORT:-5050}"

# ── Verify the CLI providers' binaries are reachable on the host PATH ─────────
missing=0
if ! command -v claude >/dev/null 2>&1; then
  echo "WARN: 'claude' not on PATH — the anthropic (CLI mode) provider will fail." >&2
  missing=1
fi
if ! command -v agy >/dev/null 2>&1; then
  echo "WARN: 'agy' not on PATH — the antigravity provider will fail." >&2
  missing=1
fi
[ "$missing" -eq 0 ] && echo "OK: claude + agy found on PATH."

# ── Launch ────────────────────────────────────────────────────────────────────
# Optional arg selects the run mode:
#   (none) | dev  → hot-reload dev server (tsx)
#   start         → build the production bundle, then run it (node dist/index.cjs)
MODE="${1:-dev}"
case "$MODE" in
  dev)
    echo "Starting multiqlti [dev] on http://localhost:${PORT} (DB: localhost:5432, Redis: localhost:6379)"
    exec npm run dev
    ;;
  start)
    echo "Building, then starting multiqlti [prod] on http://localhost:${PORT} (DB: localhost:5432, Redis: localhost:6379)"
    npm run build
    exec npm start
    ;;
  *)
    echo "Usage: $0 [dev|start]" >&2
    exit 2
    ;;
esac
