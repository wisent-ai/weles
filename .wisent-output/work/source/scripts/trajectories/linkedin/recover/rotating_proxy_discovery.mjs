/**
 * Sample rotating residential/mobile proxy pools for LinkedIn signup readiness.
 *
 * This is discovery only: it does not open a browser, fill signup fields, or
 * submit account data. It samples sticky sessions, records exit IP/reputation,
 * and runs the same /signup preflight used by the register resolver.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runRecordingsDir } from '../../../../dist/session/run-recordings.js';
import { generatePersona } from '../../../../dist/browser/persona.js';
import { probeLinkedinSignup, verifyExitCountry, verifyExitReputation } from '../../../../dist/proxy/policy.js';

const OUT = runRecordingsDir('linkedin_rotating_proxy_discovery');
const WORK = join(process.cwd(), '.work', 'linkedin_rotating_proxy_discovery');
mkdirSync(OUT, { recursive: true });
mkdirSync(WORK, { recursive: true });

const SAMPLES_PER_PROVIDER = Math.max(1, Number(process.env.LINKEDIN_ROTATING_DISCOVERY_SAMPLES || 6));
const TIMEOUT_SECS = Math.max(3, Number(process.env.LINKEDIN_ROTATING_DISCOVERY_TIMEOUT || 8));
const TARGET_CC = (process.env.LINKEDIN_ROTATING_DISCOVERY_COUNTRY || 'us').toLowerCase();
const INCLUDE = new Set(String(process.env.LINKEDIN_ROTATING_DISCOVERY_INCLUDE || 'mobile,residential,bright,pingproxies,packetstream,iproyal,oxylabs')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean));

function hash(value) {
  const text = String(value ?? '');
  return text ? createHash('sha256').update(text).digest('hex').slice(0, 16) : '';
}

function safeProviderKey(row) {
  const name = String(row.display_name || '').toLowerCase();
  if (name.includes('oxylabs')) return 'oxylabs';
  if (name.includes('iproyal')) return 'iproyal';
  if (name.includes('bright')) return 'brightdata';
  if (name.includes('pingproxies')) return 'pingproxies';
  if (name.includes('packetstream')) return 'packetstream';
  return name.replace(/[^a-z0-9]+/g, '_') || 'unknown';
}

function isRotatingCandidate(row) {
  const text = `${row.display_name || ''} ${row.proxy_host || ''}`.toLowerCase();
  if (text.includes('isp')) return false;
  if (text.includes('mobile') && INCLUDE.has('mobile')) return true;
  if (text.includes('residential') && INCLUDE.has('residential')) return true;
  for (const key of ['bright', 'pingproxies', 'packetstream', 'iproyal', 'oxylabs']) {
    if (text.includes(key) && INCLUDE.has(key)) return true;
  }
  return false;
}

function envPassName(userEnv = '') {
  return userEnv.replace('USERNAME', 'PASSWORD').replace('API_KEY', 'PASSWORD');
}

function buildStickyAuth(row, username, password, sessId, cc) {
  const name = String(row.display_name || '').toLowerCase();
  const host = String(row.proxy_host || '').toLowerCase();
  const metadata = row.metadata || {};
  const city = String(metadata.city_overrides?.linkedin || metadata.city || '')
    .toLowerCase()
    .replace(/\s+/g, '_');

  if (name.includes('oxylabs') || host.includes('oxylabs')) {
    const cityPart = city ? `-city-${city}` : '';
    const raw = username.startsWith('customer-') ? username.replace(/^customer-/, '') : username;
    return {
      username: `customer-${raw}-cc-${cc}${cityPart}-sessid-${sessId}`,
      password,
    };
  }
  if (name.includes('packetstream') || host.includes('packetstream')) {
    return {
      username,
      password: `${password}_country-${cc.toUpperCase()}_session-${sessId}`,
    };
  }
  if (name.includes('iproyal') || host.includes('iproyal')) {
    return {
      username,
      password: `${password}_country-${cc}_session-${sessId}`,
    };
  }
  if (name.includes('pingproxies') || host.includes('pingproxies')) {
    return {
      username: `${username}_c_${cc}_s_${sessId}`,
      password,
    };
  }
  if (name.includes('bright') || host.includes('brd.superproxy.io')) {
    return {
      username: `${username}-country-${cc}-session-${sessId}`,
      password,
    };
  }
  return { username, password };
}

function proxyUrlFor(row, username, password) {
  return `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${row.proxy_host}:${row.proxy_port}`;
}

function sampleExitIp(proxyUrl, timeoutSecs = TIMEOUT_SECS) {
  try {
    return execFileSync('curl', ['-sS', '--max-time', String(timeoutSecs), '-x', proxyUrl, 'https://api.ipify.org'], {
      encoding: 'utf8',
      maxBuffer: 128 * 1024,
    }).trim();
  } catch {
    return '';
  }
}

async function fetchRows() {
  const databaseUrl = process.env.WELES_DATABASE_URL ?? '';
  const databaseToken = process.env.WELES_DATABASE_TOKEN ?? '';
  if (!databaseUrl || !databaseToken) throw new Error('missing Supabase env');
  const url = `${databaseUrl}/rest/v1/service_credentials?category=eq.proxy&proxy_host=not.is.null&select=display_name,proxy_host,proxy_port,api_key_env_var,metadata&order=display_name.asc`;
  const res = await fetch(url, { headers: { apikey: databaseToken, Authorization: `Bearer ${databaseToken}` } });
  if (!res.ok) throw new Error(`service_credentials fetch failed: ${res.status}`);
  return await res.json();
}

const startedAt = new Date().toISOString();
const persona = generatePersona({ country: TARGET_CC.toUpperCase(), os: 'windows', browser: 'chromium' });
const rows = (await fetchRows()).filter(isRotatingCandidate);
const results = [];

console.log(`[rotating-discovery] providers=${rows.length} samples=${SAMPLES_PER_PROVIDER} cc=${TARGET_CC}`);

for (const row of rows) {
  const userEnv = row.api_key_env_var || '';
  const passEnv = envPassName(userEnv);
  const baseUser = process.env[userEnv] || '';
  const basePass = process.env[passEnv] || '';
  const provider = safeProviderKey(row);
  if (!baseUser || !basePass) {
    results.push({
      provider,
      display_name: row.display_name,
      endpoint: { host: row.proxy_host, port: String(row.proxy_port) },
      skipped: true,
      reason: 'missing_env',
      env: { username: userEnv, password: passEnv },
    });
    continue;
  }

  for (let i = 0; i < SAMPLES_PER_PROVIDER; i++) {
    const sessId = Math.floor(Math.random() * 9000000 + 1000000);
    const auth = buildStickyAuth(row, baseUser, basePass, sessId, TARGET_CC);
    const proxyUrl = proxyUrlFor(row, auth.username, auth.password);
    const exitIp = sampleExitIp(proxyUrl);
    const geo = exitIp ? await verifyExitCountry(exitIp, TARGET_CC) : { result: 'unknown' };
    const reputation = exitIp ? await verifyExitReputation(exitIp).catch(() => ({ result: 'unknown' })) : { result: 'unknown' };
    const probe = exitIp ? await probeLinkedinSignup(proxyUrl, TIMEOUT_SECS, persona) : { result: 'unknown', error: 'exit_ip_missing' };
    const item = {
      provider,
      display_name: row.display_name,
      endpoint: { host: row.proxy_host, port: String(row.proxy_port) },
      sticky_hash: hash(sessId),
      proxy_user_hash: hash(auth.username),
      exit_ip: exitIp || null,
      exit_ip_hash: hash(exitIp),
      geo,
      reputation,
      linkedin_probe: {
        result: probe.result,
        bytes: probe.bytes ?? null,
        transport: probe.transport ?? null,
        body_markers: probe.body_markers ?? null,
        error: probe.error ?? null,
      },
    };
    results.push(item);
    console.log(`[rotating-discovery] ${row.display_name} sample=${i + 1}/${SAMPLES_PER_PROVIDER} exit=${exitIp || '?'} geo=${geo.result} rep=${reputation.result} linkedin=${probe.result}`);
  }
}

const formCandidates = results.filter((r) => r.linkedin_probe?.result === 'form');
const summary = {
  started_at: startedAt,
  completed_at: new Date().toISOString(),
  samples_per_provider: SAMPLES_PER_PROVIDER,
  target_country: TARGET_CC,
  persona: {
    os: persona.os,
    browser: persona.browser,
    userAgentOs: persona.userAgentOs,
    platform: persona.platform,
    gpu: persona.gpu,
    screen: persona.screen,
    timezone: persona.timezone,
    language: persona.language,
  },
  provider_count: rows.length,
  sample_count: results.filter((r) => !r.skipped).length,
  form_candidate_count: formCandidates.length,
  form_candidates: formCandidates.map((r) => ({
    provider: r.provider,
    display_name: r.display_name,
    endpoint: r.endpoint,
    exit_ip: r.exit_ip,
    geo: r.geo,
    reputation: r.reputation,
    sticky_hash: r.sticky_hash,
  })),
  results,
};

writeFileSync(join(OUT, 'rotating_proxy_discovery.json'), JSON.stringify(summary, null, 2));
writeFileSync(join(WORK, 'latest.json'), JSON.stringify(summary, null, 2));

if (formCandidates.length) {
  console.log(`PASS: form candidates=${formCandidates.length}`);
} else {
  console.log('FAIL: no rotating residential/mobile form candidates');
  process.exitCode = 2;
}
