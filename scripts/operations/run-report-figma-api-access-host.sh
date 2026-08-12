#!/bin/sh
set -eu
archive="$HOME/.stado/files/weles-figma-acquisition.tar.gz"
runtime="$HOME/.stado/weles-figma-acquisition"
mkdir -p "$runtime"
tar -xzf "$archive" -C "$runtime"
set -a
. "$HOME/.config/weles/worker.env"
set +a
export WELES_CREDENTIAL_SKARBIEC_URL="${WELES_CREDENTIAL_SKARBIEC_URL:-http://127.0.0.1:8895}"
export SKARBIEC_WELES_READER_COMMAND="$runtime/scripts/worker/deploy/skarbiec-acquire.mjs"
export SKARBIEC_WELES_ACQUISITION_SCOPES_FILE="$runtime/scripts/worker/deploy/skarbiec-acquisition-scopes.conf"
exec /opt/homebrew/bin/node "$HOME/.stado/files/report-figma-api-access-host.mjs"
