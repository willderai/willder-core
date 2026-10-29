#!/usr/bin/env bash
# Build pipeline: apply pending migrations only when this build is a real deploy
# whose target DB is meant to be migrated, then generate the Prisma client and
# build Next.js.
#
# `prisma migrate deploy` runs in the build so a merged migration can never
# silently fail to reach prod. But `prisma migrate deploy` fails the whole build
# outright ("Error: Connection url is empty. See https://pris.ly/d/config-url")
# when neither DATABASE_URL_UNPOOLED nor DATABASE_URL is set for the deploy
# target -- true for preview builds, which don't carry the same DB env vars
# as production; that broke every preview deploy. Skip the
# migrate-deploy step, rather than crash the build, when no connection
# string is actually configured; keep running it whenever one is, so the
# production behavior is unchanged.
#
# PRODUCTION DATA SAFETY.
# Presence of a connection string is NOT on its own permission to migrate.
# A sandbox or CI job may hold a live production DATABASE_URL while it runs
# `npm run build` to verify a branch, and that build must never apply the
# branch's unreviewed migrations to production. So migrating now requires an explicit signal that this build IS a
# deploy: either Vercel set VERCEL_ENV (only real deploy builds have it), or the
# caller opted in with ALLOW_PRISMA_MIGRATE_DEPLOY=1. A plain `npm run build`
# with a production DATABASE_URL in the environment skips the migration and says
# so, instead of silently mutating the schema it happens to be pointed at.
set -e

DB_URL="${DATABASE_URL_UNPOOLED:-$DATABASE_URL}"

# Never migrate through Neon's connection pooler, whichever variable supplied the URL.
# The pooler (PgBouncer, transaction mode) runs Prisma's session advisory lock and its
# unlock on different server connections, so the unlock misses and the lock stays held
# by a pooled server connection. Every later migrate then waits on it with
# P1002 until the pooler happens to route its lock call to that same connection, with
# no other build running (seen three times on 2026-10-07). Neon's direct host is
# the pooled one without "-pooler", so derive it rather than trust the variable's name.
MIGRATE_URL=$(printf '%s' "$DB_URL" | sed -E 's#(://([^@/]*@)?ep-[^.@/:]+)-pooler(\.[^/:?]*\.neon\.tech)#\1\3#')
if [ "$MIGRATE_URL" != "$DB_URL" ]; then
  echo "Migrating through Neon's direct host: the configured URL names its -pooler host, which cannot hold the migrate advisory lock."
fi

# Is this build allowed to mutate a database at all? Vercel sets VERCEL_ENV on
# every deploy build (production/preview/development) and nothing else does.
if [ -n "$VERCEL_ENV" ] || [ "$ALLOW_PRISMA_MIGRATE_DEPLOY" = "1" ]; then
  MIGRATE_ALLOWED=1
else
  MIGRATE_ALLOWED=0
fi

# Prisma takes a Postgres advisory lock around `migrate deploy` so two deploys
# can never apply the same migration at once, and gives up waiting for it after
# 10 seconds with P1002. Merging several PRs in a few minutes starts that many
# Vercel builds against one production database, so the builds that lose the
# race fail outright and their commits never deploy -- six merges on
# 2026-09-23 left production frozen on an older commit (P1002, 04:58-05:01 UTC).
#
# Waiting is the correct behaviour here: the migrations are ordered and the
# holder finishes in seconds, so a build that waits its turn succeeds. Prisma 7
# has no knob to lengthen that wait -- `PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK` is
# the only advisory-lock variable it reads, and turning the lock off would
# remove the very guarantee that keeps concurrent deploys correct. So we retry
# the command instead, which extends the wait without weakening the lock.
#
# Only P1002 is retried. Any other failure is a real migration error and must
# fail the build immediately rather than be retried.
#
# Twenty attempts fifteen seconds apart, so a build waits about five minutes for
# its turn before giving up. That has to cover a whole neighbouring build's
# migrate step, not just the lock hand-off: the earlier one-minute wait (six
# attempts, ten seconds) still failed two builds merged about two minutes apart
# on 2026-10-01, leaving production on the older one. Overridable so a caller can
# shorten it.
MIGRATE_LOCK_ATTEMPTS="${MIGRATE_LOCK_ATTEMPTS:-20}"
MIGRATE_LOCK_WAIT_SECONDS="${MIGRATE_LOCK_WAIT_SECONDS:-15}"

migrate_deploy_waiting_for_lock() {
  local attempt=1
  local output
  while :; do
    if output=$(DATABASE_URL="$MIGRATE_URL" npx prisma migrate deploy 2>&1); then
      printf '%s\n' "$output"
      echo "prisma migrate deploy succeeded on attempt ${attempt}/${MIGRATE_LOCK_ATTEMPTS}."
      return 0
    fi
    printf '%s\n' "$output" >&2
    if ! printf '%s' "$output" | grep -q "P1002"; then
      return 1
    fi
    if [ "$attempt" -ge "$MIGRATE_LOCK_ATTEMPTS" ]; then
      echo "Error: prisma migrate deploy still blocked on the advisory lock after ${MIGRATE_LOCK_ATTEMPTS} attempts. Another deploy is holding it for longer than expected; check for a stuck build before retrying." >&2
      return 1
    fi
    echo "prisma migrate deploy timed out waiting for the advisory lock (P1002), attempt ${attempt}/${MIGRATE_LOCK_ATTEMPTS}. Another deploy is migrating; waiting ${MIGRATE_LOCK_WAIT_SECONDS}s and retrying."
    sleep "$MIGRATE_LOCK_WAIT_SECONDS"
    attempt=$((attempt + 1))
  done
}

if [ -n "$DB_URL" ] && [ "$MIGRATE_ALLOWED" = "1" ]; then
  migrate_deploy_waiting_for_lock
elif [ "$VERCEL_ENV" = "production" ]; then
  # Production is supposed to always have a real DB configured -- silently
  # skipping here would just reintroduce an earlier outage
  # (a migration merged but never applied) under a different trigger.
  echo "Error: VERCEL_ENV=production but neither DATABASE_URL_UNPOOLED nor DATABASE_URL is set. Refusing to skip migrate deploy in production." >&2
  exit 1
elif [ -n "$DB_URL" ]; then
  # A connection string is present but this is not a deploy build: refuse rather
  # than migrate whatever we're pointed at.
  echo "Skipping prisma migrate deploy: a DATABASE_URL is set, but this build is not a deploy (VERCEL_ENV unset) and ALLOW_PRISMA_MIGRATE_DEPLOY is not 1."
  echo "  Refusing to apply this branch's migrations to that database. Set ALLOW_PRISMA_MIGRATE_DEPLOY=1 only if you intend to migrate it."
else
  echo "Skipping prisma migrate deploy: no DATABASE_URL/DATABASE_URL_UNPOOLED set for this deploy target (VERCEL_ENV=${VERCEL_ENV:-unset})."
fi

npx prisma generate
npx next build
