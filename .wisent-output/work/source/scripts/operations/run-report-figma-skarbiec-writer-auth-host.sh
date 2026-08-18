#!/bin/sh
set -eu
set -a
. "$HOME/.config/weles/worker.env"
set +a
exec /opt/homebrew/bin/node "$HOME/.stado/files/report-figma-skarbiec-writer-auth-host.mjs"
