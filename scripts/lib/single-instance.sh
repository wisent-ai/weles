#!/bin/bash
# Single-instance enforcement for Weles long-running services.
#
# Usage (sourced):
#   . "$(dirname "$0")/../lib/single-instance.sh"
#   weles_kill_previous_instances "scripts/worker/run.mjs"
#
# Kills every OTHER process whose full command line contains PATTERN, waiting
# briefly for a clean exit before escalating to SIGKILL. The calling process
# is never a match candidate (its command line does not contain the pattern
# until after exec), which makes the guard idempotent: relaunching the unit
# converges to exactly one instance instead of stacking them.
#
# WELES_SINGLE_INSTANCE_DEBUG=1 logs planned kills instead of performing them.

weles_kill_previous_instances() {
  local pattern="$1"
  local grace="${WELES_SINGLE_INSTANCE_GRACE_SECONDS:-5}"
  local me="$$"
  [ "${WELES_SINGLE_INSTANCE_DEBUG:-0}" = "1" ] && \
    echo "[single-instance] debug mode: would clear '$pattern'" >&2

  local pids=""
  if [ "${WELES_SINGLE_INSTANCE_DEBUG:-0}" = "1" ]; then
    pids=$(pgrep -f "$pattern" 2>/dev/null | grep -vx "$me" | tr '\n' ' ')
    echo "[single-instance] debug: would signal:${pids:+ $pids}" >&2
    return 0
  fi

  pids=$(pgrep -f "$pattern" 2>/dev/null | grep -vx "$me")
  [ -n "$pids" ] || return 0

  for pid in $pids; do
    echo "[single-instance] stopping previous instance pid=$pid pattern=$pattern" >&2
    kill "$pid" 2>/dev/null
  done

  local waited=0
  while [ "$waited" -lt "$grace" ]; do
    pids=$(pgrep -f "$pattern" 2>/dev/null | grep -vx "$me")
    [ -z "$pids" ] && return 0
    sleep 1
    waited=$((waited + 1))
  done

  for pid in $pids; do
    echo "[single-instance] escalating to SIGKILL pid=$pid" >&2
    kill -9 "$pid" 2>/dev/null
  done
  sleep 1
}
