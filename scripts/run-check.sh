#!/usr/bin/env bash
# Usage: bash scripts/run-check.sh <script> [arguments for the script]
# Set ENV_FILE to override the env file (default: .env)
# Example: ENV_FILE=.env.prod npm run db:check
#
# A missing default .env is normal (fresh clones ship only .env.example) and stays
# silent. A missing ENV_FILE the caller named is probably a typo, so it warns: the
# check still runs, but on the ambient environment, which may be a different database.
#
# The default .env is a local file, so a database URL it supplies must be on this
# machine (scripts/lib/require-local-env-database.ts). A URL exported in the shell, or
# an env file named with ENV_FILE, is an explicit choice and is not checked.
set -e
if [ -n "${ENV_FILE:-}" ]; then
  if [ ! -f "$ENV_FILE" ]; then
    echo "run-check: ENV_FILE=$ENV_FILE not found; running on the ambient environment instead" >&2
    exec npx tsx "$@"
  fi
  exec npx tsx --env-file="$ENV_FILE" "$@"
fi
if [ -f .env ]; then
  guard="$(cd "$(dirname "$0")" && pwd)/lib/require-local-env-database.ts"
  exec npx tsx --env-file=.env --import "$guard" "$@"
fi
exec npx tsx "$@"
