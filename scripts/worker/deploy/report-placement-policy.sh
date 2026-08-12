#!/bin/sh
# Report what this host's worker is actually permitted to claim.
#
#   stado host install-helper <target> \
#       scripts/worker/deploy/report-placement-policy.sh report-placement-policy
#   stado host run-helper <target> report-placement-policy
#
# Two lists decide whether a queued row is ever claimed, and neither is the
# Stado registry: ~/.config/weles/placement-policy.json (the host placement
# policy) and <release>/scripts/worker/deploy/weles-action-allowlist.txt (the
# launcher bound). claimOne intersects them, and a row whose action is missing
# from either is dropped before the candidate query -- pollOnce then returns
# 'idle' without logging anything. The worker looks healthy, claims other work,
# and that one action never runs. Diagnosing it from outside the host means
# reading both files, which is what this prints. Read-only.
set -eu

policy=${WELES_PLACEMENT_POLICY_FILE:-$HOME/.config/weles/placement-policy.json}
allowlist=$HOME/weles/scripts/worker/deploy/weles-action-allowlist.txt

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

# Resolution mirrors placement-policy.ts: the document is keyed by hostname with
# optional aliases, so printing the raw file would not answer which entry this
# host resolves to.
exec "$node_bin" -e '
const fs = require("node:fs");
const os = require("node:os");
const [policyPath, allowlistPath] = process.argv.slice(1);
const out = { policy_file: policyPath, hostname: os.hostname() };
try {
  const doc = JSON.parse(fs.readFileSync(policyPath, "utf8"));
  const hosts = doc.hosts ?? {};
  out.hosts = Object.keys(hosts);
  const lower = os.hostname().toLowerCase();
  const bare = lower.replace(/\.local$/, "");
  const match = Object.entries(hosts).find(([name, entry]) => {
    const aliases = Array.isArray(entry && entry.aliases) ? entry.aliases : [];
    return [name].concat(aliases).some((c) => {
      const v = String(c).toLowerCase();
      return v === lower || v === bare;
    });
  });
  out.resolved_host = match ? match[0] : null;
  out.enabled = match ? match[1].enabled !== false : null;
  out.actions = match ? (match[1].actions || []) : null;
  out.wildcard = Array.isArray(out.actions) && out.actions.indexOf("*") !== -1;
  if (Array.isArray(out.actions)) {
    out.apple_in_policy = out.wildcard || out.actions.indexOf("apple_create_developer_id") !== -1;
  }
} catch (error) { out.policy_error = error.message; }
try {
  const allowed = fs.readFileSync(allowlistPath, "utf8").split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
  out.launcher_allowlist_count = allowed.length;
  out.apple_in_allowlist = allowed.indexOf("apple_create_developer_id") !== -1;
} catch (error) { out.allowlist_error = error.message; }
process.stdout.write(JSON.stringify(out, null, 1) + "\n");
' "$policy" "$allowlist"
