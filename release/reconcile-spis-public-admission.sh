#!/bin/bash
set -euo pipefail
umask 077

mode=""
host="charless-mac-mini"
version="0.5.56"
source_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
trust_file=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    prepare|activate)
      [ -z "$mode" ] || { printf 'mode specified more than once\n' >&2; exit 2; }
      mode="$1"
      ;;
    --host)
      host="$2"; shift
      ;;
    --version)
      version="$2"; shift
      ;;
    --source)
      source_root="$2"; shift
      ;;
    --spis-trust-file)
      trust_file="$2"; shift
      ;;
    *)
      printf 'unknown argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
  shift
done
[ "$mode" = "prepare" ] || [ "$mode" = "activate" ] || {
  printf 'usage: %s prepare|activate --spis-trust-file PATH [--host HOST] [--version VERSION] [--source WELES_CHECKOUT]\n' "$0" >&2
  exit 2
}
[ -n "$trust_file" ] || { printf '%s\n' '--spis-trust-file is required' >&2; exit 2; }
[ -d "$source_root" ] || { printf 'Weles source directory is unavailable: %s\n' "$source_root" >&2; exit 2; }
[ -d "$(dirname "$trust_file")" ] || { printf 'Spis trust-file parent is unavailable: %s\n' "$(dirname "$trust_file")" >&2; exit 2; }

stado="${STADO_BIN:-$HOME/.stado/bin/stado}"
node="${NODE_BIN:-/opt/homebrew/bin/node}"
curl="${CURL_BIN:-/usr/bin/curl}"
[ -x "$stado" ] || { printf 'required Stado binary is unavailable: %s\n' "$stado" >&2; exit 1; }
[ -x "$node" ] || { printf 'required Node runtime is unavailable: %s\n' "$node" >&2; exit 1; }
[ -x "$curl" ] || { printf 'required curl is unavailable: %s\n' "$curl" >&2; exit 1; }
reconciler="$source_root/release/spis-public-admission-reconcile.mjs"
generator="$source_root/release/generate-spis-public-admission-credential.mjs"
[ -f "$reconciler" ] && [ -f "$generator" ] || { printf '%s\n' 'Weles onboarding artifacts are incomplete' >&2; exit 1; }

work_root="$HOME/.stado/work/weles/spis-public-admission"
mkdir -p "$work_root"
chmod 700 "$HOME/.stado/work" "$HOME/.stado/work/weles" "$work_root"
temporary="$work_root/$(date -u +%Y%m%dT%H%M%SZ)-$$"
(umask 077; mkdir "$temporary")
cleanup() { rm -rf "$temporary"; }
trap cleanup EXIT HUP INT TERM
service_snapshot="${WELES_PUBLIC_SERVICE_DIRECTORY_FILE:-$HOME/.stado/forwards/weles-admission.directory.json}"

"$stado" credentials ls --json >"$temporary/credentials.json"
credential_present=0
if "$node" "$reconciler" credential-present "$temporary/credentials.json"; then
  credential_present=1
else
  result=$?
  [ "$result" -eq 3 ] || exit "$result"
fi
if [ "$credential_present" -eq 0 ]; then
  "$node" "$generator" \
    | "$stado" host vault-item-put "$host" weles-spis-public-admission --type internal-authority --json \
      >"$temporary/vault-put.json"
  "$stado" credentials ls --json >"$temporary/credentials-after.json"
  "$node" "$reconciler" credential-present "$temporary/credentials-after.json"
fi

"$stado" credentials get weles-spis-public-admission --field organization_id >"$temporary/organization-id"
"$stado" credentials get weles-spis-public-admission --field receipt_key_set_version >"$temporary/key-set-version"
"$stado" credentials get weles-spis-public-admission --field receipt_public_keys_json >"$temporary/public-keys.json"
"$node" "$reconciler" render-trust \
  "$temporary/organization-id" \
  "$temporary/key-set-version" \
  "$temporary/public-keys.json" \
  "$temporary/receipt-trust.json"

if [ "$mode" = "prepare" ]; then
  [ ! -L "$trust_file" ] || { printf 'refusing symlinked Spis trust file: %s\n' "$trust_file" >&2; exit 1; }
  if [ -f "$trust_file" ] && cmp -s "$temporary/receipt-trust.json" "$trust_file"; then
    printf 'Spis receipt trust is already prepared at %s\n' "$trust_file"
    exit 0
  fi
  trust_candidate="$(dirname "$trust_file")/.spis-weles-receipt-trust.$$.new"
  install -m 644 "$temporary/receipt-trust.json" "$trust_candidate"
  mv -f "$trust_candidate" "$trust_file"
  printf 'prepared real Spis receipt trust at %s; commit it before activation\n' "$trust_file"
  exit 0
fi

[ -f "$trust_file" ] && [ ! -L "$trust_file" ] || {
  printf 'checked-in Spis receipt trust is unavailable: %s\n' "$trust_file" >&2
  exit 1
}
cmp -s "$temporary/receipt-trust.json" "$trust_file" || {
  printf 'checked-in Spis receipt trust does not match the active Skarbiec key set; run prepare and commit it first\n' >&2
  exit 1
}

source_revision="$(git -C "$source_root" rev-parse HEAD)"
case "$source_revision" in *[!0-9a-f]*|'') printf '%s\n' 'source revision is not a full lowercase Git commit' >&2; exit 1 ;; esac
[ "${#source_revision}" -eq 40 ] || { printf '%s\n' 'source revision must contain 40 hexadecimal characters' >&2; exit 1; }
[ -z "$(git -C "$source_root" status --porcelain --untracked-files=all)" ] || {
  printf '%s\n' 'activation requires an exact clean committed Weles source tree' >&2
  exit 1
}
"$stado" release submit --source "$source_root" --version "$version" --channel stable --json \
  >"$temporary/release-submit.json"
release_ready=0
for attempt in $(seq 1 120); do
  if "$stado" release status weles-worker --json >"$temporary/release-status.json" \
      && "$node" "$reconciler" release-settled \
        "$temporary/release-status.json" "$host" "$version" "$source_revision" \
        >"$temporary/release-identity.json"; then
    release_ready=1
    break
  fi
  sleep 5
done
[ "$release_ready" -eq 1 ] || {
  printf '%s\n' 'managed release did not converge to the exact healthy version, source, and digest' >&2
  exit 1
}
"$stado" registry pull >"$temporary/registry-before-admission.json"
"$node" "$reconciler" registry \
  "$temporary/registry-before-admission.json" "$temporary/registry-candidate.json" \
  "$host" "$version" "$source_revision" >"$temporary/registry-plan.json"
"$stado" registry validate "$temporary/registry-candidate.json" >/dev/null
registry_changed=0
if "$node" "$reconciler" plan-changed "$temporary/registry-plan.json"; then
  # Stado exposes its real registry CAS only to Rust callers
  # (`push_document_if`); `stado registry push` performs a fresh internal read
  # and cannot accept this snapshot's version. Narrow the unsupported CLI race:
  # refuse every observed change since the candidate's exact input, write once,
  # then verify the whole document. This is optimistic snapshot protection, not
  # an atomic compare-and-swap.
  "$stado" registry pull >"$temporary/registry-prewrite.json"
  "$node" "$reconciler" same \
    "$temporary/registry-before-admission.json" "$temporary/registry-prewrite.json" || {
    printf '%s\n' 'registry changed after admission planning; refusing overwrite' >&2
    exit 1
  }
  "$stado" registry push "$temporary/registry-candidate.json" >"$temporary/registry-write-receipt.txt"
  "$stado" registry pull >"$temporary/registry-committed.json"
  "$node" "$reconciler" same "$temporary/registry-candidate.json" "$temporary/registry-committed.json" || {
    printf '%s\n' 'registry post-write verification returned different bytes' >&2
    exit 1
  }
  registry_changed=1
else
  result=$?
  [ "$result" -eq 3 ] || exit "$result"
  /bin/cp "$temporary/registry-before-admission.json" "$temporary/registry-committed.json"
fi
endpoint="$("$node" -e '
  const fs = require("node:fs");
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (typeof value.endpoint !== "string") process.exit(1);
  process.stdout.write(value.endpoint);
' "$temporary/registry-plan.json")"
post_registry_ready=0
if "$stado" host publish-placement-policy "$host" --json >"$temporary/placement-policy.json" \
    && "$stado" directory publish weles-admission --target "$host" --json >"$temporary/directory-publication.json" \
    && "$node" "$reconciler" publish-service \
      "$temporary/registry-committed.json" "$service_snapshot" "$host"; then
  for attempt in $(seq 1 60); do
    if "$curl" --silent --show-error --fail --max-time 5 \
        "${endpoint%/api/v1}/api/v1/version" >"$temporary/public-version.json" \
        && "$node" "$reconciler" version-ready \
          "$temporary/public-version.json" "$host" "$version" "$source_revision"; then
      post_registry_ready=1
      break
    fi
    sleep 2
  done
fi
if [ "$post_registry_ready" -ne 1 ]; then
  if [ "$registry_changed" -eq 1 ]; then
    "$stado" registry pull >"$temporary/registry-rollback-current.json"
    "$node" "$reconciler" same \
      "$temporary/registry-committed.json" "$temporary/registry-rollback-current.json" || {
      printf '%s\n' 'registry advanced after activation write; refusing destructive rollback overwrite' >&2
      exit 1
    }
    # Rollback is a forward directory revision: restore the old content on top
    # of the committed generation, never push the captured lower generation.
    "$node" "$reconciler" rollback-registry \
      "$temporary/registry-before-admission.json" \
      "$temporary/registry-committed.json" \
      "$temporary/registry-rollback-candidate.json"
    "$stado" registry validate "$temporary/registry-rollback-candidate.json" >/dev/null
    "$stado" registry pull >"$temporary/registry-rollback-prewrite.json"
    "$node" "$reconciler" same \
      "$temporary/registry-committed.json" "$temporary/registry-rollback-prewrite.json" || {
      printf '%s\n' 'registry changed during rollback planning; refusing overwrite' >&2
      exit 1
    }
    "$stado" registry push "$temporary/registry-rollback-candidate.json" \
      >"$temporary/registry-rollback-write-receipt.txt"
    "$stado" registry pull >"$temporary/registry-rollback-verify.json"
    "$node" "$reconciler" same \
      "$temporary/registry-rollback-candidate.json" "$temporary/registry-rollback-verify.json" || {
      printf '%s\n' 'registry rollback verification returned different bytes' >&2
      exit 1
    }
  else
    /bin/cp "$temporary/registry-committed.json" "$temporary/registry-rollback-verify.json"
  fi
  "$stado" host publish-placement-policy "$host" --json >"$temporary/rollback-placement-policy.json" || true
  "$stado" directory publish weles-admission --target "$host" --json >"$temporary/rollback-directory-publication.json" || true
  "$node" "$reconciler" publish-service \
    "$temporary/registry-rollback-verify.json" "$service_snapshot" "$host" || true
  "$stado" release rollback weles-worker --json >"$temporary/release-rollback.json" || true
  printf '%s\n' 'post-registry readiness failed; forward registry restoration and managed release rollback were requested' >&2
  exit 1
fi
printf 'activated weles-worker %s (%s) on %s with the exact Spis browser-evidence binding\n' \
  "$version" "$source_revision" "$host"
