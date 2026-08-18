#!/bin/sh
# Stage whichever installed Weles worker release the version marker names.
#
# `stado host install-release` puts immutable bytes under
# $HOME/.stado/releases/weles-worker/<version>/<platform>/. The activator reads
# from $HOME/.stado/files, so exactly one copy step stands between them. The
# version is data in a marker file, never a value baked into this script: one
# helper serves every release instead of one helper per release.
set -eu

platform="${WELES_RELEASE_PLATFORM:-darwin-arm64}"
# `stado host install-secret` delivers the requested version here; the activator
# reads its own marker under files/. This helper is the one step between them.
delivered="$HOME/.stado/weles-release-version"
marker="$HOME/.stado/files/weles-release-version"
source_marker="$delivered"
[ -f "$source_marker" ] || source_marker="$marker"
[ -f "$source_marker" ] || { echo "no delivered version marker" >&2; exit 1; }
version=$(/usr/bin/tr -d '\n' < "$source_marker")
case "$version" in
  '' | *[!A-Za-z0-9._-]* ) echo "marker does not name a usable version" >&2; exit 1 ;;
esac

src="$HOME/.stado/releases/weles-worker/$version/$platform/weles-worker.tar.gz"
[ -f "$src" ] || { echo "no installed archive for $version" >&2; exit 1; }
/usr/bin/install -m 600 "$src" "$HOME/.stado/files/weles-worker.tar.gz"
printf '%s\n' "$version" > "$marker"
/bin/chmod 600 "$marker"
printf 'staged weles-worker %s sha256=%s\n' \
  "$version" "$(/usr/bin/shasum -a 256 "$src" | /usr/bin/cut -d ' ' -f 1)"
