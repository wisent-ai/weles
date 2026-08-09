#!/bin/sh
set -eu

fail() {
  printf '%s\n' "weles worker quality: $*" >&2
  exit 1
}

SOURCE_DIR=${WISENT_SOURCE_DIR:?WISENT_SOURCE_DIR is required}
OUTPUT_DIR=${WISENT_OUTPUT_DIR:?WISENT_OUTPUT_DIR is required}
VERSION=${WISENT_VERSION:?WISENT_VERSION is required}
PLATFORM=${WISENT_PLATFORM:?WISENT_PLATFORM is required}

case "$PLATFORM" in
  darwin-arm64|linux-amd64) ;;
  darwin-amd64) fail "native Node dependencies require a Darwin AMD64 runner_platform, which Stado does not provide" ;;
  *) fail "unsupported WISENT_PLATFORM: $PLATFORM" ;;
esac

cd "$SOURCE_DIR"
PACKAGE_VERSION=$(node -p 'require("./package.json").version')
[ "$PACKAGE_VERSION" = "$VERSION" ] || fail "WISENT_VERSION $VERSION does not match package.json $PACKAGE_VERSION"
mkdir -p "$OUTPUT_DIR/npm-$PLATFORM"
npm ci --cache "$OUTPUT_DIR/npm-$PLATFORM/cache"
npm run build
