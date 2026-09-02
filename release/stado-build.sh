#!/bin/bash
set -euo pipefail
: "${WISENT_SOURCE_DIR:?WISENT_SOURCE_DIR is required}"; : "${WISENT_OUTPUT_DIR:?WISENT_OUTPUT_DIR is required}"
: "${WISENT_INPUT_WELES_CLIENT_BUNDLE_DIR:?WISENT_INPUT_WELES_CLIENT_BUNDLE_DIR is required}"; : "${WISENT_INPUT_WISENT_COST_TRACKER_BUNDLE_DIR:?WISENT_INPUT_WISENT_COST_TRACKER_BUNDLE_DIR is required}"
work="$WISENT_OUTPUT_DIR/work"; source="$work/source"; rm -rf "$work"; mkdir -p "$source" "$WISENT_OUTPUT_DIR/payload" "$WISENT_OUTPUT_DIR/bin" "$WISENT_OUTPUT_DIR/evidence"
rsync -a --exclude .git --exclude node_modules --exclude dist --exclude .wisent-output --exclude recordings --exclude .work --exclude .tmp --exclude var "$WISENT_SOURCE_DIR/" "$source/"
# A release worker is handed an extracted snapshot, never a checkout: `release
# submit` archives the tree and the worker unpacks it as `delivery-source`. So
# every git question here answered `fatal: not a git repository` the moment a
# build was dispatched to a machine other than the one that submitted it, and
# it exited 128 before installing a single dependency. Nothing shipped from the
# queue for four days for this reason alone, while the same script kept working
# by accident whenever the builder happened to be the submitter.
#
# Both identities are exact, so both are accepted and the stamp says which one
# it carries: a commit when a checkout is present, otherwise the digest of the
# very bytes being built, which is the stronger claim of the two.
if git -C "$WISENT_SOURCE_DIR" rev-parse --git-dir >/dev/null 2>&1; then
  source_revision="$(git -C "$WISENT_SOURCE_DIR" rev-parse HEAD)"
  [ -z "$(git -C "$WISENT_SOURCE_DIR" status --porcelain --untracked-files=all)" ] || { echo "Weles release source must be an exact clean commit" >&2; exit 1; }
  case "$source_revision" in *[!0-9a-f]*|'') echo "source revision must be the full lowercase Git commit" >&2; exit 1;; esac
  [ "${#source_revision}" -eq 40 ] || { echo "source revision must contain exactly 40 hexadecimal characters" >&2; exit 1; }
  source_identity_kind=git-commit
else
  source_revision="$(cd "$source" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256 | shasum -a 256 | cut -d ' ' -f 1)"
  case "$source_revision" in *[!0-9a-f]*|'') echo "source tree digest must be lowercase hexadecimal" >&2; exit 1;; esac
  [ "${#source_revision}" -eq 64 ] || { echo "source tree digest must contain exactly 64 hexadecimal characters" >&2; exit 1; }
  source_identity_kind=source-tree-sha256
fi
release_version="$(node -p "require('$source/package.json').version")"
printf '{"schema":"weles.source-identity.v1","product":"weles-worker","version":"%s","source_revision":"%s","source_identity_kind":"%s"}\n' "$release_version" "$source_revision" "$source_identity_kind" > "$source/release/source-identity.json"
export GIT_CONFIG_GLOBAL="$work/gitconfig"
git config --global url."file://$WISENT_INPUT_WELES_CLIENT_BUNDLE_DIR".insteadOf "ssh://git@github.com/wisent-ai/weles-client.git"
git config --global --add url."file://$WISENT_INPUT_WELES_CLIENT_BUNDLE_DIR".insteadOf "git@github.com:wisent-ai/weles-client.git"
git config --global url."file://$WISENT_INPUT_WISENT_COST_TRACKER_BUNDLE_DIR".insteadOf "ssh://git@github.com/wisent-ai/wisent-cost-tracker.git"
git config --global --add url."file://$WISENT_INPUT_WISENT_COST_TRACKER_BUNDLE_DIR".insteadOf "git@github.com:wisent-ai/wisent-cost-tracker.git"
cd "$source"
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --ignore-scripts
chmod 0755 node_modules/node-pty/prebuilds/*/spawn-helper
npm run build
COPYFILE_DISABLE=1 tar --dereference --format=ustar -czf "$WISENT_OUTPUT_DIR/payload/weles-worker.tar.gz" dist node_modules scripts package.json package-lock.json release released-surface.json tsconfig.json LICENSE
install -m 0755 "$WISENT_SOURCE_DIR/release/stado-launcher.sh" "$WISENT_OUTPUT_DIR/bin/start"
install -m 0755 "$WISENT_SOURCE_DIR/release/stado-launcher.sh" "$WISENT_OUTPUT_DIR/weles-api-launcher"
shasum -a 256 "$WISENT_OUTPUT_DIR/payload/weles-worker.tar.gz" "$WISENT_OUTPUT_DIR/bin/start" "$WISENT_OUTPUT_DIR/weles-api-launcher" > "$WISENT_OUTPUT_DIR/evidence/DIGESTS"
