#!/usr/bin/env bash
# The formatting gate `.wisent-release.json` declares and `stado quality`
# reads. With --check it lists every source Biome would change and fails,
# writing nothing; without it, `stado quality format` runs it to write them.
# Biome is the devDependency the package lock pins; its settings are
# biome.jsonc at the checkout root.
set -euo pipefail
cd "$(dirname "$0")/../.."

biome=node_modules/.bin/biome
if [ ! -x "$biome" ]; then
  echo "release/checks/fmt.sh: $biome is missing; the package lock pins @biomejs/biome, so run npm ci first" >/dev/stderr
  false
fi

case "$*" in
  --check) exec "$biome" format . ;;
  '') exec "$biome" format --write . ;;
  *)
    echo "usage: release/checks/fmt.sh [--check]; got: $*" >/dev/stderr
    false
    ;;
esac
