#!/bin/bash
set -euo pipefail
: "${WISENT_SOURCE_DIR:?WISENT_SOURCE_DIR is required}"; : "${WISENT_OUTPUT_DIR:?WISENT_OUTPUT_DIR is required}"
: "${WISENT_INPUT_WELES_CLIENT_BUNDLE_DIR:?WISENT_INPUT_WELES_CLIENT_BUNDLE_DIR is required}"; : "${WISENT_INPUT_WISENT_COST_TRACKER_BUNDLE_DIR:?WISENT_INPUT_WISENT_COST_TRACKER_BUNDLE_DIR is required}"
work="$WISENT_OUTPUT_DIR/work"; source="$work/source"; rm -rf "$work"; mkdir -p "$source" "$WISENT_OUTPUT_DIR/payload" "$WISENT_OUTPUT_DIR/bin" "$WISENT_OUTPUT_DIR/evidence"
rsync -a --exclude .git --exclude node_modules --exclude dist --exclude .wisent-output --exclude recordings --exclude .work --exclude .tmp --exclude var "$WISENT_SOURCE_DIR/" "$source/"
export GIT_CONFIG_GLOBAL="$work/gitconfig"
git config --global url."file://$WISENT_INPUT_WELES_CLIENT_BUNDLE_DIR".insteadOf "ssh://git@github.com/wisent-ai/weles-client.git"
git config --global --add url."file://$WISENT_INPUT_WELES_CLIENT_BUNDLE_DIR".insteadOf "git@github.com:wisent-ai/weles-client.git"
git config --global url."file://$WISENT_INPUT_WISENT_COST_TRACKER_BUNDLE_DIR".insteadOf "ssh://git@github.com/wisent-ai/wisent-cost-tracker.git"
git config --global --add url."file://$WISENT_INPUT_WISENT_COST_TRACKER_BUNDLE_DIR".insteadOf "git@github.com:wisent-ai/wisent-cost-tracker.git"
cd "$source"
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --ignore-scripts
chmod 0755 node_modules/node-pty/prebuilds/*/spawn-helper
npm run build
COPYFILE_DISABLE=1 tar --dereference --format=ustar -czf "$WISENT_OUTPUT_DIR/payload/weles-worker.tar.gz" dist node_modules scripts package.json package-lock.json supabase release released-surface.json tsconfig.json LICENSE
install -m 0755 "$WISENT_SOURCE_DIR/release/stado-launcher.sh" "$WISENT_OUTPUT_DIR/bin/start"
shasum -a 256 "$WISENT_OUTPUT_DIR/payload/weles-worker.tar.gz" "$WISENT_OUTPUT_DIR/bin/start" > "$WISENT_OUTPUT_DIR/evidence/DIGESTS"
