#!/bin/sh
# Write the manifest that stage-release-overlay.sh verifies an overlay against.
#
#   WELES_OVERLAY_ARCHIVE=<archive.tar.gz> WELES_OVERLAY_VERSION=<version> \
#     scripts/worker/deploy/write-overlay-manifest.sh
#
# Emits <archive-dir>/weles-overlay.json carrying the archive's digest and the
# release version to stage it as. The digest is computed here, from the bytes
# that will actually be delivered, so the manifest cannot describe a different
# archive than the one it travels with -- which is the whole reason the staging
# helper checks it before writing anything.
#
# Inputs arrive through the environment rather than positionally so that callers
# name what they are passing.
set -eu

archive=${WELES_OVERLAY_ARCHIVE:?WELES_OVERLAY_ARCHIVE is required}
version=${WELES_OVERLAY_VERSION:?WELES_OVERLAY_VERSION is required}

node_bin=${NODE_BIN:-}
if [ -z "$node_bin" ]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "$candidate" ]; then node_bin=$candidate; break; fi
  done
fi
if [ -z "$node_bin" ]; then node_bin=$(command -v node || true); fi
if [ -z "$node_bin" ] || [ ! -x "$node_bin" ]; then
  printf '%s\n' "no usable node interpreter; set NODE_BIN" > /dev/stderr
  false
fi

export WELES_OVERLAY_ARCHIVE="$archive"
export WELES_OVERLAY_VERSION="$version"

exec "$node_bin" -e '
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const archive = process.env.WELES_OVERLAY_ARCHIVE;
const version = process.env.WELES_OVERLAY_VERSION;
if (!/^[A-Za-z0-9._-]+$/.test(version)) throw new Error("unsafe version: " + version);
const sha256 = crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
const out = path.join(path.dirname(archive), "weles-overlay.json");
fs.writeFileSync(out, JSON.stringify({ version, sha256 }) + "\n");
process.stdout.write(out + "\n" + JSON.stringify({ version, sha256 }) + "\n");
'
