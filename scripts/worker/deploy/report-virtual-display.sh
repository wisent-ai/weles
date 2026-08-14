#!/bin/bash
# What this Linux host can offer a headed browser, measured rather than assumed.
#
# The worker's Linux launcher execs the worker under `xvfb-run`, which is the
# whole reason a Linux host can hold the `display` capability with nobody logged
# in. That claim is only true while the binary and the X server it starts are
# actually installed, and an absent `xvfb-run` fails at exec time -- inside
# systemd, where the failure reads as the worker crash-looping rather than as a
# missing package. So print the facts a deployment decision needs: which display
# tools exist, which X sockets are live, and what DISPLAY the running worker
# inherited.
#
# Prints measurements, never a verdict, and exits zero even when a tool is
# absent: absence is the measurement.
set -u

printf '== display tooling\n'
for tool in xvfb-run Xvfb xdpyinfo x11vnc weston Xwayland; do
  path="$(command -v "$tool" 2>/dev/null || true)"
  if [ -n "$path" ]; then
    printf '%-10s %s\n' "$tool" "$path"
  else
    printf '%-10s absent\n' "$tool"
  fi
done

printf '\n== package state\n'
if command -v dpkg-query > /dev/null 2>&1; then
  for pkg in xvfb x11-utils; do
    state="$(dpkg-query -W -f='${Status} ${Version}' "$pkg" 2>/dev/null || true)"
    printf '%-10s %s\n' "$pkg" "${state:-not installed}"
  done
else
  printf 'dpkg-query absent; not a Debian-family host\n'
fi

printf '\n== live X sockets\n'
sockets="$(ls /tmp/.X11-unix 2>/dev/null || true)"
printf '%s\n' "/tmp/.X11-unix: ${sockets:-none}"
printf 'XDG_RUNTIME_DIR wayland: '
ls "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}" 2>/dev/null | grep -c '^wayland-' || printf '0\n'

printf '\n== X servers running\n'
ps -eo pid,comm,args 2>/dev/null | grep -E '[X]vfb|[X]org|[X]wayland' || printf 'none\n'

printf '\n== worker process environment\n'
worker_pid="$(pgrep -f 'weles/scripts/worker/run.mjs' | head -n 1 || true)"
if [ -n "$worker_pid" ]; then
  printf 'worker pid %s\n' "$worker_pid"
  # A worker that inherited no DISPLAY cannot lend one to a trajectory it spawns,
  # which is exactly the failure this whole capability model exists to name.
  tr '\0' '\n' < "/proc/$worker_pid/environ" 2>/dev/null | grep -E '^(DISPLAY|WAYLAND_DISPLAY|XAUTHORITY)=' || printf 'no DISPLAY in worker environment\n'
else
  printf 'no weles worker process running\n'
fi

printf '\n== unit state\n'
systemctl --user is-active weles-worker 2>/dev/null || true
systemctl is-active weles-worker 2>/dev/null || true

printf '\n== chromium the worker would use\n'
for candidate in "$HOME/weles/var/chromium/chrome-linux/chrome" "$HOME/.cache/ms-playwright"; do
  if [ -e "$candidate" ]; then
    printf '%s exists\n' "$candidate"
  else
    printf '%s absent\n' "$candidate"
  fi
done
find "$HOME/.cache/ms-playwright" -maxdepth 3 \( -name 'chrome' -o -name 'headless_shell' \) 2>/dev/null | while read -r found; do
  printf 'playwright browser %s\n' "$found"
done
for tool in chromium chromium-browser google-chrome google-chrome-stable node apt-get; do
  path="$(command -v "$tool" 2>/dev/null || true)"
  printf '%-22s %s\n' "$tool" "${path:-absent}"
done

printf '\n== weles tree\n'
for tree in "$HOME/weles" /home/lukaszbartoszcze/weles; do
  if [ -e "$tree" ]; then
    printf '%s -> %s\n' "$tree" "$(readlink -f "$tree")"
  else
    printf '%s absent\n' "$tree"
  fi
done
printf 'running as uid %s (%s), HOME=%s\n' "$(id -u)" "$(id -un)" "$HOME"

printf '\n== browser packages this distribution offers\n'
# Which of these is a real .deb matters: an Ubuntu package that is only a snap
# transitional cannot render under Xvfb without snapd, so the choice of browser
# for a virtual display is a measurement, not a preference.
if command -v apt-cache > /dev/null 2>&1; then
  for pkg in chromium chromium-browser google-chrome-stable firefox firefox-esr; do
    printf '%s: %s\n' "$pkg" "$(apt-cache policy "$pkg" 2>/dev/null | tr -s ' \n' ' ')"
  done
fi
printf 'snap: %s\n' "$(command -v snap 2>/dev/null || printf 'absent')"
printf 'weles chromium installs: %s\n' "$(ls -d "$HOME"/.local/share/weles-chromium/*/ 2>/dev/null | tr '\n' ' ' || printf 'none')"
