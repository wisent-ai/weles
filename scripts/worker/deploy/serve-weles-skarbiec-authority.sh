#!/bin/sh
# Serve the Weles Skarbiec authority: the vault that holds Weles login accounts
# and their scoped acquisition grants.
#
# Weles resolves every login through this authority, so when it is not running
# every acquisition fails with `unauthorized` or ECONNREFUSED — which reads as a
# broken grant while the grant is intact. It had been started by hand, so nothing
# brought it back when it exited and the worker environment was pointed at the
# fleet authority instead, which holds different accounts. This script exists so
# the authority can be a managed unit with a declaration naming its port and its
# vault, rather than a process someone remembered to start.
set -eu

PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export PATH

SKARBIEC_BIN="${SKARBIEC_BIN:-$HOME/.stado/bin/skarbiec}"
SKARBIEC_VAULT_FILE="${SKARBIEC_VAULT_FILE:-$HOME/.stado/weles-skarbiec.vault.json}"
SKARBIEC_AUDIT_FILE="${SKARBIEC_AUDIT_FILE:-$HOME/.stado/weles-skarbiec.audit.jsonl}"
WELES_AUTHORITY_PORT="${WELES_AUTHORITY_PORT:-19095}"
export SKARBIEC_VAULT_FILE SKARBIEC_AUDIT_FILE

[ -x "$SKARBIEC_BIN" ] || { printf 'no executable Skarbiec at %s\n' "$SKARBIEC_BIN" >&2; exit 1; }
[ -r "$SKARBIEC_VAULT_FILE" ] || { printf 'no readable Weles vault at %s\n' "$SKARBIEC_VAULT_FILE" >&2; exit 1; }

exec "$SKARBIEC_BIN" serve --port "$WELES_AUTHORITY_PORT"
