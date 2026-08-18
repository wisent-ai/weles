#!/bin/sh
# Stage a new worker release that differs from the running one only in the files
# a local build produces: scripts/ and dist/.
#
#   stado host install-file <target> <overlay.tar.gz> weles-overlay.tar.gz
#   stado host install-file <target> <overlay.json>   weles-overlay.json
#   stado host install-helper <target> \
#       scripts/worker/deploy/stage-release-overlay.sh stage-release-overlay
#   stado host run-helper <target> stage-release-overlay
#
# Why this exists beside auto-deploy.sh: auto-deploy fetches a published release
# object and verifies the checksum its operator pinned. When the release
# namespace cannot be written -- stado://releases is immutable and answers 401
# without the release grant -- there is no object to fetch, and no way to move a
# host forward at all.
#
# It is not a substitute for the signed release pipeline and does not pretend to
# be one: node_modules/ is carried from the running release byte for byte, so the
# dependency tree is whatever that release shipped, and nothing here is signed.
# Use it to close a gap the pipeline cannot, then let the next real release
# supersede it.
#
# Guards, because a deployment helper that half-works is worse than none: the
# archive is checksum-verified against its manifest before anything is written,
# every path is checked to live under scripts/ or dist/ before the first is
# extracted, the base release is copied rather than edited, and the symlink swap
# is one ln -sfn so no reader sees it missing. The previous release stays on disk.
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

node_bin=${NODE_BIN:-}
if [ -z "$node_bin" ]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "$candidate" ]; then node_bin=$candidate; break; fi
  done
fi
if [ -z "$node_bin" ]; then node_bin=$(command -v node || true); fi
if [ -z "$node_bin" ] || [ ! -x "$node_bin" ]; then
  printf '%s\n' "no usable node interpreter; set NODE_BIN on this host" > /dev/stderr
  false
fi

# Manifest, checksum and path checks all run in node: a checksum that a shell
# quoting bug silently truncated would verify nothing while appearing to, and a
# throw here stops the script through set -e before any file is written.
version=$("$node_bin" -e '
const fs = require("node:fs");
const crypto = require("node:crypto");
const [manifestPath, archivePath] = process.argv.slice(1);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
for (const field of ["version", "sha256"]) {
  if (typeof manifest[field] !== "string" || !/^[A-Za-z0-9._-]+$/.test(manifest[field])) {
    throw new Error("manifest field " + field + " is missing or unsafe");
  }
}
const observed = crypto.createHash("sha256").update(fs.readFileSync(archivePath)).digest("hex");
if (observed !== manifest.sha256) {
  throw new Error("delivered overlay checksum mismatch: " + observed + " != " + manifest.sha256);
}
process.stdout.write(manifest.version);
' "$manifest" "$archive")

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

platform=$(basename "$base")
root=$(dirname "$(dirname "$base")")
target=$root/$version/$platform
if [ -e "$target" ]; then
  printf '%s\n' "release already staged: $target" > /dev/stderr
  false
fi

# Every path is checked before a single one is written, so a bad archive cannot
# leave a half-built release behind.
tar tzf "$archive" | "$node_bin" -e '
const lines = require("node:fs").readFileSync(process.stdin.fd, "utf8").split(/\r?\n/);
for (const entry of lines) {
  const name = entry.trim();
  if (!name || name === "./") continue;
  if (!/^(\.\/)?(scripts|dist)\//.test(name)) {
    throw new Error("overlay contains a path outside scripts/ and dist/: " + name);
  }
}
'

staging=$target.incoming
rm -rf "$staging"
mkdir -p "$(dirname "$staging")"
cp -R "$base" "$staging"
tar xzf "$archive" -C "$staging"
mv "$staging" "$target"

ln -sfn "$target" "$link"

printf '{"status":"staged","release":"%s","previous":"%s"}\n' "$target" "$base"
