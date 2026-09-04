#!/bin/sh
set -eu
archive="$HOME/.stado/files/weles-figma-acquisition.tar.gz"
runtime="$HOME/.stado/weles-figma-acquisition"
mkdir -p "$runtime"
tar -xzf "$archive" -C "$runtime"
set -a
. "$HOME/.config/weles/worker.env"
set +a
WC_SKARBIEC_URL=$(/opt/homebrew/bin/node "$runtime/scripts/_shared/skarbiec-runtime.mjs" endpoint)
export WC_SKARBIEC_URL
export SKARBIEC_WELES_READER_COMMAND="$runtime/scripts/worker/deploy/skarbiec-acquire.mjs"
export SKARBIEC_WELES_ACQUISITION_SCOPES_FILE="$runtime/scripts/worker/deploy/skarbiec-acquisition-scopes.conf"
exec /opt/homebrew/bin/node "$runtime/scripts/operations/report-figma-api-access-host.mjs"
