#!/bin/bash
# Measure whether a browser can own a window on this Linux host's virtual display.
#
# This is the Linux half of the `display` / `browser-render` pair that browser
# trajectories declare in scripts/trajectories/requirements.json. It starts the
# display exactly the way the worker's launcher does -- `xvfb-run` with the same
# screen geometry -- then launches a real headed browser on it, proves a window
# exists with `xwininfo`, and captures the root window so the result is a byte
# count rather than an opinion. A browser that cannot get a window writes nothing.
#
# Nothing here is a verdict: it prints what it measured and exits zero even when
# a number is zero, because a zero is the finding.
#
# Runs as root through `stado host run-helper`. Idempotent: the tools it needs are
# installed only when absent, and the profile and captures live in a temp dir it
# removes on exit.
set -u

SCREEN="${WELES_DISPLAY_SCREEN:-1920x1080x24}"
PAGE_URL="${WELES_RENDER_PROBE_URL:-}"
# $HOME/.stado/bin is ahead of /usr/bin on the helper's PATH and carries its own
# `wc`, so byte counts are taken with the system one on purpose.
WC=/usr/bin/wc

if [ "${WELES_DISPLAY_MEASURE_INNER:-0}" != "1" ]; then
  printf '== mechanism\n'
  if ! command -v xvfb-run > /dev/null 2>&1; then
    printf 'xvfb-run absent; run install-virtual-display-linux first\n' > /dev/stderr
    exit 1
  fi
  printf 'xvfb-run %s, screen %s\n' "$(command -v xvfb-run)" "$SCREEN"

  # xwininfo proves a window exists; xwd is how the screen becomes a byte count.
  # They are measuring instruments, not part of the deployment, so they are
  # installed here rather than in the launcher's install helper.
  need=""
  command -v xwininfo > /dev/null 2>&1 || need="$need x11-utils"
  command -v xwd > /dev/null 2>&1 || need="$need x11-apps"
  if [ -n "$need" ]; then
    printf 'installing measuring tools:%s\n' "$need"
    export DEBIAN_FRONTEND=noninteractive
    # shellcheck disable=SC2086 -- deliberate word list.
    apt-get install -y -qq --no-install-recommends $need > /dev/null || {
      printf 'could not install:%s\n' "$need" > /dev/stderr
      exit 1
    }
  fi

  printf '\n== browser\n'
  BROWSER=""
  # Prefer the browser the worker itself would drive, so the measurement is about
  # the same binary the trajectories use.
  for candidate in \
    "$HOME"/.local/share/weles-chromium/*/chrome-linux/chrome \
    "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux/chrome \
    /usr/bin/chromium /usr/bin/chromium-browser /usr/bin/google-chrome /usr/bin/google-chrome-stable; do
    if [ -x "$candidate" ]; then BROWSER="$candidate"; break; fi
  done
  if [ -z "$BROWSER" ]; then
    # Measured on this distribution: `chromium` has no candidate at all and
    # `chromium-browser` / `firefox` are snap transitionals, which cannot render
    # under Xvfb without snapd's confinement getting a session too. Google's own
    # .deb is a plain package with apt-resolvable dependencies, so that is what a
    # host with no Weles Chromium release gets for this measurement.
    printf 'no browser present; fetching the Google Chrome .deb\n'
    DEB_DIR="$(mktemp -d)"
    if ! curl -fsSL -o "$DEB_DIR/chrome.deb" \
      https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb; then
      printf 'could not download the Chrome .deb\n' > /dev/stderr
      rm -rf "$DEB_DIR"
      exit 1
    fi
    printf 'downloaded %s bytes\n' "$($WC -c < "$DEB_DIR/chrome.deb")"
    export DEBIAN_FRONTEND=noninteractive
    apt-get install -y -qq "$DEB_DIR/chrome.deb" > /dev/null || {
      printf 'apt-get could not install the Chrome .deb\n' > /dev/stderr
      rm -rf "$DEB_DIR"
      exit 1
    }
    rm -rf "$DEB_DIR"
    BROWSER=/usr/bin/google-chrome
  fi
  printf 'browser %s\n' "$BROWSER"
  "$BROWSER" --version 2>&1 | head -n 1

  export WELES_MEASURED_BROWSER="$BROWSER"
  export WELES_DISPLAY_MEASURE_INNER=1
  printf '\n== under the virtual display\n'
  exec xvfb-run -a --server-args="-screen 0 $SCREEN" "$0"
fi

# Inside xvfb-run: DISPLAY names the X server it just started for this process
# tree, which is precisely the display the worker's launcher hands to every
# trajectory it spawns.
BROWSER="$WELES_MEASURED_BROWSER"
printf 'DISPLAY=%s\n' "${DISPLAY:-unset}"
xdpyinfo | grep -E '^(name of display|dimensions|number of screens)' || true

WORK="$(mktemp -d)"
cleanup() {
  # A profile directory belongs to a live browser: removing it while Chrome is
  # still writing leaves "Directory not empty", so wait for the process to go
  # before taking its files.
  if [ -n "${BROWSER_PID:-}" ] && kill "$BROWSER_PID" 2> /dev/null; then
    wait "$BROWSER_PID" 2> /dev/null
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

# A page with a painted area, so a capture of a rendered window differs from a
# capture of an empty root window by more than noise.
cat > "$WORK/page.html" << 'HTML'
<!doctype html>
<html><head><title>weles virtual display render probe</title></head>
<body style="margin:0">
  <div style="width:100vw;height:50vh;background:#1c6ed0"></div>
  <div style="width:100vw;height:50vh;background:#d0761c"></div>
  <h1 style="position:absolute;top:40vh;left:4vw;color:#fff;font:600 48px sans-serif">weles render probe</h1>
</body></html>
HTML

printf '\n-- empty root window, before the browser starts\n'
xwd -root -display "$DISPLAY" > "$WORK/before.xwd" 2> /dev/null
printf 'root capture %s bytes\n' "$($WC -c < "$WORK/before.xwd")"

# Headed on purpose: --headless would answer a different question, and the
# question is whether a window can exist here at all. --no-sandbox because the
# helper runs as root, where Chrome's sandbox refuses to start.
"$BROWSER" \
  --no-sandbox \
  --disable-dev-shm-usage \
  --no-first-run \
  --no-default-browser-check \
  --user-data-dir="$WORK/profile" \
  --window-size=1600,1000 \
  --window-position=0,0 \
  "file://$WORK/page.html" > "$WORK/browser.log" 2>&1 &
BROWSER_PID=$!

# Poll for the window rather than sleeping a guessed interval: the fact wanted is
# when a window appeared, and how long it took is worth printing.
window=""
waited=0
while [ "$waited" -lt "$(printf '%s' 60)" ]; do
  if xwininfo -root -children -display "$DISPLAY" 2> /dev/null | grep -q -i 'render probe\|chrome\|chromium'; then
    window="$(xwininfo -root -children -display "$DISPLAY" 2> /dev/null | grep -i 'render probe\|chrome\|chromium' | head -n 3)"
    break
  fi
  if ! kill -0 "$BROWSER_PID" 2> /dev/null; then break; fi
  sleep 1
  waited=$((waited + 1))
done

printf '\n-- window on the display after %ss\n' "$waited"
if [ -n "$window" ]; then
  printf '%s\n' "$window"
else
  printf 'no browser window appeared on %s\n' "$DISPLAY"
fi

# Give the first paint time to land, then capture. An xwd dump of a fixed screen
# is always the same length, so the size alone says nothing about drawing: the
# number of bytes that differ from the empty root is the measurement of the paint.
sleep 3
xwd -root -display "$DISPLAY" > "$WORK/after.xwd" 2> /dev/null
printf '\n-- root window with the page rendered\n'
printf 'root capture %s bytes\n' "$($WC -c < "$WORK/after.xwd")"
printf 'distinct bytes changed vs empty root: %s\n' "$(cmp -l "$WORK/before.xwd" "$WORK/after.xwd" 2> /dev/null | $WC -l)"

# The window's own pixels, which is the narrowest evidence that the browser drew.
window_id="$(xwininfo -root -children -display "$DISPLAY" 2> /dev/null | grep -i 'render probe' | head -n 1 | awk '{print $1}')"
if [ -n "$window_id" ]; then
  xwd -id "$window_id" -display "$DISPLAY" > "$WORK/window.xwd" 2> /dev/null
  printf 'window %s capture %s bytes\n' "$window_id" "$($WC -c < "$WORK/window.xwd")"
fi

printf '\n-- browser process\n'
if kill -0 "$BROWSER_PID" 2> /dev/null; then
  printf 'pid %s still running after the capture\n' "$BROWSER_PID"
else
  printf 'pid %s exited before the capture\n' "$BROWSER_PID"
fi
printf 'browser log tail:\n'
tail -n 5 "$WORK/browser.log" 2> /dev/null | sed 's/^/  /'
