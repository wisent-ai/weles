#!/usr/bin/env node
// Prepare a same-proxy environment file for side-by-side fingerprint audits
// without printing proxy credentials to stdout.

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { listProxies } from '../trajectories/_shared/skarbiec_proxies.mjs';

const providerToken = String(process.argv[2] || process.env.AUDIT_PROXY_PROVIDER || 'packetstream').toLowerCase();
const targetCc = String(process.env.AUDIT_PROXY_COUNTRY || 'US').toUpperCase();
const outPath = process.env.AUDIT_PROXY_ENV_OUT || join(process.cwd(), '.work', 'audit_proxy_env.sh');

function hash(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 16);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}


function rowMatches(row) {
  const haystack = `${row.display_name || ''} ${row.proxy_host || ''}`.toLowerCase();
  return haystack.includes(providerToken);
}

function buildStickyAuth(row, username, password, sessId, cc) {
  const name = String(row.display_name || '').toLowerCase();
  const host = String(row.proxy_host || '').toLowerCase();
  const metadata = row.metadata || {};
  const city = String(metadata.city_overrides?.linkedin || metadata.city || '')
    .toLowerCase()
    .replace(/\s+/g, '_');

  if (name.includes('oxylabs') || host.includes('oxylabs')) {
    const raw = username.startsWith('customer-') ? username.replace(/^customer-/, '') : username;
    const cityPart = city ? `-city-${city}` : '';
    return { username: `customer-${raw}-cc-${cc.toLowerCase()}${cityPart}-sessid-${sessId}`, password };
  }
  if (name.includes('packetstream') || host.includes('packetstream')) {
    return { username, password: `${password}_country-${cc}_session-${sessId}` };
  }
  if (name.includes('bright') || host.includes('brd.superproxy.io')) {
    return { username: `${username}-country-${cc.toLowerCase()}-session-${sessId}`, password };
  }
  if (name.includes('iproyal') || host.includes('iproyal')) {
    return { username, password: `${password}_country-${cc.toLowerCase()}_session-${sessId}` };
  }
  if (name.includes('pingproxies') || host.includes('pingproxies')) {
    return { username: `${username}_c_${cc.toLowerCase()}_s_${sessId}`, password };
  }
  return { username, password };
}

function proxyUrlFor(row, username, password) {
  return `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${row.proxy_host}:${row.proxy_port}`;
}

function redactedUrl(raw) {
  const url = new URL(raw);
  const hasAuth = Boolean(url.username || url.password);
  url.username = hasAuth ? '<user>' : '';
  url.password = hasAuth ? '<pass>' : '';
  return url.toString();
}

function sampleExit(proxyUrl) {
  try {
    return execFileSync('curl', ['-sS', '--max-time', '10', '-x', proxyUrl, 'https://api.ipify.org'], {
      encoding: 'utf8',
      maxBuffer: 128 * 1024,
    }).trim();
  } catch {
    return '';
  }
}

function fetchRows() {
  return listProxies().map((proxy) => ({
    id: proxy.id,
    display_name: proxy.displayName,
    proxy_host: proxy.host,
    proxy_port: proxy.port,
    username: proxy.username,
    password: proxy.password,
    metadata: proxy.metadata,
  }));
}

const rows = fetchRows().filter(rowMatches);
const row = rows[0];
if (!row) throw new Error(`no Skarbiec proxy item matched ${providerToken}`);
const baseUser = row.username || '';
const basePass = row.password || '';
if (!baseUser || !basePass) throw new Error(`Skarbiec proxy item is incomplete: ${row.id}`);

const sessId = process.env.AUDIT_PROXY_SESSION || String(Math.floor(Math.random() * 9000000 + 1000000));
const auth = buildStickyAuth(row, baseUser, basePass, sessId, targetCc);
const proxyUrl = proxyUrlFor(row, auth.username, auth.password);
const exitIp = sampleExit(proxyUrl);

mkdirSync(join(process.cwd(), '.work'), { recursive: true });
writeFileSync(outPath, [
  `export AUDIT_PROXY_URL=${shellQuote(proxyUrl)}`,
  `export PROBE_PROXY=${shellQuote(proxyUrl)}`,
  '',
].join('\n'));
chmodSync(outPath, 0o600);

console.log(JSON.stringify({
  outPath,
  provider: row.display_name,
  endpoint: `${row.proxy_host}:${row.proxy_port}`,
  proxy_redacted: redactedUrl(proxyUrl),
  proxy_user_hash: hash(auth.username),
  sticky_hash: hash(sessId),
  exit_ip_hash: hash(exitIp),
  exit_ip_present: Boolean(exitIp),
}, null, 2));
