#!/usr/bin/env bash
# Boot the full local stack (memory-service + Inngest dev server + Next dev) in
# one command:
#   ./scripts/dev-stack.sh   (or: npm run dev:stack)
# Runs all three processes with a shared lifecycle — Ctrl-C stops all of them.
# Logs interleave (prefixed).
#
# The outbound campaign/draft/send/reply E2E smoke test this stack used to
# exist for was removed with outbound sales — this stack is still useful for
# exercising memory ingest / the agent loop generally against a real Inngest
# dev server, just with no dedicated one-command smoke script anymore.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ ! -d "memory-service/.venv" ]; then
  echo "memory-service/.venv not found — create it first (see memory-service/README)."
  exit 1
fi

pids=()
cleanup() {
  echo
  echo "[dev-stack] stopping..."
  for p in "${pids[@]:-}"; do kill "$p" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "[dev-stack] starting memory-service (uvicorn :8000)..."
(
  cd memory-service && source .venv/bin/activate \
    && set -a && . ../.env && set +a \
    && exec uvicorn app.main:app --port 8000 2>&1 | sed 's/^/[memory] /'
) &
pids+=($!)

echo "[dev-stack] starting Inngest dev server (:8288)..."
( exec inngest-cli dev 2>&1 | sed 's/^/[inngest] /' ) &
pids+=($!)

echo "[dev-stack] starting Next dev (:3000)..."
( INNGEST_BYPASS=1 exec npm run dev 2>&1 | sed 's/^/[next] /' ) &
pids+=($!)

echo "[dev-stack] all three launched. Ctrl-C to stop."
wait
