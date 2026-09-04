#!/bin/sh
set -eu
export SKARBIEC_VAULT_FILE="$HOME/.stado/skarbiec.vault.json"
skarbiec=$(/opt/homebrew/bin/node "$HOME/weles/scripts/_shared/skarbiec-runtime.mjs" active-binary)
exec "$skarbiec" set-json --help
