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
import { runRecordingsDir } from '../../../../../dist/session/run-recordings.js';
import { generatePersona } from '../../../../../dist/browser/persona.js';
import { probeLinkedinSignup, verifyExitCountry, verifyExitReputation } from '../../../../../dist/proxy/policy.js';
import { parseInclude, rotatingRows, stickySession } from '../../../_shared/skarbiec/proxies.mjs';

const OUT = runRecordingsDir('linkedin_rotating_proxy_discovery');
const WORK = join(process.cwd(), '.work', 'linkedin_rotating_proxy_discovery');
mkdirSync(OUT, { recursive: true });
mkdirSync(WORK, { recursive: true });

const SAMPLES_PER_PROVIDER = Math.max(1, Number(process.env.LINKEDIN_ROTATING_DISCOVERY_SAMPLES || 6));
const TARGET_CC = (process.env.LINKEDIN_ROTATING_DISCOVERY_COUNTRY || 'us').toLowerCase();
// Which rotating pools to sample: `provider[/type]` entries, by the provider
// the endpoint derives and the pool type the Skarbiec item declares.
const INCLUDE = parseInclude(process.env.LINKEDIN_ROTATING_DISCOVERY_INCLUDE || 'brightdata,pingproxies,packetstream,iproyal,oxylabs');

function hash(value) {
  const text = String(value ?? '');
  return text ? createHash('sha256').update(text).digest('hex').slice(0, 16) : '';
}

function proxyUrlFor(row, username, password) {
  return `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${row.host}:${row.port}`;
}

// One request through the proxy; curl's own connect and transfer errors are
// the answer when the pool does not deliver, reported with the exit IP blank.
function sampleExitIp(proxyUrl) {
  try {
    return execFileSync('curl', ['-sS', '-x', proxyUrl, 'https://api.ipify.org'], {
      encoding: 'utf8',
      maxBuffer: 128 * 1024,
    }).trim();
  } catch (error) {
    console.log(`[rotating-discovery] proxy_sample_failed: ${String(error.stderr || error.message).trim()}`);
    return '';
  }
}

const startedAt = new Date().toISOString();
const persona = generatePersona({ country: TARGET_CC.toUpperCase(), os: 'windows', browser: 'chromium' });
const { candidates: rows, undeclared } = rotatingRows(INCLUDE);
const results = undeclared.map((row) => ({
  provider: row.provider,
  display_name: row.displayName,
  endpoint: { host: row.host, port: String(row.port) },
  reason: 'proxy_type_undeclared',
  skipped: true,
}));

console.log(`[rotating-discovery] providers=${rows.length} undeclared=${undeclared.length} samples=${SAMPLES_PER_PROVIDER} cc=${TARGET_CC}`);
for (const row of undeclared) console.log(`[rotating-discovery] ${row.displayName} (${row.id}) declares no proxy_type in its Skarbiec context; set it to isp, mobile or residential`);

for (const row of rows) {
  const provider = row.provider;

  for (let i = 0; i < SAMPLES_PER_PROVIDER; i++) {
    const sessId = Math.floor(Math.random() * 9000000 + 1000000);
    const auth = stickySession(row, sessId, TARGET_CC, 'linkedin');
    const proxyUrl = proxyUrlFor(row, auth.username, auth.password);
    const exitIp = sampleExitIp(proxyUrl);
    const geo = exitIp ? await verifyExitCountry(exitIp, TARGET_CC) : { result: 'unknown' };
    const reputation = exitIp ? await verifyExitReputation(exitIp).catch(() => ({ result: 'unknown' })) : { result: 'unknown' };
    const probe = exitIp ? await probeLinkedinSignup(proxyUrl, persona) : { result: 'unknown', error: 'exit_ip_missing' };
    const item = {
      provider,
      display_name: row.displayName,
      endpoint: { host: row.host, port: String(row.port) },
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
    console.log(`[rotating-discovery] ${row.displayName} sample=${i + 1}/${SAMPLES_PER_PROVIDER} exit=${exitIp || '?'} geo=${geo.result} rep=${reputation.result} linkedin=${probe.result}`);
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
