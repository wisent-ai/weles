#!/bin/sh
# Report non-secret Weles capability identity and broker configuration.
set -eu

set -a
if [ -f "$HOME/.config/weles/worker.env" ]; then
  . "$HOME/.config/weles/worker.env"
fi
set +a
printf 'workload_id=%s\n' "${SKARBIEC_WORKLOAD_ID:-missing}"
printf 'signing_key=%s\n' "${SKARBIEC_WORKLOAD_SIGNING_KEY_FILE:-missing}"
if [ -n "${SKARBIEC_WORKLOAD_SIGNING_KEY_FILE:-}" ] && [ -f "$SKARBIEC_WORKLOAD_SIGNING_KEY_FILE" ]; then
  printf '%s\n' 'signing_key_present=true'
else
  printf '%s\n' 'signing_key_present=false'
fi
if [ -n "${SKARBIEC_WORKLOAD_SIGNING_KEY_FILE:-}" ] && [ -f "$SKARBIEC_WORKLOAD_SIGNING_KEY_FILE" ]; then
  algorithm='256'
  openssl_version='openssl@3'
  "/opt/homebrew/opt/$openssl_version/bin/openssl" pkey -in "$SKARBIEC_WORKLOAD_SIGNING_KEY_FILE" -pubout \
    | shasum -a "$algorithm" \
    | sed 's/  -$/  workload-public-key/'
fi
printf 'capability_state=%s\n' "$HOME/.stado/weles-api-capabilities.json"
skarbiec=$(/opt/homebrew/bin/node "$HOME/weles/scripts/_shared/skarbiec-runtime.mjs" active-binary)
printf 'capability_routes=%s\n' "$HOME/.stado/weles-api-capability-routes.json"
SKARBIEC_VAULT_FILE="$HOME/.stado/skarbiec.vault.json" \
  "$skarbiec" tokens \
  | /opt/homebrew/bin/node -e '
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const rows = JSON.parse(input);
      console.log(`weles_vault_workload=${rows.some((row) => row.consumer === "weles-credential-worker-local")}`);
    });
  '
SKARBIEC_VAULT_FILE="$HOME/.stado/skarbiec.vault.json" \
  "$skarbiec" list \
  | /opt/homebrew/bin/node -e '
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const rows = JSON.parse(input);
      const active = (id) => rows.some((row) => row.id === id && row.state === "active");
      console.log(`weles_vault_cloudflare_login=${active("platform-admin-cloudflare")}`);
      console.log(`weles_vault_apple_login=${active("platform-admin-appstore")}`);
    });
  '
