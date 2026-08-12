#!/bin/sh
# Add actions to this host's placement policy, idempotently.
#
#   stado host install-file <target> <grant.json> placement-grant.json
#   stado host install-helper <target> \
#       scripts/worker/deploy/grant-placement-action.sh grant-placement-action
#   stado host run-helper <target> grant-placement-action
#
# placement-grant.json: {"actions":["apple_create_developer_id"]}
#
# The placement policy is the list claimOne intersects with the launcher
# allowlist, and it is the reason a queued row can sit forever while the worker
# claims other work and logs nothing: an action present in the launcher bound
# but absent here is dropped before the candidate query. Editing it is how an
# operator widens what a host may run; there is no Stado command for it because
# the file lives outside every delivery prefix.
#
# It refuses to grant anything the launcher allowlist does not already carry, so
# this can only ever narrow the gap between the two lists, never open the host to
# an action the release itself does not permit. The previous policy is kept.
set -eu

policy=${WELES_PLACEMENT_POLICY_FILE:-$HOME/.config/weles/placement-policy.json}
allowlist=$HOME/weles/scripts/worker/deploy/weles-action-allowlist.txt
grant=${WELES_DELIVERY_DIR:-$HOME/.stado/files}/placement-grant.json

for required in "$policy" "$allowlist" "$grant"; do
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

cp "$policy" "$policy.before-grant"

exec "$node_bin" -e '
const fs = require("node:fs");
const os = require("node:os");
const [policyPath, allowlistPath, grantPath] = process.argv.slice(1);
const doc = JSON.parse(fs.readFileSync(policyPath, "utf8"));
const allowed = new Set(fs.readFileSync(allowlistPath, "utf8").split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean));
const wanted = (JSON.parse(fs.readFileSync(grantPath, "utf8")).actions || []);
if (!Array.isArray(wanted) || !wanted.length) throw new Error("grant lists no actions");
for (const action of wanted) {
  if (!/^[a-z0-9_]+$/.test(action)) throw new Error("unsafe action name: " + action);
  if (!allowed.has(action)) throw new Error("action is not in the launcher allowlist: " + action);
}
const hosts = doc.hosts || {};
const lower = os.hostname().toLowerCase();
const bare = lower.replace(/\.local$/, "");
const match = Object.entries(hosts).find(function (pair) {
  const aliases = Array.isArray(pair[1] && pair[1].aliases) ? pair[1].aliases : [];
  return [pair[0]].concat(aliases).some(function (c) {
    const v = String(c).toLowerCase();
    return v === lower || v === bare;
  });
});
if (!match) throw new Error("this host resolves to no placement entry");
const entry = match[1];
const before = Array.isArray(entry.actions) ? entry.actions.slice() : [];
const after = before.slice();
for (const action of wanted) if (after.indexOf(action) === -1) after.push(action);
after.sort();
entry.actions = after;
fs.writeFileSync(policyPath, JSON.stringify(doc, null, 1) + "\n");
process.stdout.write(JSON.stringify({ status: "granted", host: match[0], added: after.filter(function (a) { return before.indexOf(a) === -1; }), actions: after }, null, 1) + "\n");
' "$policy" "$allowlist" "$grant"
