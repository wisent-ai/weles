#!/bin/sh
set -eu
set -a
. "$HOME/.config/weles/worker.env"
set +a
export SKARBIEC_VAULT_FILE="$HOME/.stado/skarbiec.vault.json"
exec /opt/homebrew/bin/node "$HOME/.stado/files/report-figma-vault-item-host.mjs"
