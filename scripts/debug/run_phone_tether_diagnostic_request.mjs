#!/usr/bin/env node
// Run a diagnostic-ladder row explicitly through a phone-tether interface.
//
// Usage:
//   PHONE_TETHER_IFACE=en14 node scripts/debug/run_phone_tether_diagnostic_request.mjs <row-id>
//   PHONE_TETHER_REMOTE_SSH=mac-mini.local PHONE_TETHER_REMOTE_IFACE=en7 \
//     node scripts/debug/run_phone_tether_diagnostic_request.mjs <row-id>
//
// The wrapper starts a local phone proxy or starts it on a remote host over
// SSH, verifies that the localhost proxy has an exit IP, then launches
// scripts/diag/run_diagnostic_request.mjs with PROXY_URL pointing at the
// explicit localhost phone path.

import { homedir, networkInterfaces, userInfo } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

const rowId = process.argv[2] || process.env.ACTION_LOG_ID || '';
if (!rowId) {
  console.error('usage: PHONE_TETHER_IFACE=<iface> node scripts/debug/run_phone_tether_diagnostic_request.mjs <row-id>');
  process.exit(2);
}

const all = networkInterfaces();
const localPort = Number(process.env.PHONE_TETHER_LOCAL_PORT || process.env.PHONE_TETHER_PROXY_PORT || 9001);
const remotePort = Number(process.env.PHONE_TETHER_REMOTE_PROXY_PORT || process.env.PHONE_TETHER_PROXY_PORT || 9001);
const proxyUrl = `http://127.0.0.1:${localPort}`;
let remoteSsh = process.env.PHONE_TETHER_REMOTE_SSH || '';
let remoteIface = process.env.PHONE_TETHER_REMOTE_IFACE || '';
let remoteRepo = process.env.PHONE_TETHER_REMOTE_REPO || process.cwd();
let remoteNode = process.env.PHONE_TETHER_REMOTE_NODE || '';
const sshArgs = [
  '-o', 'ExitOnForwardFailure=yes',
  '-o', 'BatchMode=yes',
  '-o', `ConnectTimeout=${process.env.PHONE_TETHER_SSH_CONNECT_TIMEOUT || '8'}`,
  '-o', 'ServerAliveInterval=10',
  '-o', 'ServerAliveCountMax=2',
];

function ipv4Of(iface) {
  return (all[iface] || []).find((addr) => addr.family === 'IPv4' && !addr.internal)?.address || '';
}

function detectInterface() {
  const explicit = process.env.PHONE_TETHER_IFACE || '';
  if (explicit) return explicit;
  const candidates = Object.keys(all)
    .filter((iface) => !/^(lo|utun|awdl|llw|bridge|gif|stf|ap)/i.test(iface))
    .filter((iface) => iface !== 'en0')
    .filter((iface) => ipv4Of(iface));
  return candidates.length === 1 ? candidates[0] : '';
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function unique(values) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function splitEnvList(name) {
  return String(process.env[name] || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function sshConfigHosts() {
  const path = `${homedir()}/.ssh/config`;
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8');
  const hosts = [];
  for (const line of text.split(/\n/)) {
    const m = line.trim().match(/^Host\s+(.+)$/i);
    if (!m) continue;
    for (const host of m[1].split(/\s+/)) {
      if (!host || /[*?!]/.test(host)) continue;
      if (!/mac|mini|phone|tether|local|lan|home/i.test(host)) continue;
      hosts.push(host);
    }
  }
  return hosts;
}

function dnsSd(args, timeoutMs = 3000) {
  const res = spawnSync('dns-sd', args, {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  return `${res.stdout || ''}\n${res.stderr || ''}`;
}

function bonjourSshHosts() {
  if (process.env.PHONE_TETHER_REMOTE_BONJOUR === '0') return [];
  const browse = dnsSd(['-B', '_ssh._tcp', 'local.']);
  const names = [];
  for (const line of browse.split(/\n/)) {
    const m = line.match(/\slocal\.\s+_ssh\._tcp\.\s+(.+)$/);
    if (m) names.push(m[1].trim());
  }
  const hosts = [];
  for (const name of unique(names)) {
    const resolved = dnsSd(['-L', name, '_ssh._tcp', 'local.']);
    const m = resolved.match(/can be reached at\s+(.+?)\s*:/i);
    if (m) hosts.push(m[1].replace(/\.$/, ''));
  }
  return hosts;
}

function expandSshUserCandidates(hosts) {
  const localUser = userInfo().username || '';
  const out = [];
  for (const host of hosts) {
    out.push(host);
    if (host.includes('@')) continue;
    if (localUser) out.push(`${localUser}@${host}`);
    const short = host.split('.')[0].toLowerCase();
    const owner = short.replace(/-?mac.*$/, '').replace(/s$/, '');
    if (owner && owner !== localUser && /^[a-z][a-z0-9_-]{1,31}$/.test(owner)) out.push(`${owner}@${host}`);
  }
  return unique(out);
}

function remoteHostCandidates() {
  const discovered = expandSshUserCandidates(unique([
    remoteSsh,
    ...splitEnvList('PHONE_TETHER_REMOTE_SSH_CANDIDATES'),
    ...bonjourSshHosts(),
    ...sshConfigHosts(),
  ]));
  return unique([
    ...discovered,
    'mac-mini.local',
    'macmini.local',
    'Mac-mini.local',
    'MacMini.local',
  ]);
}

function remoteRepoProbeCommand() {
  const literalRepos = unique([
    process.env.PHONE_TETHER_REMOTE_REPO || '',
    process.cwd(),
  ]);
  const checks = [
    ...literalRepos.map((repo) => shellQuote(repo)),
    '"$HOME/Documents/CodingProjects/Wisent/weles"',
    '"$HOME/CodingProjects/Wisent/weles"',
    '"$HOME/weles"',
  ];
  return `for d in ${checks.join(' ')}; do if [ -f "$d/scripts/debug/start_phone_tether_proxy.mjs" ]; then printf '%s\\n' "$d"; exit 0; fi; done; exit 1`;
}

function remoteNodeProbeCommand() {
  const explicit = process.env.PHONE_TETHER_REMOTE_NODE ? `${shellQuote(process.env.PHONE_TETHER_REMOTE_NODE)} ` : '';
  return [
    `for n in ${explicit}node /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node "$HOME/.nvm/current/bin/node" "$HOME/.volta/bin/node"; do`,
    `if command -v "$n" >/dev/null 2>&1; then command -v "$n"; exit 0; fi;`,
    `if [ -x "$n" ]; then printf '%s\\n' "$n"; exit 0; fi;`,
    `done; exit 127`,
  ].join(' ');
}

function runSsh(host, command, timeoutMs = 10_000) {
  const res = spawnSync('ssh', [...sshArgs, host, command], {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  return {
    ok: res.status === 0,
    status: res.status,
    signal: res.signal,
    stdout: String(res.stdout || ''),
    stderr: String(res.stderr || ''),
    error: res.error ? String(res.error.message || res.error) : '',
  };
}

function runScp(host, localPath, remotePath, timeoutMs = 10_000) {
  const res = spawnSync('scp', [...sshArgs, localPath, `${host}:${remotePath}`], {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  return {
    ok: res.status === 0,
    status: res.status,
    signal: res.signal,
    stdout: String(res.stdout || ''),
    stderr: String(res.stderr || ''),
    error: res.error ? String(res.error.message || res.error) : '',
  };
}

function parseJsonObject(text) {
  const body = String(text || '');
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}

function probeRemoteNode(host) {
  const res = runSsh(host, remoteNodeProbeCommand(), 8_000);
  if (!res.ok) return { ok: false, detail: res };
  const nodePath = res.stdout.trim().split(/\n/).at(-1);
  return nodePath ? { ok: true, nodePath } : { ok: false, detail: { ...res, stderr: 'empty node path' } };
}

function deployRemoteScripts(host) {
  const base = `/tmp/weles-phone-tether-${userInfo().username || 'user'}`;
  const mkdir = runSsh(host, `mkdir -p ${shellQuote(`${base}/scripts/debug`)} ${shellQuote(`${base}/scripts`)}`, 8_000);
  if (!mkdir.ok) return { ok: false, stage: 'mkdir', base, detail: mkdir };
  const phone = runScp(host, 'scripts/phone-proxy.mjs', `${base}/scripts/phone-proxy.mjs`, 10_000);
  if (!phone.ok) return { ok: false, stage: 'scp_phone_proxy', base, detail: phone };
  const start = runScp(host, 'scripts/debug/start_phone_tether_proxy.mjs', `${base}/scripts/debug/start_phone_tether_proxy.mjs`, 10_000);
  if (!start.ok) return { ok: false, stage: 'scp_start_proxy', base, detail: start };
  return { ok: true, base };
}

function discoverRemotePhoneTether() {
  if (process.env.PHONE_TETHER_REMOTE_AUTO === '0') return null;
  const attempts = [];
  for (const host of remoteHostCandidates()) {
    const repoProbe = runSsh(host, remoteRepoProbeCommand(), 8_000);
    let repo = repoProbe.stdout.trim().split(/\n/).at(-1);
    if (!repoProbe.ok && repoProbe.status === 1) {
      const deployed = deployRemoteScripts(host);
      if (deployed.ok) repo = deployed.base;
      else {
        attempts.push({ host, stage: `deploy_${deployed.stage}`, status: deployed.detail?.status, signal: deployed.detail?.signal, stderr: deployed.detail?.stderr?.slice(0, 500), error: deployed.detail?.error });
        continue;
      }
    } else if (!repoProbe.ok) {
      attempts.push({ host, stage: 'repo_probe', status: repoProbe.status, signal: repoProbe.signal, stderr: repoProbe.stderr.slice(0, 300), error: repoProbe.error });
      continue;
    }
    const nodeProbe = probeRemoteNode(host);
    if (!nodeProbe.ok) {
      attempts.push({ host, stage: 'node_probe', repo, status: nodeProbe.detail?.status, signal: nodeProbe.detail?.signal, stderr: nodeProbe.detail?.stderr?.slice(0, 500), error: nodeProbe.detail?.error });
      continue;
    }
    const detectCmd = `cd ${shellQuote(repo)} && PHONE_TETHER_DETECT_ONLY=1 PHONE_TETHER_PROXY_PORT=${String(remotePort)} ${shellQuote(nodeProbe.nodePath)} scripts/debug/start_phone_tether_proxy.mjs --detect-only`;
    const detect = runSsh(host, detectCmd, 10_000);
    const parsed = parseJsonObject(detect.stdout || detect.stderr);
    if (detect.ok && parsed?.ok && parsed.interface) {
      return { host, repo, nodePath: nodeProbe.nodePath, iface: parsed.interface, detect: parsed, attempts };
    }
    attempts.push({
      host,
      stage: 'interface_detect',
      repo,
      status: detect.status,
      signal: detect.signal,
      parsed,
      stderr: detect.stderr.slice(0, 500),
      error: detect.error,
    });
  }
  return { failed: true, attempts };
}

let iface = '';
const localIface = remoteSsh ? '' : detectInterface();
if (remoteSsh) {
  iface = remoteIface || 'auto';
} else if (localIface && ipv4Of(localIface)) {
  iface = localIface;
} else {
  console.log('[phone-tether] no local tether interface; trying remote SSH autodiscovery');
  const discovered = discoverRemotePhoneTether();
  if (discovered && !discovered.failed) {
    remoteSsh = discovered.host;
    remoteRepo = discovered.repo;
    remoteNode = discovered.nodePath;
    remoteIface = discovered.iface;
    iface = discovered.iface;
    console.log(JSON.stringify({
      ok: true,
      selected_remote_phone_tether: {
        host: remoteSsh,
        repo: remoteRepo,
        node: remoteNode,
        interface: iface,
        interface_ipv4: discovered.detect?.interface_ipv4 || null,
      },
    }, null, 2));
  } else {
    console.error(JSON.stringify({
      ok: false,
      error: localIface ? 'phone_tether_interface_has_no_ipv4' : 'no_phone_tether_interface_local_or_remote',
      remote_ssh: null,
      selected_interface: localIface || null,
      visible_ipv4_interfaces: Object.keys(all).map((name) => ({ iface: name, ipv4: ipv4Of(name) })).filter((row) => row.ipv4),
      remote_attempts: discovered?.attempts || [],
    }, null, 2));
    process.exit(2);
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchExitIpViaProxy() {
  const { execFileSync } = await import('node:child_process');
  for (let i = 0; i < 20; i++) {
    if (childExits.length > 0) return '';
    try {
      const ip = execFileSync('curl', ['-sS', '--max-time', '5', '-x', proxyUrl, 'https://api.ipify.org'], { encoding: 'utf8' }).trim();
      if (/^(?:\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]{3,}$/i.test(ip)) return ip;
    } catch {}
    if (childExits.length > 0) return '';
    await wait(500);
  }
  return '';
}

const children = [];
const childExits = [];
let phoneProxy;
let tunnel;

function trackChild(child, label) {
  child.on('exit', (code, signal) => {
    childExits.push({ label, code, signal });
  });
}

if (remoteSsh) {
  const ifaceArg = remoteIface ? ` ${shellQuote(remoteIface)} ${String(remotePort)}` : '';
  const nodeExpr = remoteNode
    ? shellQuote(remoteNode)
    : `"$(for n in node /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node "$HOME/.nvm/current/bin/node" "$HOME/.volta/bin/node"; do if command -v "$n" >/dev/null 2>&1; then command -v "$n"; exit 0; fi; if [ -x "$n" ]; then printf '%s\\n' "$n"; exit 0; fi; done; exit 127)"`;
  const remoteCmd = [
    `cd ${shellQuote(remoteRepo)}`,
    `exec env PHONE_TETHER_PROXY_PORT=${String(remotePort)} ${nodeExpr} scripts/debug/start_phone_tether_proxy.mjs${ifaceArg}`,
  ].join(' && ');
  console.log(`[phone-tether] remote ${remoteSsh}: ${remoteCmd}`);
  phoneProxy = spawn('ssh', [...sshArgs, remoteSsh, remoteCmd], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(phoneProxy);
  trackChild(phoneProxy, 'remote_phone_proxy_ssh');
  tunnel = spawn('ssh', [...sshArgs, '-N', '-L', `${localPort}:127.0.0.1:${remotePort}`, remoteSsh], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(tunnel);
  trackChild(tunnel, 'ssh_tunnel');
  tunnel.stdout.on('data', (chunk) => process.stdout.write(chunk));
  tunnel.stderr.on('data', (chunk) => process.stderr.write(chunk));
} else {
  phoneProxy = spawn(process.execPath, ['scripts/phone-proxy.mjs', iface, String(localPort)], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(phoneProxy);
  trackChild(phoneProxy, 'local_phone_proxy');
}
phoneProxy.stdout.on('data', (chunk) => process.stdout.write(chunk));
phoneProxy.stderr.on('data', (chunk) => process.stderr.write(chunk));

await wait(500);
if (childExits.length > 0) {
  for (const child of children) {
    try { child.kill('SIGTERM'); } catch {}
  }
  console.error(JSON.stringify({
    ok: false,
    error: 'phone_proxy_process_exited_before_probe',
    remote_ssh: remoteSsh || null,
    interface: iface,
    proxy_url: proxyUrl,
    child_exits: childExits,
  }, null, 2));
  process.exit(3);
}

const exitIp = await fetchExitIpViaProxy();
if (!exitIp) {
  for (const child of children) {
    try { child.kill('SIGTERM'); } catch {}
  }
  console.error(JSON.stringify({
    ok: false,
    error: 'phone_proxy_exit_ip_probe_failed',
    remote_ssh: remoteSsh || null,
    interface: iface,
    interface_ipv4: remoteSsh ? null : ipv4Of(iface),
    proxy_url: proxyUrl,
    local_port: localPort,
    remote_port: remoteSsh ? remotePort : null,
    child_exits: childExits,
  }, null, 2));
  process.exit(3);
}

console.log(JSON.stringify({
  ok: true,
  row_id: rowId,
  remote_ssh: remoteSsh || null,
  interface: iface,
  interface_ipv4: remoteSsh ? null : ipv4Of(iface),
  proxy_url: proxyUrl,
  local_port: localPort,
  remote_port: remoteSsh ? remotePort : null,
  exit_ip: exitIp,
}, null, 2));

const env = {
  ...process.env,
  ACTION_LOG_ID: rowId,
  PHONE_TETHER_IFACE: iface,
  PHONE_TETHER_REMOTE_SSH: remoteSsh,
  PHONE_TETHER_REMOTE_IFACE: remoteIface || '',
  PROXY_URL: proxyUrl,
  DIAGNOSTIC_PROXY: proxyUrl,
  DIAGNOSTIC_SAME_IP_PROXY: proxyUrl,
  LINKEDIN_REGISTER_PROXY: proxyUrl,
  WELES_LINKEDIN_PROXY: proxyUrl,
  LINKEDIN_PROXY_KIND: 'phone_tether_static_current_ip',
  LINKEDIN_PROXY_COUNTRY: process.env.LINKEDIN_PROXY_COUNTRY || 'us',
  DIAGNOSTIC_ALLOW_STDIN_DONE: process.env.DIAGNOSTIC_ALLOW_STDIN_DONE || '1',
};

const diag = spawn(process.execPath, ['scripts/diag/run_diagnostic_request.mjs', `--row-id=${rowId}`], {
  cwd: process.cwd(),
  env,
  stdio: 'inherit',
});

function shutdown(signal = 'SIGTERM') {
  try { diag.kill(signal); } catch {}
  for (const child of children) {
    try { child.kill(signal); } catch {}
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
diag.on('exit', (code, signal) => {
  for (const child of children) {
    try { child.kill('SIGTERM'); } catch {}
  }
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
