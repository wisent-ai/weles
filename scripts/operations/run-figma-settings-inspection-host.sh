#!/bin/sh
set -eu

archive="$HOME/.stado/files/weles-figma-acquisition.tar.gz"
runtime="$HOME/.stado/weles-figma-acquisition"
[ -f "$archive" ] || { printf '%s\n' 'missing Weles Figma acquisition archive' >&2; exit 1; }
mkdir -p "$runtime"
tar -xzf "$archive" -C "$runtime"
if [ ! -e "$runtime/node_modules" ]; then
  ln -s "$HOME/weles/node_modules" "$runtime/node_modules"
fi
set -a
. "$HOME/.config/weles/worker.env"
set +a
export STADO_BIN="$HOME/.stado/bin/stado"
export WELES_USER_DATA_DIR="$HOME/.local/state/weles/browser-profiles/figma-token"
log="$HOME/.stado/weles-figma-settings-inspection.log"
/opt/homebrew/bin/node "$runtime/scripts/operations/inspect-figma-settings-host.mjs" >"$log"
tail -n 1 "$log"
