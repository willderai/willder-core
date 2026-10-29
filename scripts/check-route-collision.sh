#!/usr/bin/env bash
# Boots the built production server (`next start`) briefly and fails loudly if
# Next's route-registration step reports a dynamic-route slug collision.
#
# `next build` only catches a "leaf vs. leaf" collision (two route.ts files
# resolving the same path) -- it exits 0 clean on the "leaf vs. subtree" shape
# (a route.ts alongside a same-position directory that only holds
# sub-routes), and that shape only throws at `next start` boot:
# "You cannot use different slug names for the same dynamic path". A
# build-only CI gate does not catch this bug class and must not be trusted
# for it -- this script exists specifically to close that gap by
# exercising the real boot step, not just the build step.
#
# Requires a production build to already exist (`.next/`) -- run `next build`
# first.
#
# This must not boot at all with no build present: Next's `next start` can
# print "Ready in ..." BEFORE it discovers `.next` has no build, then error
# with "Could not find a production build in the .next directory". Treating
# that as a clean boot and exiting 0 would be a false OK for the leaf-vs-
# subtree slug-collision bug class this script exists to catch, since a
# missing build is never a real answer either way. Two independent checks
# close that gap: fail fast before ever booting if `.next/BUILD_ID` is
# missing (the normal "no build yet" case, and the fast path -- no need to
# spend 30s+ waiting on a server that can't succeed), and also grep every log
# check for "Could not find a production build" (defense in depth for a
# build present at start but that errors for the same reason partway
# through, e.g. a corrupt/partial `.next`).
set -uo pipefail

PORT="${PORT:-4590}"

if [ ! -f ".next/BUILD_ID" ]; then
  echo "FAIL: no production build found (.next/BUILD_ID missing). Run \`next build\` first -- this script only verifies an existing build boots clean, it does not build one." >&2
  exit 1
fi

LOG_FILE="$(mktemp)"
SERVER_PID=""

cleanup() {
  if [ -n "$SERVER_PID" ]; then
    # `npx next start` forks the real next-server as a child; killing just
    # $SERVER_PID (the npx wrapper) leaves that child running and holding
    # $PORT. The server is started in its own process group below so
    # `kill -- -PID` can take the whole tree out at once; fall back to a
    # plain kill if that group is already gone.
    kill -- "-$SERVER_PID" >/dev/null 2>&1 || kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -f "$LOG_FILE"
}
trap cleanup EXIT

# Job control (`set -m`) starts the background job in its own process group,
# on Linux and macOS alike; `setsid`, which did this before, does not exist on
# macOS. Switched off again right after so nothing else in the script changes.
#
# stdin comes from /dev/null because `set -m`, unlike `setsid`, leaves the job
# in this shell's session and attached to its controlling terminal: a
# background process that reads the terminal gets SIGTTIN and stops, which
# this script would then report as a boot timeout rather than a clean boot.
set -m
npx next start -p "$PORT" </dev/null >"$LOG_FILE" 2>&1 &
SERVER_PID=$!
set +m

# A boot is clean only if the server reports Ready, prints none of the
# failure lines below, and is still running after the settle window. Each
# failure line is checked on every poll, before and after Ready:
#
# - the slug collision this script exists for;
# - "Could not find a production build" (see the header);
# - "willder web server failed", the startup environment check in
#   instrumentation.ts. Next prints Ready and only then runs that hook, which
#   exits 1 when a required variable is missing. A grep for Ready alone would
#   read that dead server as a clean boot, and with it any collision the
#   server never lived long enough to report.
COLLISION_LINE="different slug names for the same dynamic path"
NO_BUILD_LINE="Could not find a production build"
STARTUP_ENV_LINE="willder web server failed"

FAILURE=""
check_log() {
  if grep -q "$COLLISION_LINE" "$LOG_FILE"; then
    FAILURE="dynamic-route slug collision detected at next start boot"
  elif grep -q "$NO_BUILD_LINE" "$LOG_FILE"; then
    FAILURE="next start reported no production build present at boot (stale/corrupt .next?)"
  elif grep -q "$STARTUP_ENV_LINE" "$LOG_FILE"; then
    FAILURE="the web server's startup environment check failed, so the boot was never checked for a collision (set every variable in lib/required-env.ts WEB_SERVER_ENV)"
  fi
  [ -n "$FAILURE" ]
}

server_alive() {
  kill -0 "$SERVER_PID" 2>/dev/null
}

READY=0
for _ in $(seq 1 30); do
  check_log && break
  if grep -qE "Ready in|✓ Ready" "$LOG_FILE"; then
    READY=1
    break
  fi
  if ! server_alive; then
    # The failure line may have landed right at exit; read the log once more.
    check_log || FAILURE="next start exited before reporting Ready"
    break
  fi
  sleep 1
done

# The slug-collision error and the startup environment check both fire a
# moment *after* the Ready line (confirmed live), so Ready alone does not mean
# a clean boot. Watch the log and the process for a settle window, then check
# once more: the loop sleeps after its last check, and a failure landing in
# that final second must still count.
if [ -z "$FAILURE" ] && [ "$READY" -eq 1 ]; then
  for _ in $(seq 1 10); do
    check_log && break
    if ! server_alive; then
      check_log || FAILURE="next start reported Ready, then exited"
      break
    fi
    sleep 1
  done
  if [ -z "$FAILURE" ] && ! check_log && ! server_alive; then
    FAILURE="next start reported Ready, then exited"
  fi
fi

if [ -n "$FAILURE" ]; then
  echo "FAIL: $FAILURE. Log:" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi

if [ "$READY" -ne 1 ]; then
  echo "FAIL: next start did not report Ready within timeout (and no slug collision seen either -- something else is wrong). Log:" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi

echo "OK: next start booted clean, no dynamic-route slug collision."
