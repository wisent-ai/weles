#!/bin/sh
set -eu
archive="$HOME/.stado/files/weles-figma-exporter.tar.gz"
runtime="$HOME/.stado/weles-figma-exporter"
rm -rf "$runtime"
mkdir -p "$runtime"
tar -xzf "$archive" -C "$runtime"
set -a
. "$HOME/.config/weles/worker.env"
set +a
export WELES_CREDENTIAL_SKARBIEC_URL="${WELES_CREDENTIAL_SKARBIEC_URL:-http://127.0.0.1:8895}"
export SKARBIEC_WELES_READER_COMMAND="$runtime/scripts/worker/deploy/skarbiec-acquire.mjs"
export SKARBIEC_WELES_ACQUISITION_SCOPES_FILE="$runtime/scripts/worker/deploy/skarbiec-acquisition-scopes.conf"
export FIGMA_JSON_PARSER="$runtime/scripts/operations/parse-json-file-host.py"
log="$HOME/.stado/weles-figma-export.log"
/opt/homebrew/bin/node "$runtime/scripts/operations/export-figma-design-assets-host.mjs" >"$log" 2>"$HOME/.stado/weles-figma-export.err"
tail -n 1 "$log"
