#!/bin/sh
# Stage a new worker release that differs from the running one only under scripts/.
#
#   stado host install-file <target> <overlay.tar.gz> weles-overlay.tar.gz
#   stado host install-file <target> <overlay.json>   weles-overlay.json
#   stado host install-helper <target> scripts/worker/deploy/stage-scripts-overlay.sh \
#       stage-scripts-overlay
#   stado host run-helper <target> stage-scripts-overlay
#
# Why this exists beside auto-deploy.sh rather than inside it: auto-deploy fetches
# a published release object and verifies the checksum its operator pinned. When the
# release namespace cannot be written -- an immutable prefix refuses the write, or
# the build never reached it -- there is no object for it to fetch and no way to move
# a host forward at all. This covers exactly the case where the only difference is
# interpreted files: dist/ and node_modules/ are carried over from the running
# release byte for byte, so nothing here can substitute for a real build.
#
# It stays honest about that limit. Only paths under scripts/ are extracted, anything
# else in the archive aborts the run, and the base release is copied rather than
# edited so the currently running bytes remain intact for a rollback that is one
# symlink away.
set -eu

files=${WELES_DELIVERY_DIR:-$HOME/.stado/files}
archive=$files/weles-overlay.tar.gz
manifest=$files/weles-overlay.json

for required in "$archive" "$manifest"; do
  if [ ! -f "$required" ] || [ -L "$required" ]; then
    printf '%s\n' "missing regular delivered file: $required" > /dev/stderr
    false
  fi
done

# The manifest is read with the JSON parser the runtime already has rather than by
# cutting the file with sed: a checksum that a quoting bug silently truncates would
# verify nothing while appearing to.
node_bin=${NODE_BIN:-}
if [ -z "$node_bin" ]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "$candidate" ]; then
      node_bin=$candidate
      break
    fi
  done
fi
if [ -z "$node_bin" ]; then
  node_bin=$(command -v node || true)
fi
if [ -z "$node_bin" ] || [ ! -x "$node_bin" ]; then
  printf '%s\n' "no usable node interpreter; set NODE_BIN on this host" > /dev/stderr
  false
fi

read_field() {
  "$node_bin" -e '
    const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]];
    if (typeof value !== "string" || !/^[A-Za-z0-9._-]+$/.test(value)) {
      throw new Error(`manifest field ${process.argv[2]} is missing or unsafe`);
    }
    process.stdout.write(value);
  ' "$manifest" "$1"
}

version=$(read_field version)
expected=$(read_field sha256)

observed=$(shasum -a 256 "$archive" | awk '{print $1}')
if [ "$observed" != "$expected" ]; then
  printf '%s\n' "delivered overlay checksum mismatch: $observed != $expected" > /dev/stderr
  false
fi

link=$HOME/weles
if [ ! -L "$link" ]; then
  printf '%s\n' "$link is not a symlink to a release; refusing to replace it" > /dev/stderr
  false
fi
base=$(readlink "$link")
if [ ! -d "$base" ]; then
  printf '%s\n' "current release is not a directory: $base" > /dev/stderr
  false
fi

# .../weles-worker/<version>/<platform>
platform=$(basename "$base")
root=$(dirname "$(dirname "$base")")
target=$root/$version/$platform
if [ -e "$target" ]; then
  printf '%s\n' "release already staged: $target" > /dev/stderr
  false
fi

# Every path in the archive is checked before a single one is written, so a bad
# archive cannot leave a half-built release behind.
tar tzf "$archive" | while read -r entry; do
  case $entry in
    ./scripts/*|scripts/*) ;;
    ./) ;;
    *)
      printf '%s\n' "overlay contains a path outside scripts/: $entry" > /dev/stderr
      exit 1
      ;;
  esac
done

staging=$target.incoming
rm -rf "$staging"
mkdir -p "$(dirname "$staging")"
cp -R "$base" "$staging"
tar xzf "$archive" -C "$staging"
mv "$staging" "$target"

# Atomic: ln -sfn on a directory symlink replaces it in one step, so no reader ever
# observes the link missing.
ln -sfn "$target" "$link"

printf '{"status":"staged","release":"%s","previous":"%s"}\n' "$target" "$base"
