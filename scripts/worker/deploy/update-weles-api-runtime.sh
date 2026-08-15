#!/bin/sh
# Build the Weles API runtime from one exact reviewed repository revision.
set -eu

REVISION='223ffe7058fa8430b6a642c3b24e792d5d4b828b'
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
# `--ignore-scripts` is right for every dependency but one: node-pty's native
# addon and its `spawn-helper` binary are produced by its own install script, and
# without them any trajectory that drives a CLI dies inside node-pty with
# `posix_spawnp failed` and no file name. The operator's own clone has both built
# at 0755; a managed runtime installed with scripts off has neither, so it can
# serve HTTP all day and still be unable to log an account in. Rebuild that one
# package explicitly rather than trusting arbitrary install scripts.
npm rebuild node-pty
npm run build
printf '%s\n' "$REVISION" > "$WORK/.weles-api-revision"
printf '%s\n' "built Weles API runtime $REVISION"
