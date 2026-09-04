#!/bin/sh
set -eu
export SKARBIEC_VAULT_FILE="$HOME/.stado/skarbiec.vault.json"
exec /opt/homebrew/bin/node "$HOME/weles/scripts/operations/provision-figma-skarbiec-writer-host.mjs"
