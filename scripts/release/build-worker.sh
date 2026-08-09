#!/bin/sh
set -eu

fail() {
  printf '%s\n' "weles worker release: $*" >&2
  exit 1
}

SOURCE_DIR=${WISENT_SOURCE_DIR:?WISENT_SOURCE_DIR is required}
OUTPUT_DIR=${WISENT_OUTPUT_DIR:?WISENT_OUTPUT_DIR is required}
VERSION=${WISENT_VERSION:?WISENT_VERSION is required}
PLATFORM=${WISENT_PLATFORM:?WISENT_PLATFORM is required}

case "$SOURCE_DIR" in /*) ;; *) fail "WISENT_SOURCE_DIR must be absolute" ;; esac
case "$OUTPUT_DIR" in /*) ;; *) fail "WISENT_OUTPUT_DIR must be absolute" ;; esac
case "$VERSION" in *[!0-9A-Za-z.-]*|'') fail "WISENT_VERSION is not a canonical coordinate" ;; esac
case "$PLATFORM" in
  darwin-arm64|linux-amd64) ;;
  darwin-amd64)
    fail "the existing Darwin AMD64 worker contains native Node dependencies and needs a Darwin AMD64 runner_platform; refusing an ARM-built substitute"
    ;;
  *) fail "unsupported WISENT_PLATFORM: $PLATFORM" ;;
esac

cd "$SOURCE_DIR"
PACKAGE_VERSION=$(node -p 'require("./package.json").version')
[ "$PACKAGE_VERSION" = "$VERSION" ] || fail "WISENT_VERSION $VERSION does not match package.json $PACKAGE_VERSION"

NPM_WORK="$OUTPUT_DIR/npm-$PLATFORM"
STAGE_DIR="$SOURCE_DIR/.wisent-release/$PLATFORM/payload"
rm -rf "$STAGE_DIR"
mkdir -p "$NPM_WORK" "$STAGE_DIR/receipts"

npm ci --cache "$NPM_WORK/cache"
npm run build
node scripts/release/surface.mjs > "$STAGE_DIR/released-surface.json"
npm sbom --omit=dev --sbom-format cyclonedx > "$STAGE_DIR/receipts/sbom.cyclonedx.json"
npm prune --omit=dev

cp -R dist scripts node_modules release supabase "$STAGE_DIR/"
cp package.json package-lock.json tsconfig.json LICENSE README.md "$STAGE_DIR/"
node scripts/release/write-worker-evidence.mjs \
  --root "$STAGE_DIR" \
  --version "$VERSION" \
  --platform "$PLATFORM"
