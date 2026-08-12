#!/bin/sh
set -eu
set -a
. "$HOME/.config/weles/worker.env"
set +a
export PATH="/usr/local/MacGPG2/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export SKARBIEC_VAULT_FILE="$HOME/.stado/skarbiec.vault.json"
exec /opt/homebrew/bin/node "$HOME/.stado/files/provision-figma-skarbiec-reader-host.mjs"
