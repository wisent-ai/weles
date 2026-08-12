#!/bin/sh
# Reconcile the Weles workload with the exact tracked field-acquisition catalog.
set -eu
umask 077

home=${HOME:?HOME is required}
bin="$home/.stado/bin/skarbiec"
vault="$home/.stado/weles-skarbiec.vault.json"
private_key="$home/.stado/weles-credential-workload-private.pem"
catalog="$home/.stado/build-work/weles-api-managed/scripts/worker/deploy/skarbiec-acquisition-scopes.conf"
public_key=$(mktemp "$home/.stado/weles-acquisition-public.XXXXXX")
cleanup() {
  rm -f "$public_key"
}
trap cleanup EXIT HUP INT TERM

for file in "$bin" "$vault" "$private_key" "$catalog"; do
  [ -f "$file" ] || {
    printf 'required Weles acquisition file is missing: %s\n' "$file" >&2
    exit 1
  }
done

/opt/homebrew/opt/openssl@3/bin/openssl pkey \
  -in "$private_key" -pubout -out "$public_key" >/dev/null 2>&1
SKARBIEC_VAULT_FILE="$vault" \
  "$bin" token-register-acquisitions "$catalog" \
    --workload-public-key-file "$public_key" \
    --replace-capabilities >/dev/null

printf '{"status":"reconciled","catalog":"skarbiec-acquisition-scopes.conf"}\n'
