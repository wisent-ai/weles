#!/bin/sh
# Issue one-use Cloudflare login capabilities beside the Weles API broker.
set -eu

export SKARBIEC_VAULT_FILE="$HOME/.stado/skarbiec.vault.json"
export SKARBIEC_CAPABILITY_FILE="$HOME/.stado/weles-api-capabilities.json"
export SKARBIEC_CAPABILITY_ROUTES_FILE="$HOME/.stado/weles-api-capability-routes.json"
cat > "$SKARBIEC_CAPABILITY_ROUTES_FILE" <<'JSON'
{
  "origin:https://dash.cloudflare.com/email": {"item": "platform-admin-cloudflare", "field": "username"},
  "origin:https://dash.cloudflare.com/password": {"item": "platform-admin-cloudflare", "field": "password"}
}
JSON
chmod u=rw,go= "$SKARBIEC_CAPABILITY_ROUTES_FILE"

skarbiec="$HOME/.stado/bin/skarbiec"
email="$($skarbiec capability-issue --agent weles-object-token-bootstrap --purpose weles.browser.fill --resource origin:https://dash.cloudflare.com/email --target weles)"
password="$($skarbiec capability-issue --agent weles-object-token-bootstrap --purpose weles.browser.fill --resource origin:https://dash.cloudflare.com/password --target weles)"
printf '{"email":%s,"password":%s}\n' "$email" "$password"
