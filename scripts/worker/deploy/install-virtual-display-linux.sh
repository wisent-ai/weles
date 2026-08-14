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
