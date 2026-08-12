#!/bin/sh
set -eu
export SKARBIEC_VAULT_FILE="$HOME/.stado/skarbiec.vault.json"
exec "$HOME/.stado/bin/skarbiec" set-json --help
