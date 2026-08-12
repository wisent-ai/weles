#!/bin/sh
# Report the endpoint variables the ACTIVE worker release's launcher sets.
#
#   stado host install-helper <target> \
#     scripts/worker/deploy/report-launcher-env.sh report-launcher-env
#   stado host run-helper <target> report-launcher-env
#
# The launcher decides these at spawn, so a running worker holds whatever the
# release it was started from declared. Reading the deployed file is the only
# way to tell a fix that shipped from a fix that was written: on 2026-08-11 a
# corrected STADO_API_URL was committed to main while the host kept running an
# earlier release, and the symptom -- Node reporting a bare `fetch failed` --
# looks identical either way.
#
# Read-only, and it names the release it read so the answer cannot be attributed
# to the wrong tree.
set -eu

link="$HOME/weles"
release=$(readlink "$link" 2>/dev/null || printf '%s' "$link")
launcher="$release/scripts/worker/deploy/launch-mac.sh"

printf 'RELEASE\t%s\n' "$release"
if [ ! -f "$launcher" ]; then
  printf 'LAUNCHER\tmissing\t%s\n' "$launcher"
  exit 0
fi
printf 'LAUNCHER\t%s\n' "$launcher"
/usr/bin/grep -nE '^export (STADO_API_URL|STADO_OBJECT_API_URI|STADO_MODEL_ROUTER_URL|WC_SKARBIEC_URL)=' "$launcher" \
  | while IFS= read -r line; do printf 'SETS\t%s\n' "$line"; done

# The launcher writes these with `${VAR:-default}`, which defers to anything the
# operator env already set. That politeness is the trap: a stale value in
# worker.env silently outranks a corrected default that shipped in the release,
# and the running process shows no sign of which one won.
operator="$HOME/.config/weles/worker.env"
if [ -f "$operator" ]; then
  printf 'OPERATOR_ENV\t%s\n' "$operator"
  /usr/bin/grep -nE '^ *(export )?(STADO_API_URL|STADO_OBJECT_API_URI|STADO_MODEL_ROUTER_URL|WC_SKARBIEC_URL)=' "$operator" \
    | while IFS= read -r line; do printf 'OVERRIDES\t%s\n' "$line"; done
else
  printf 'OPERATOR_ENV\tabsent\t%s\n' "$operator"
fi
