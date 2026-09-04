#!/bin/sh
set -eu
set -a
. "$HOME/.config/weles/worker.env"
set +a
WC_SKARBIEC_URL=$(/opt/homebrew/bin/node "$HOME/weles/scripts/_shared/skarbiec-runtime.mjs" endpoint)
export WC_SKARBIEC_URL
exec /opt/homebrew/bin/node "$HOME/weles/scripts/operations/report-figma-skarbiec-writer-auth-host.mjs"
