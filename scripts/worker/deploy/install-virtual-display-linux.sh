#!/bin/bash
# Give a Linux Weles host a display that does not depend on a human being logged in.
#
# The Linux worker launcher execs the worker under `xvfb-run`, so every browser
# trajectory the worker spawns inherits a real X display and can own a window.
# That is what lets a headless server hold the `display` capability at all. It is
# also a package: on a freshly provisioned host `xvfb-run` is absent, the exec
# fails inside systemd, and the symptom reads as the worker crash-looping rather
# than as a missing package -- the same misattribution this capability model
# exists to end. So the display mechanism is installed by this script, which is
# checked in, idempotent, and prints what it measured before and after.
#
# `xdpyinfo` comes along because it is how the launcher decides whether a display
# is already reachable; without it the launcher can only guess.
#
# Runs as root through `stado host run-helper`. Prints measurements, not verdicts.
set -u

PACKAGES="xvfb x11-utils"

printf '== before\n'
for tool in xvfb-run Xvfb xdpyinfo; do
  printf '%-10s %s\n' "$tool" "$(command -v "$tool" 2>/dev/null || printf 'absent')"
done

printf '\n== apt candidates\n'
for pkg in $PACKAGES; do
  printf '%s: %s\n' "$pkg" "$(apt-cache policy "$pkg" 2>/dev/null | tr -s ' \n' ' ' || printf 'unknown')"
done

missing=""
for tool in xvfb-run xdpyinfo; do
  command -v "$tool" > /dev/null 2>&1 || missing="$missing $tool"
done
if [ -z "$missing" ]; then
  printf '\nnothing to install; every display tool is already present\n'
else
  printf '\n== installing for missing:%s\n' "$missing"
  if [ "$(id -u)" != "0" ]; then
    printf 'not root, so the packages cannot be installed from here\n' > /dev/stderr
    exit 1
  fi
  export DEBIAN_FRONTEND=noninteractive
  # A stale package index is the usual reason a present package reads as absent,
  # so refresh it rather than reporting a candidate that apt cannot fetch.
  apt-get update -qq || printf 'apt-get update reported a failure; continuing to the install\n'
  # shellcheck disable=SC2086 -- the package list is a deliberate word list.
  apt-get install -y -qq --no-install-recommends $PACKAGES || {
    printf 'apt-get install failed for:%s\n' " $PACKAGES" > /dev/stderr
    exit 1
  }
fi

printf '\n== after\n'
for tool in xvfb-run Xvfb xdpyinfo; do
  printf '%-10s %s\n' "$tool" "$(command -v "$tool" 2>/dev/null || printf 'absent')"
done
if command -v Xvfb > /dev/null 2>&1; then
  dpkg-query -W -f='xvfb version ${Version}\n' xvfb 2>/dev/null || true
fi

# The unit that makes the display outlive any one process.
#
# Without it a browser trajectory only has a display while some launcher happens
# to be wrapping it, which no capability probe can see and no placement decision
# can trust. The unit file travels as a delivered file rather than being written
# out here, so the checked-in text in
# scripts/worker/deploy/weles-virtual-display.service stays its one source.
UNIT_NAME=weles-virtual-display.service
DELIVERED_UNIT="${WELES_DISPLAY_UNIT_FILE:-$HOME/.stado/files/$UNIT_NAME}"
UNIT_PATH="/etc/systemd/system/$UNIT_NAME"
DISPLAY_NUMBER="${WELES_DISPLAY_NUMBER:-99}"
DISPLAY_SCREEN="${WELES_DISPLAY_SCREEN:-1920x1080x24}"

printf '\n== display unit\n'
if [ ! -r "$DELIVERED_UNIT" ]; then
  printf 'no delivered unit at %s, so only the packages above were installed; deliver it with `stado host install-file <host> scripts/worker/deploy/%s %s`\n' \
    "$DELIVERED_UNIT" "$UNIT_NAME" "$UNIT_NAME"
  exit 0
fi
if ! command -v systemctl > /dev/null 2>&1; then
  printf 'no systemctl here, so this host cannot hold the display as a unit\n' > /dev/stderr
  exit 1
fi

# Which account the display belongs to, measured rather than asserted. The X
# server has to be startable by whatever runs the worker here, and the checked-in
# worker unit names an account that does not exist on every host, so the existing
# worker unit wins, then the owner of the deployment tree, then the host's primary
# login account, and root only if nothing else is there.
display_user=""
display_reason=""
worker_user="$(systemctl show -p User --value weles-worker.service 2> /dev/null || true)"
if [ -n "$worker_user" ] && id -u "$worker_user" > /dev/null 2>&1; then
  display_user="$worker_user"
  display_reason="weles-worker.service runs as this account"
fi
if [ -z "$display_user" ] && [ -e "$HOME/weles" ]; then
  tree_owner="$(stat -c '%U' "$HOME/weles" 2> /dev/null || true)"
  if [ -n "$tree_owner" ] && id -u "$tree_owner" > /dev/null 2>&1; then
    display_user="$tree_owner"
    display_reason="owns the deployment tree $HOME/weles"
  fi
fi
if [ -z "$display_user" ]; then
  primary="$(getent passwd 1000 2> /dev/null | cut -d: -f1 || true)"
  if [ -n "$primary" ]; then
    display_user="$primary"
    display_reason="the host's primary account, uid 1000; no Weles deployment names another"
  fi
fi
if [ -z "$display_user" ]; then
  display_user=root
  display_reason="no other account exists on this host"
fi
printf 'user %s (%s)\n' "$display_user" "$display_reason"
printf 'display :%s screen %s\n' "$DISPLAY_NUMBER" "$DISPLAY_SCREEN"

staged="$(mktemp)"
sed \
  -e "s|WELES_DISPLAY_USER|$display_user|g" \
  -e "s|WELES_DISPLAY_NUMBER|$DISPLAY_NUMBER|g" \
  -e "s|WELES_DISPLAY_SCREEN|$DISPLAY_SCREEN|g" \
  "$DELIVERED_UNIT" > "$staged"
if [ -f "$UNIT_PATH" ] && cmp -s "$staged" "$UNIT_PATH"; then
  printf '%s already carries this exact unit\n' "$UNIT_PATH"
else
  install -m 644 "$staged" "$UNIT_PATH"
  printf 'wrote %s (%s bytes)\n' "$UNIT_PATH" "$(/usr/bin/wc -c < "$UNIT_PATH" | tr -d ' ')"
  systemctl daemon-reload
fi
rm -f "$staged"

# `enable --now` is what makes the capability survive a reboot, which is the whole
# difference between a display somebody started and a display the host has.
systemctl enable --now "$UNIT_NAME" 2>&1 | sed 's/^/  /'
# A unit that is active while its server is dead is the failure worth catching, so
# wait for the socket rather than trusting the activation.
socket="/tmp/.X11-unix/X$DISPLAY_NUMBER"
waited=0
while [ "$waited" -lt 20 ] && [ ! -e "$socket" ]; do
  sleep 1
  waited=$((waited + 1))
done

printf '\n== measured after enabling\n'
printf 'enabled %s, active %s\n' \
  "$(systemctl is-enabled "$UNIT_NAME" 2> /dev/null | head -n 1)" \
  "$(systemctl is-active "$UNIT_NAME" 2> /dev/null | head -n 1)"
printf 'socket %s after %ss: %s\n' "$socket" "$waited" "$([ -e "$socket" ] && printf 'present' || printf 'absent')"
main_pid="$(systemctl show -p MainPID --value "$UNIT_NAME" 2> /dev/null)"
printf 'main pid %s, unit user %s\n' "$main_pid" "$(systemctl show -p User --value "$UNIT_NAME" 2> /dev/null)"
ps -o user,pid,args -p "$main_pid" 2> /dev/null | sed 's/^/  /'
# The measurement any consumer will make: connect, and ask the server what it is.
DISPLAY=":$DISPLAY_NUMBER" xdpyinfo 2> /dev/null | grep -E '^(name of display|version number|vendor string|dimensions)' | sed 's/^/  /' \
  || printf '  xdpyinfo could not talk to :%s\n' "$DISPLAY_NUMBER"
printf 'sockets now in /tmp/.X11-unix: %s\n' "$(ls /tmp/.X11-unix 2> /dev/null | tr '\n' ' ' || printf 'none')"
