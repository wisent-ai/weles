#!/bin/bash
# Publish the git bundles the release build (release/stado-build.sh) reads in
# place of Weles's two private git dependencies, and pin them.
#
# The commit of each bundle is the one package-lock.json resolves the
# dependency to, never a hand-written revision: the build's `npm ci` asks git
# for exactly that commit, so a bundle of any other commit fails the build.
# Each bundle is stored under a coordinate named by its own SHA-256, so it is
# immutable and a later bundle never replaces an earlier one, and
# .wisent-release.json `inputs` is rewritten to the new coordinate and digest.
#
# Run it when a dependency's lockfile pin changes, or when `stado release
# submit` refuses with `HTTP 404 ... stado://sources/weles-worker/<name>/...
# state absent`: the pinned bundle is gone from the store. Commit the changed
# .wisent-release.json afterwards. Throwaway mirrors live under the ignored
# .wisent-output/inputs/ and are reused by the next run.
set -euo pipefail
cd "$(dirname "$0")/../.."
root="$(pwd)/.wisent-output/inputs"
mkdir -p "$root/repos"

publish_bundle() {
  local input="$1" name="$2" lock_key="$3"
  local resolved repository revision mirror bundle digest uri
  resolved="$(node -p "require('./package-lock.json').packages['node_modules/$lock_key'].resolved")"
  revision="${resolved##*#}"
  repository="https://github.com/wisent-ai/$name.git"
  case "$revision" in *[!0-9a-f]*|'') echo "$lock_key resolves to $resolved, not a pinned commit" >&2; exit 1;; esac
  [ "${#revision}" -eq 40 ] || { echo "$lock_key pin $revision is not a full commit" >&2; exit 1; }
  mirror="$root/repos/$name.git"
  bundle="$root/$name.bundle"
  if [ -d "$mirror" ]; then
    git -C "$mirror" remote set-url origin "$repository"
    git -C "$mirror" fetch --prune origin
  else
    git clone --mirror "$repository" "$mirror"
  fi
  git -C "$mirror" cat-file -e "$revision^{commit}"
  git -C "$mirror" update-ref refs/heads/release-input "$revision"
  rm -f "$bundle"
  git -C "$mirror" bundle create "$bundle" refs/heads/release-input
  git bundle verify "$bundle" >/dev/null
  digest="$(shasum -a 256 "$bundle" | cut -d' ' -f1)"
  uri="stado://sources/weles-worker/$name/$digest/$name.bundle"
  stado storage put "$uri" "$bundle" --if-absent
  node -e '
    const fs = require("fs");
    const [input, uri, digest] = process.argv.slice(1);
    const manifest = JSON.parse(fs.readFileSync(".wisent-release.json", "utf8"));
    if (!manifest.inputs || !manifest.inputs[input]) {
      throw new Error(`.wisent-release.json declares no input ${input}`);
    }
    manifest.inputs[input].uri = uri;
    manifest.inputs[input].sha256 = digest;
    fs.writeFileSync(".wisent-release.json", JSON.stringify(manifest, null, 2) + "\n");
  ' "$input" "$uri" "$digest"
  echo "$input: $name at $revision -> $uri"
}

publish_bundle weles-client-bundle weles-client @wisent-ai/weles-client
publish_bundle wisent-cost-tracker-bundle wisent-cost-tracker @wisent/cost-tracker
