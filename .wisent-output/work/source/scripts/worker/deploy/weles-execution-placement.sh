#!/bin/sh
set -eu

name=$(/usr/bin/basename "$0")
case "$name" in
  weles-execution-status) mode=status ;;
  weles-execution-enable) mode=enable ;;
  weles-execution-disable) mode=disable ;;
  *) printf '%s\n' "unsupported helper name: $name" >&2; exit 64 ;;
esac

if [ -x /opt/homebrew/bin/node ]; then
  node=/opt/homebrew/bin/node
elif [ -x /usr/local/bin/node ]; then
  node=/usr/local/bin/node
else
  printf '%s\n' 'Node.js is unavailable' >&2
  exit 69
fi

policy=${WELES_PLACEMENT_POLICY_FILE:-"$HOME/.config/weles/placement-policy.json"}

"$node" - "$mode" "$policy" <<'NODE'
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mode = process.argv.at(-2);
const policyPath = process.argv.at(-1);
const normalize = (value) => String(value ?? '').trim().toLowerCase().replace(/\.+$/, '');
const hostname = normalize(os.hostname());
const shortHostname = hostname.endsWith('.local') ? hostname.slice(0, -'.local'.length) : hostname;

let document = { schema_version: 1, hosts: [] };
let exists = false;
try {
  document = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  exists = true;
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
if (document?.schema_version !== 1 || !Array.isArray(document.hosts)) {
  throw new Error(`invalid Weles placement policy: ${policyPath}`);
}

let entry = document.hosts.find((candidate) => {
  const identities = [candidate?.hostname, ...(Array.isArray(candidate?.aliases) ? candidate.aliases : [])]
    .map(normalize);
  return identities.includes(hostname) || identities.includes(shortHostname);
});

const report = () => ({
  host: shortHostname || hostname,
  hostname,
  configured: Boolean(entry),
  enabled: entry?.enabled === true && Array.isArray(entry?.actions) && entry.actions.length > 0,
  actions: Array.isArray(entry?.actions) ? entry.actions : [],
  policy_path: policyPath,
});

if (mode === 'status') {
  process.stdout.write(`${JSON.stringify(report())}\n`);
  process.exit(0);
}

if (!entry) {
  entry = {
    hostname,
    aliases: shortHostname && shortHostname !== hostname ? [shortHostname] : [],
    enabled: false,
    actions: ['*'],
  };
  document.hosts.push(entry);
}
entry.enabled = mode === 'enable';

fs.mkdirSync(path.dirname(policyPath), { recursive: true, mode: 0o700 });
const temporary = `${policyPath}.tmp-${process.pid}`;
fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(temporary, policyPath);
fs.chmodSync(policyPath, 0o600);
process.stdout.write(`${JSON.stringify(report())}\n`);
NODE
