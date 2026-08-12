#!/bin/sh
# Set this host's Stado storage backend to the delivered value.
#
#   stado host install-file <target> <backend.txt> stado-storage-backend.txt
#   stado host install-helper <target> \
#       scripts/worker/deploy/set-stado-storage-backend.sh set-stado-storage-backend
#   stado host run-helper <target> set-stado-storage-backend
#
# `stado config set` validates the whole document before writing, so on a host
# whose config carries entries the installed binary no longer recognises every
# write is refused -- including a one-key change that has nothing to do with
# them. That is the state charless-mac-mini is in, and it is why this edits the
# single key directly instead.
#
# Deliberately narrow: it touches storage.backend and nothing else, accepts only
# a backend the schema defines, and keeps the previous document beside the new
# one. Anything wider belongs in `stado config set`, once that command can run
# on this host again.
set -eu

value_file=${WELES_DELIVERY_DIR:-$HOME/.stado/files}/stado-storage-backend.txt
config=${STADO_CONFIG_FILE:-$HOME/.config/stado/config.json}

for required in "$value_file" "$config"; do
  if [ ! -f "$required" ] || [ -L "$required" ]; then
    printf '%s\n' "missing regular file: $required" > /dev/stderr
    false
  fi
done

node_bin=${NODE_BIN:-}
if [ -z "$node_bin" ]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "$candidate" ]; then node_bin=$candidate; break; fi
  done
fi
if [ -z "$node_bin" ]; then node_bin=$(command -v node || true); fi
if [ -z "$node_bin" ] || [ ! -x "$node_bin" ]; then
  printf '%s\n' "no usable node interpreter; set NODE_BIN on this host" > /dev/stderr
  false
fi

cp "$config" "$config.before-backend-change"

export STADO_BACKEND_VALUE_FILE="$value_file"
export STADO_CONFIG_TARGET="$config"

exec "$node_bin" -e '
const fs = require("node:fs");
const configPath = process.env.STADO_CONFIG_TARGET;
const wanted = fs.readFileSync(process.env.STADO_BACKEND_VALUE_FILE, "utf8").trim();
const allowed = ["local", "stado", "gcs", "azure", "s3"];
if (!allowed.includes(wanted)) throw new Error("unsupported storage backend: " + wanted);
const doc = JSON.parse(fs.readFileSync(configPath, "utf8"));
if (!doc.storage || typeof doc.storage !== "object") throw new Error("config has no storage section");
const before = doc.storage.backend;
doc.storage.backend = wanted;
fs.writeFileSync(configPath, JSON.stringify(doc, null, " ") + "\n");
process.stdout.write(JSON.stringify({ status: "set", before, after: wanted, config: configPath }, null, " ") + "\n");
'
