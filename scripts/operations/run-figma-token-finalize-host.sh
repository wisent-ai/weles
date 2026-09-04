#!/bin/sh
set -eu
archive="$HOME/.stado/files/weles-figma-acquisition.tar.gz"
runtime="$HOME/.stado/weles-figma-acquisition"
mkdir -p "$runtime"
tar -xzf "$archive" -C "$runtime"
if [ ! -e "$runtime/node_modules" ]; then ln -s "$HOME/weles/node_modules" "$runtime/node_modules"; fi
set -a
. "$HOME/.config/weles/worker.env"
set +a
export PATH="/usr/local/MacGPG2/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export GNUPGHOME="$HOME/.gnupg"
export STADO_BIN="$HOME/.stado/bin/stado"
WC_SKARBIEC_URL=$(/opt/homebrew/bin/node "$runtime/scripts/_shared/skarbiec-runtime.mjs" endpoint)
export WC_SKARBIEC_URL
export SKARBIEC_WELES_WRITER_COMMAND="$runtime/scripts/worker/deploy/skarbiec-write.mjs"
export WELES_USER_DATA_DIR="$HOME/.local/state/weles/browser-profiles/figma-token"
log="$HOME/.stado/weles-figma-token-finalize.log"
if /opt/homebrew/bin/node "$runtime/scripts/operations/finalize-figma-token-host.mjs" >"$log" 2>&1; then
  tail -n 1 "$log"
else
  grep '"candidates"' "$log" | tail -n 1 >&2 || true
  tail -n 8 "$log" >&2
  exit 1
fi
