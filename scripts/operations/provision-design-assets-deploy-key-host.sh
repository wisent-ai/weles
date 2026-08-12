#!/bin/sh
set -eu
key="$HOME/.stado/design-assets-deploy-key"
mkdir -p "$HOME/.stado"
if [ ! -f "$key" ]; then
  /usr/bin/ssh-keygen -q -t ed25519 -N '' -C 'charless-mac-mini design-assets exporter' -f "$key"
fi
chmod 600 "$key"
cat "$key.pub"
