#!/bin/sh
# Reconcile the Weles workload with the exact tracked field-acquisition catalog.
set -eu
umask 077

home=${HOME:?HOME is required}
stado="${STADO_BIN:-$home/.stado/bin/stado}"
node="${NODE_BIN:-/opt/homebrew/bin/node}"
for executable in "$stado" "$node"; do
  [ -x "$executable" ] || {
    printf 'required executable is unavailable: %s\n' "$executable" >&2
    exit 1
  }
done
if ! active_release=$("$stado" release active-binary skarbiec --json); then
  printf 'Stado has no attested active Skarbiec binary for this host\n' >&2
  exit 1
fi
if ! bin=$(printf '%s' "$active_release" | "$node" -e '
  const active = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  const value = active?.path;
  if (active?.state !== "active" || typeof value !== "string" || !value.startsWith("/")) {
    process.exit(1);
  }
  process.stdout.write(value);
'); then
  printf 'Stado returned an invalid active Skarbiec release record\n' >&2
  exit 1
fi
unset active_release
if [ ! -x "$bin" ]; then
  printf 'attested active Skarbiec binary is not executable: %s\n' "$bin" >&2
  exit 1
fi
vault="$home/.stado/skarbiec.vault.json"
private_key="$home/.stado/weles-credential-workload-private.pem"
catalog="$home/.stado/build-work/weles-api-managed/scripts/worker/deploy/skarbiec-acquisition-scopes.conf"
openssl="/opt/homebrew/opt/openssl@3/bin/openssl"
PATH="/opt/homebrew/opt/openssl@3/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export PATH
public_key=$(mktemp "$home/.stado/weles-acquisition-public.XXXXXX")
new_private_key=
cleanup() {
  rm -f "$public_key"
  [ -z "$new_private_key" ] || rm -f "$new_private_key"
}
trap cleanup EXIT HUP INT TERM

for file in "$bin" "$vault" "$private_key" "$catalog" "$openssl"; do
  [ -f "$file" ] || {
    printf 'required Weles acquisition file is missing: %s\n' "$file" >&2
    exit 1
  }
done

candidate_key="$private_key"
key_description=$("$openssl" pkey -in "$private_key" -text -noout 2>/dev/null || true)
case "$key_description" in
  *ED25519*) ;;
  *)
    new_private_key=$(mktemp "$home/.stado/weles-acquisition-private.XXXXXX")
    "$openssl" genpkey -algorithm ED25519 -out "$new_private_key" >/dev/null 2>&1
    chmod 600 "$new_private_key"
    candidate_key="$new_private_key"
    ;;
esac
"$openssl" pkey -in "$candidate_key" -pubout -out "$public_key" >/dev/null 2>&1
SKARBIEC_VAULT_FILE="$vault" \
  "$bin" token-register-acquisitions "$catalog" \
    --workload-public-key-file "$public_key" \
    --replace-capabilities >/dev/null
SKARBIEC_VAULT_FILE="$home/.stado/skarbiec.vault.json" \
  "$bin" token-mint weles-credential-worker-local \
    --capabilities 'acquire:platform-admin-appstore#username,acquire:platform-admin-appstore#password' \
    --workload-public-key-file "$public_key" \
    --ttl-seconds 31536000 \
    --replace-capabilities >/dev/null
SKARBIEC_VAULT_FILE="$home/.stado/skarbiec.vault.json" \
  "$bin" token-mint weles-worker \
    --capabilities 'acquire:platform-admin-appstore#username,acquire:platform-admin-appstore#password' \
    --workload-public-key-file "$public_key" \
    --ttl-seconds 31536000 \
    --replace-capabilities >/dev/null
if [ "$candidate_key" != "$private_key" ]; then
  mv -f "$candidate_key" "$private_key"
  new_private_key=
fi

printf '{"status":"reconciled","catalog":"skarbiec-acquisition-scopes.conf"}\n'
