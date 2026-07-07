#!/bin/bash
# Mac launchd wrapper: sources a per-instance env file, self-provisions the
# skarbiec binary, delivers the encrypted vault, decrypts the real vault into an
# owner-only view, then execs node. Every skarbiec dependency self-heals on each
# launch (mirrors the gcloud SA self-heal in auto-deploy.sh). skarbiec is the
# source of truth: the worker decrypts the real vault ciphertext, never rebuilds
# from any plaintext store.
# PATH must include /opt/homebrew/bin so worker-spawned trajectories can use bare `node`.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
# Required by the patched Firefox Playwright/Juggler path on macOS; mirrors
# .github/workflows/firefox-integration.yml.
export MOZ_DISABLE_CONTENT_SANDBOX="${MOZ_DISABLE_CONTENT_SANDBOX:-1}"
WELES_WORKER_ENV_FILE="${WELES_WORKER_ENV_FILE:-$HOME/weles/var/worker.env}"
if [ ! -r "$WELES_WORKER_ENV_FILE" ]; then
  echo "missing readable Weles worker env file: $WELES_WORKER_ENV_FILE" >&2
  exit 1
fi
# Reject a syntactically broken env file up front. Sourcing `set -a`-style
# aborts mid-file on an unquoted value (e.g. a regex with `(` or `|`), which
# would export only the vars before the bad line and silently start the worker
# with a half-loaded env — the exact cause of a content worker claiming jobs
# outside its WELES_ACTION_ALLOW_RE scope. Fail loud instead.
if ! bash -n "$WELES_WORKER_ENV_FILE" 2>/dev/null; then
  echo "Weles worker env file has a syntax error (quote values with regex/special chars): $WELES_WORKER_ENV_FILE" >&2
  exit 1
fi
set -a
. "$WELES_WORKER_ENV_FILE"
set +a
mkdir -p "$HOME/weles/var"
SECRETS_DIR="$HOME/.weles-secrets"
mkdir -p "$SECRETS_DIR"; chmod go-rwx "$SECRETS_DIR"
SKARBIEC_LOG="$HOME/weles/var/skarbiec.log"
SKARBIEC_ASSET_HELPER="${SKARBIEC_ASSET_HELPER:-$HOME/weles/scripts/worker/deploy/gh_release_asset_url.mjs}"
SKARBIEC_CRED_FILE="${SKARBIEC_CRED_FILE:-$HOME/.git-credentials-weles}"
SKARBIEC_REPO_API="${SKARBIEC_REPO_API:-https://api.github.com/repos/wisent-ai/weles}"

# fetch_release_asset <tag> <asset-name> <dest>: download a release asset from
# this repo using the worker's existing weles token, curl, and node — no gh, no
# jq, no cross-repo auth. Returns nonzero on any miss so callers keep prior state.
fetch_release_asset() {
  [ -f "$SKARBIEC_CRED_FILE" ] && [ -f "$SKARBIEC_ASSET_HELPER" ] || return 1
  local tok rel url
  tok="$(sed -E 's#^https://[^:]*:([^@]*)@.*#\1#' "$SKARBIEC_CRED_FILE" | awk 'NF{print; exit}')"
  rel="$(curl -fsSL -H "Authorization: Bearer $tok" -H "Accept: application/vnd.github+json" "$SKARBIEC_REPO_API/releases/tags/$1" 2>>"$SKARBIEC_LOG")"
  url="$(printf '%s' "$rel" | node "$SKARBIEC_ASSET_HELPER" "$2")"
  [ -n "$url" ] || return 1
  curl -fsSL -H "Authorization: Bearer $tok" -H "Accept: application/octet-stream" "$url" -o "$3" 2>>"$SKARBIEC_LOG"
}

# --- skarbiec binary self-provision (from the weles rolling release) -------
SKARBIEC_BIN="${SKARBIEC_BIN:-$SECRETS_DIR/skarbiec-entitlements-router}"
STAGE="$(mktemp -d)"
if fetch_release_asset skarbiec-bin-latest skarbiec-entitlements-router "$STAGE/bin" \
   && fetch_release_asset skarbiec-bin-latest skarbiec-entitlements-router.sha256 "$STAGE/sha"; then
  WANT="$(awk 'NF{print $1; exit}' "$STAGE/sha" 2>/dev/null)"
  GOT="$(openssl dgst -sha256 "$STAGE/bin" 2>/dev/null | awk '{print $NF}')"
  if [ -n "$WANT" ] && [ "$WANT" = "$GOT" ]; then
    chmod +x "$STAGE/bin"
    mv -f "$STAGE/bin" "$SKARBIEC_BIN"
  fi
fi
rm -rf "$STAGE"

# --- skarbiec owner material self-heal (out-of-band, like the gcloud SA) ----
# The passphrase-protected owner private half is placed once at this path (same
# tier and channel as the gcloud SA material), never in the repo or a release.
# Import it into the keyring when the keyring lacks it. The unlock value gates
# decrypt separately below.
SKARBIEC_OWNER_KEY="${SKARBIEC_OWNER_KEY:-$SECRETS_DIR/skarbiec-owner.asc}"
if [ -f "$SKARBIEC_OWNER_KEY" ] && ! gpg --list-keys skarbiec-owner >/dev/null 2>&1; then
  gpg --batch --import "$SKARBIEC_OWNER_KEY" >>"$SKARBIEC_LOG" 2>&1 || true
fi

# --- skarbiec vault delivery (ciphertext from the weles release) -----------
# The vault is gpg ciphertext (encrypted to owner + recovery), safe to publish;
# reading the release alone cannot decrypt it. Refreshed each launch from the
# release; otherwise the previously staged copy is used.
export SKARBIEC_VAULT_FILE="${SKARBIEC_VAULT_FILE:-$SECRETS_DIR/skarbiec.vault.json}"
STAGEV="$(mktemp -d)"
if fetch_release_asset skarbiec-vault-latest skarbiec.vault.json "$STAGEV/v"; then
  mv -f "$STAGEV/v" "$SKARBIEC_VAULT_FILE"
  chmod go-rwx "$SKARBIEC_VAULT_FILE"
fi
rm -rf "$STAGEV"

# --- decrypt the real vault -> owner-only view -----------------------------
# skarbiec is the source of truth: decrypt the delivered vault ciphertext with
# the owner key (unlocked by a login-keychain item if an operator set one, else
# the configured value), and point the worker at the resulting view. No plaintext
# store is read.
SKARBIEC_VIEW="${SKARBIEC_VIEW:-$HOME/weles/var/skarbiec-weles.json}"
if [ -x "$SKARBIEC_BIN" ] && [ -f "$SKARBIEC_VAULT_FILE" ]; then
  UNLOCK="$(security find-generic-password -s skarbiec-vault -w 2>/dev/null || printf '%s' "${SKARBIEC_UNLOCK:-}")"
  if SKARBIEC_UNLOCK="$UNLOCK" "$SKARBIEC_BIN" export "$SKARBIEC_VIEW" >>"$SKARBIEC_LOG" 2>&1; then
    export WELES_SERVICE_CREDENTIALS_FILE="$SKARBIEC_VIEW"
  fi
  unset UNLOCK
fi

exec /usr/bin/caffeinate -dimsu /opt/homebrew/bin/node "$HOME/weles/scripts/worker/run.mjs"
