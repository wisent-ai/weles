#!/bin/sh
# Build the Weles API runtime from one exact reviewed repository revision.
set -eu

REVISION='1790b230c2b4a9a1ba1a7db3de1fb8bda85bc49a'
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
npm run build
printf '%s\n' "$REVISION" > "$WORK/.weles-api-revision"
printf '%s\n' "built Weles API runtime $REVISION"
