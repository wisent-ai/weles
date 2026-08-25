#!/bin/bash
# The release coordinates this host's Weles deployment is pinned to.
#
# A second host can only deploy the same verified Chromium if it is told the same
# version and digest, and those live in one deployment env file per host. They are
# not secrets -- a version, a SHA-256 and a release API address -- but that file
# also carries bearers, so this prints an explicit allowlist of keys and nothing
# else. Every other line is counted, never shown.
#
# Prints measurements. Exits zero when the file exists, whatever it contains.
set -u

WELES_DIR="${WELES_DIR:-$HOME/weles}"
# A host that has no deployment yet is the one that needs to be told the
# coordinates, and a helper takes no operator arguments, so a delivered file under
# $HOME/.stado/files counts as a source too. That is how a candidate host is told
# what to deploy without putting a version on anybody's command line.
ENV_FILE=""
for candidate in \
  "${WELES_WORKER_ENV_FILE:-}" \
  "$HOME/.config/weles/worker.env" \
  "$WELES_DIR/var/worker.env" \
  "$HOME/.stado/files/weles-release-coordinates.env"; do
  [ -n "$candidate" ] || continue
  if [ -r "$candidate" ]; then ENV_FILE="$candidate"; break; fi
done
[ -n "$ENV_FILE" ] || ENV_FILE="$HOME/.config/weles/worker.env"

ALLOWED='^(WELES_WORKER_RELEASE_VERSION|WELES_WORKER_RELEASE_SHA256|WELES_CHROMIUM_RELEASE_VERSION|WELES_CHROMIUM_RELEASE_SHA256|WELES_FIREFOX_RELEASE_VERSION|WELES_FIREFOX_RELEASE_SHA256|WELES_RELEASE_PLATFORM|STADO_RELEASE_API_URL|STADO_RELEASE_LOCAL_ROOT|WELES_CHROMIUM_DIR)='

# A host with no deployment env file is the interesting case, not an error: it is
# the host that has to be told the coordinates, and the sections below are what
# tell whether it can be.
printf '== %s\n' "$ENV_FILE"
if [ -r "$ENV_FILE" ]; then
  printf 'total assignments: %s\n' "$(grep -c '^[A-Z_][A-Z0-9_]*=' "$ENV_FILE" 2> /dev/null || printf 0)"
  printf 'shown (allowlisted coordinates):\n'
  grep -E "$ALLOWED" "$ENV_FILE" 2> /dev/null | sed 's/^/  /' || printf '  none\n'
else
  printf 'no readable deployment env file here\n'
fi

printf '\n== what this host actually has installed\n'
CHROMIUM_ROOT="${WELES_CHROMIUM_DIR:-$HOME/.local/share/weles-chromium}"
if [ -d "$CHROMIUM_ROOT" ]; then
  for install in "$CHROMIUM_ROOT"/*/; do
    [ -d "$install" ] || continue
    printf '%s\n' "$install"
    [ -f "$install/.weles-release" ] && sed 's/^/  /' "$install/.weles-release"
  done
else
  printf '%s absent\n' "$CHROMIUM_ROOT"
fi


# Whether the archive a second host would need is staged here at all, and under
# which platform: a version that exists for darwin-arm64 and not for linux-amd64
# cannot be deployed on Linux however correct the coordinates are, and its digest
# is per platform, so the Linux digest has to come from the Linux archive.
printf '\n== staged weles-chromium archives\n'
STAGED_ROOT="${STADO_RELEASE_LOCAL_ROOT:-$HOME/.stado/releases}"
case "$STAGED_ROOT" in
  '$HOME'*) STAGED_ROOT="$HOME${STAGED_ROOT#\$HOME}" ;;
esac
printf 'store %s\n' "$STAGED_ROOT"
found=0
for archive in "$STAGED_ROOT"/weles-chromium/*/*/weles-chromium.tar.gz; do
  [ -f "$archive" ] || continue
  found=1
  printf '%s %s bytes sha256=%s\n' "${archive#"$STAGED_ROOT"/}" \
    "$(/usr/bin/wc -c < "$archive" | tr -d ' ')" \
    "$(openssl dgst -sha256 -r "$archive" 2> /dev/null | cut -d' ' -f1)"
done
[ "$found" = 1 ] || printf 'no weles-chromium archive staged under %s\n' "$STAGED_ROOT"

# Whether the release store this fleet actually serves from has the archive for
# each platform. A staged copy under one host's release root says nothing about
# another platform, and the digest is per archive, so a Linux deployment needs the
# Linux object to exist before any coordinate can be declared for it. One byte is
# requested, not 500 MB: existence and length are the whole question.
printf '\n== release API availability per platform\n'
API="${STADO_RELEASE_API_URL:-}"
if [ -z "$API" ] && [ -r "$ENV_FILE" ]; then
  API="$(grep -E '^STADO_RELEASE_API_URL=' "$ENV_FILE" 2> /dev/null | tail -n 1 | cut -d= -f2-)"
fi
VERSION="${WELES_CHROMIUM_RELEASE_VERSION:-}"
if [ -z "$VERSION" ] && [ -r "$ENV_FILE" ]; then
  VERSION="$(grep -E '^WELES_CHROMIUM_RELEASE_VERSION=' "$ENV_FILE" 2> /dev/null | tail -n 1 | cut -d= -f2-)"
fi
# The address in a deployment env file is a declaration like any other, and a
# declaration the world contradicts is worth what the world says: the mini names a
# loopback release adapter that is not listening, and it deploys from its staged
# root instead. So when the named address refuses, look for a release API this host
# can actually reach before reporting that nothing can be asked.
probe_api() {
  curl --silent --max-time 5 --output /dev/null --write-out '%{http_code}' \
    --get --data-urlencode 'uri=stado://releases/' "${1%/}/api/release/object" 2>/dev/null
}
if [ -n "$API" ] && [ "$(probe_api "$API")" = "000" ]; then
  printf 'declared api %s does not answer; looking for a listening release API\n' "$API"
  API=""
fi
if [ -z "$API" ] && command -v ss > /dev/null 2>&1; then
  for port in $(ss -ltnp 2> /dev/null | grep -i 'release' | grep -oE ':[0-9]+' | tr -d ':' | sort -u); do
    if [ "$(probe_api "http://127.0.0.1:$port")" != "000" ]; then
      API="http://127.0.0.1:$port"
      printf 'found a listening release API at %s\n' "$API"
      break
    fi
  done
fi
if [ -z "$API" ] || [ -z "$VERSION" ]; then
  printf 'no reachable release API or no chromium version known here, so nothing to ask\n'
else
  printf 'api %s version %s\n' "$API" "$VERSION"
  for platform in darwin-arm64 darwin-amd64 linux-amd64; do
    uri="stado://releases/weles-chromium/$VERSION/$platform/weles-chromium.tar.gz"
    printf '%-14s %s\n' "$platform" \
      "$(curl --silent --show-error --location --get --range 0-0 \
        --data-urlencode "uri=$uri" \
        --output /dev/null \
        --write-out 'http=%{http_code} bytes_offered=%{size_download} content_range=%{header_json}' \
        "${API%/}/api/release/object" 2>&1 | sed 's/"content-range":\[\([^]]*\)\].*/range \1/; s/{.*}//' | tr -d '\n')"
  done
fi