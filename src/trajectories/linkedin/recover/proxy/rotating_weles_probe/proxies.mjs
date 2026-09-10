// The proxy rows the probe samples: which are included, how a sticky session is built, and the exit each answers.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { listProxies } from '../../../../_shared/skarbiec/proxies.mjs';
import { INCLUDE } from './settings.mjs';

export function hash(value) {
  const text = String(value ?? '');
  return text ? createHash('sha256').update(text).digest('hex').slice(0, 16) : '';
}


export function includeRow(row) {
  const name = String(row.display_name || '').toLowerCase();
  const host = String(row.proxy_host || '').toLowerCase();
  if (name.includes('isp')) return false;
  for (const token of INCLUDE) {
    if (name.includes(token) || host.includes(token)) return true;
    if (token === 'oxylabs mobile' && name.includes('oxylabs') && name.includes('mobile')) return true;
    if (token === 'oxylabs residential' && name.includes('oxylabs') && name.includes('residential')) return true;
    if (token === 'bright data' && name.includes('bright')) return true;
  }
  return false;
}

export function providerKey(row) {
  const name = String(row.display_name || '').toLowerCase();
  if (name.includes('oxylabs')) return 'oxylabs';
  if (name.includes('iproyal')) return 'iproyal';
  if (name.includes('bright')) return 'brightdata';
  if (name.includes('pingproxies')) return 'pingproxies';
  if (name.includes('packetstream')) return 'packetstream';
  return name.replace(/[^a-z0-9]+/g, '_') || 'unknown';
}

export function buildStickyAuth(row, username, password, sessId, cc) {
  const name = String(row.display_name || '').toLowerCase();
  const host = String(row.proxy_host || '').toLowerCase();
  const metadata = row.metadata || {};
  const city = String(metadata.city_overrides?.linkedin || metadata.city || '')
    .toLowerCase()
    .replace(/\s+/g, '_');

  if (name.includes('oxylabs') || host.includes('oxylabs')) {
    const raw = username.startsWith('customer-') ? username.replace(/^customer-/, '') : username;
    const cityPart = city ? `-city-${city}` : '';
    return { username: `customer-${raw}-cc-${cc}${cityPart}-sessid-${sessId}`, password };
  }
  if (name.includes('packetstream') || host.includes('packetstream')) {
    return { username, password: `${password}_country-${cc.toUpperCase()}_session-${sessId}` };
  }
  if (name.includes('iproyal') || host.includes('iproyal')) {
    return { username, password: `${password}_country-${cc}_session-${sessId}` };
  }
  if (name.includes('pingproxies') || host.includes('pingproxies')) {
    return { username: `${username}_c_${cc}_s_${sessId}`, password };
  }
  if (name.includes('bright') || host.includes('brd.superproxy.io')) {
    return { username: `${username}-country-${cc}-session-${sessId}`, password };
  }
  return { username, password };
}

export function proxyUrlFor(row, username, password) {
  return `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${row.proxy_host}:${row.proxy_port}`;
}

export function sampleExitIp(proxyUrl) {
  try {
    return execFileSync('curl', ['-sS', '--max-time', '8', '-x', proxyUrl, 'https://api.ipify.org'], {
      encoding: 'utf8',
      maxBuffer: 128 * 1024,
    }).trim();
  } catch {
    return '';
  }
}

export function fetchRows() {
  return listProxies()
    .filter((proxy) => proxy.host && proxy.port && proxy.username && proxy.password)
    .map((proxy) => ({
      id: proxy.id,
      display_name: proxy.displayName,
      proxy_host: proxy.host,
      proxy_port: proxy.port,
      username: proxy.username,
      password: proxy.password,
      metadata: proxy.metadata,
    }));
}
