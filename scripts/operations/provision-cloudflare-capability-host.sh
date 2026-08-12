#!/bin/sh
# Provision the Weles-only Cloudflare login envelope and workload identity.
set -eu
PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export PATH

home=${HOME:?HOME is required}
bin="$home/.stado/bin/skarbiec"
main_vault="$home/.stado/skarbiec.vault.json"
weles_vault="$home/.stado/weles-skarbiec.vault.json"
private_key="$home/.stado/weles-credential-workload-private.pem"
public_key=$(mktemp "$home/.stado/weles-cloudflare-public.XXXXXX")
payload=$(mktemp "$home/.stado/weles-cloudflare-item.XXXXXX")
cleanup() {
  rm -f "$public_key" "$payload"
}
trap cleanup EXIT HUP INT TERM
chmod 600 "$public_key" "$payload"

for file in "$bin" "$main_vault" "$weles_vault" "$private_key"; do
  [ -f "$file" ] || {
    printf 'required file is missing: %s\n' "$file" >&2
    exit 1
  }
done

SKARBIEC_VAULT_FILE="$main_vault" \
  "$bin" get platform-admin-cloudflare \
  | jq '{schema, kind, fields, context}' > "$payload"

SKARBIEC_VAULT_FILE="$weles_vault" \
  "$bin" set-json platform-admin-cloudflare < "$payload" >/dev/null

/opt/homebrew/opt/openssl@3/bin/openssl pkey \
  -in "$private_key" -pubout -out "$public_key" >/dev/null 2>&1

SKARBIEC_VAULT_FILE="$weles_vault" \
  "$bin" token-mint weles-credential-worker-local \
  --capabilities acquire:platform-admin-cloudflare#username,acquire:platform-admin-cloudflare#password \
  --workload-public-key-file "$public_key" \
  --replace-capabilities \
  --ttl-seconds 2592000 >/dev/null

printf '{"status":"provisioned","item":"platform-admin-cloudflare","consumer":"weles-credential-worker-local"}\n'
