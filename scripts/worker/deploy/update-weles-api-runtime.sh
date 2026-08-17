#!/bin/sh
# Build the Weles API runtime from one exact reviewed repository revision.
set -eu

REVISION='84aade073522bf286af62251471cf669ff0fe5f0'
REPOSITORY='https://github.com/wisent-ai/weles.git'
WORK="$HOME/.stado/build-work/weles-api-managed"
PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
export PATH

mkdir -p "$(dirname "$WORK")"
if [ ! -d "$WORK/.git" ]; then
  rm -rf "$WORK"
  git clone --filter=blob:none --no-checkout "$REPOSITORY" "$WORK"
fi
git -C "$WORK" fetch origin "$REVISION"
git -C "$WORK" checkout --detach --force "$REVISION"
cd "$WORK"
npm ci --ignore-scripts
# node-pty 1.1.0 ships prebuilt binaries rather than compiling, and the
# `spawn-helper` it ships arrives at 0644. posix_spawnp cannot execute it, so
# every trajectory that drives a CLI dies inside node-pty with
# `posix_spawnp failed` and no file name, on a host where the CLI itself is
# installed and fine. The operator's own clone has it at 0755, which is why the
# same code works there and not here. `npm rebuild` does not fix it: there is
# nothing to rebuild.
for helper in "$WORK"/node_modules/node-pty/prebuilds/*/spawn-helper \
  "$WORK"/node_modules/node-pty/build/Release/spawn-helper; do
  [ -f "$helper" ] || continue
  chmod u=rwx,go=rx "$helper"
done
npm run build
printf '%s\n' "$REVISION" > "$WORK/.weles-api-revision"
printf '%s\n' "built Weles API runtime $REVISION"
