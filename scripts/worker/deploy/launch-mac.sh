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

# Semantic Scholar keys are resolved through Skarbiec, not inherited as
# process-wide environment variables. Clear legacy aliases after worker.env
# sourcing so stale launchd or sourced values cannot reach the Node worker.
unset SEMANTIC_SCHOLAR_API_KEY S2_API_KEY || true
mkdir -p "$HOME/weles/var"
SECRETS_DIR="$HOME/.weles-secrets"
mkdir -p "$SECRETS_DIR"; chmod go-rwx "$SECRETS_DIR"
SKARBIEC_LOG="$HOME/weles/var/skarbiec.log"
SKARBIEC_BIN="${SKARBIEC_BIN:-/usr/local/bin/skarbiec-entitlements-router}"
if [ ! -x "$SKARBIEC_BIN" ]; then
  echo "missing executable operator-provisioned Skarbiec binary: $SKARBIEC_BIN" >&2
  exit 1
fi
export SKARBIEC_CREDENTIAL_RETURN_COMMAND="${SKARBIEC_CREDENTIAL_RETURN_COMMAND:-$SKARBIEC_BIN}"

# Public recipient keys may be supplied by the Skarbiec installation. Weles
# neither vendors nor publishes them.
SKARBIEC_RECIPIENT_KEYS="${SKARBIEC_RECIPIENT_KEYS:-}"
if [ -n "$SKARBIEC_RECIPIENT_KEYS" ] && [ -f "$SKARBIEC_RECIPIENT_KEYS" ]; then
  gpg --batch --import "$SKARBIEC_RECIPIENT_KEYS" >>"$SKARBIEC_LOG" 2>&1 || true
fi

# --- skarbiec owner material self-heal (out-of-band, like the gcloud SA) ----
# The passphrase-protected owner private half is placed once at this path (same
# tier and channel as the gcloud SA material), never in the repo or a release.
# Import it into the keyring when the keyring lacks it. The unlock value gates
# decrypt separately below.
SKARBIEC_OWNER_KEY="${SKARBIEC_OWNER_KEY:-$SECRETS_DIR/skarbiec-owner.asc}"
if [ -f "$SKARBIEC_OWNER_KEY" ] && ! gpg --list-keys skarbiec-owner >/dev/null 2>&1; then
  gpg --batch --import "$SKARBIEC_OWNER_KEY" >>"$SKARBIEC_LOG" 2>&1 || true
fi

# --- operator-provisioned Skarbiec vault -----------------------------------
export SKARBIEC_VAULT_FILE="${SKARBIEC_VAULT_FILE:-}"
if [ -z "$SKARBIEC_VAULT_FILE" ] || [ ! -f "$SKARBIEC_VAULT_FILE" ]; then
  echo "missing operator-provisioned SKARBIEC_VAULT_FILE" >&2
  exit 1
fi

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
# The owner unlock is only for the one-time export above. Credential returns
# decrypt request items with the worker's dedicated recipient key instead.
unset SKARBIEC_UNLOCK

exec /usr/bin/caffeinate -dimsu /opt/homebrew/bin/node "$HOME/weles/scripts/worker/run.mjs"
