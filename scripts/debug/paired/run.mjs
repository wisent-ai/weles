#!/usr/bin/env node
// Paired-comparison isolation test queuer.
//
// Replaces hand-crafted curl POSTs for queueing paired tests. Reads proxy
// credentials from weles/.env, queues N action_logs rows holding all
// factors constant except the one being varied, then the content-platform
// burn-attribution cron at /api/cron/burn-attribution attributes burns
// when paired outcomes flip.
//
// Usage:
//   node scripts/debug/paired/run.mjs \
//     --platform=linkedin --action=linkedin_register \
//     --vary=ip --hold-domain=mailpost847.com \
//     --pools=decodo,oxylabs-dedicated-isp
//
//   node scripts/debug/paired/run.mjs \
//     --platform=linkedin --action=linkedin_register \
//     --vary=domain --hold-ip=isp.decodo.com:10001 \
//     --domains=inboxmail659.com,mailpost847.com,pilatesguild.com
//
// Per-account in-flight lock serializes the rows through one worker
// session so persona/timing/captcha state stays as close to constant
// as the worker can manage.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WELES_ROOT = join(__dirname, '..', '..', '..');
const ENV_PATH = join(WELES_ROOT, '.env');
if (!existsSync(ENV_PATH)) { console.error(`weles/.env not found at ${ENV_PATH}`); process.exit(2); }
const ENV = Object.fromEntries(readFileSync(ENV_PATH, 'utf8').split('\n').filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));

const SUPABASE_URL = process.env.SUPABASE_URL || ENV.SUPABASE_URL || ENV.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ENV.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error('SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required'); process.exit(2); }

const args = Object.fromEntries(process.argv.slice(2).map(a => { const i = a.indexOf('='); return [a.slice(2, i === -1 ? a.length : i), i === -1 ? 'true' : a.slice(i + 1)]; }));
if (!args.platform || !args.action || !args.vary) { console.error('--platform, --action, --vary required'); process.exit(2); }
if (!['ip', 'domain'].includes(args.vary)) { console.error('--vary must be ip or domain'); process.exit(2); }
const ACCOUNT_ID = args['account-id'] || 'f29ed323-d5f7-4d76-b43c-be0fa7583bcb';

function poolProxies(name) {
  if (name === 'decodo') {
    const host = ENV.DECODO_ISP_HOST, user = ENV.DECODO_ISP_USER, pass = ENV.DECODO_ISP_PASS;
    const ports = (ENV.DECODO_ISP_PORTS || '').split(',');
    if (!host || !user || !pass || !ports.length) return [];
    return ports.map(p => `http://${user}:${pass}@${host}:${p.trim()}`);
  }
  if (name === 'oxylabs-dedicated-isp') {
    const host = ENV.OXYLABS_DEDICATED_ISP_HOST, user = ENV.OXYLABS_DEDICATED_ISP_USERNAME, pass = ENV.OXYLABS_DEDICATED_ISP_PASSWORD;
    const ports = (ENV.OXYLABS_DEDICATED_ISP_PORTS || '').split(',');
    if (!host || !user || !pass || !ports.length) return [];
    return ports.map(p => `http://${user}:${pass}@${host}:${p.trim()}`);
  }
  if (name === 'oxylabs-residential') {
    // Counterfactual residential IP class against Decodo/Oxylabs Comcast static
    // ISP pools. pr.oxylabs.io:7777 with sticky sessid. The pool rotates IPs by
    // design; the sessid+sesstime hint pins exits within a 30-min window per
    // session, so each --reps invocation produces N distinct exits across the
    // pool — exactly the IP-class variation needed to attribute static-ISP
    // burns against a residential counterfactual.
    const user = ENV.OXYLABS_USERNAME, pass = ENV.OXYLABS_PASSWORD;
    if (!user || !pass) return [];
    const sessions = parseInt(process.env.OXYLABS_RESI_SESSIONS || '3', 10);
    const out = [];
    for (let i = 0; i < sessions; i++) {
      const sid = `paired${Date.now()}${i}`;
      out.push(`http://customer-${user}-cc-US-sessid-${sid}-sesstime-30:${pass}@pr.oxylabs.io:7777`);
    }
    return out;
  }
  throw new Error(`unknown pool: ${name} (supported: decodo, oxylabs-dedicated-isp, oxylabs-residential)`);
}

let plan;
if (args.vary === 'ip') {
  if (!args['hold-domain']) { console.error('--vary=ip requires --hold-domain'); process.exit(2); }
  const pools = (args.pools || 'decodo,oxylabs-dedicated-isp').split(',').map(s => s.trim());
  const proxies = pools.flatMap(poolProxies);
  if (!proxies.length) { console.error('no proxies resolved from pools'); process.exit(2); }
  plan = proxies.map(proxy => ({ proxy, domain: args['hold-domain'] }));
} else {
  if (!args['hold-ip']) { console.error('--vary=domain requires --hold-ip (host:port)'); process.exit(2); }
  const domains = (args.domains || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!domains.length) { console.error('--vary=domain requires --domains=a.com,b.com,...'); process.exit(2); }
  const [host, port] = args['hold-ip'].split(':');
  let user, pass;
  if (host === ENV.DECODO_ISP_HOST) { user = ENV.DECODO_ISP_USER; pass = ENV.DECODO_ISP_PASS; }
  else if (host === ENV.OXYLABS_DEDICATED_ISP_HOST) { user = ENV.OXYLABS_DEDICATED_ISP_USERNAME; pass = ENV.OXYLABS_DEDICATED_ISP_PASSWORD; }
  else { console.error(`unknown proxy host: ${host}`); process.exit(2); }
  const proxy = `http://${user}:${pass}@${host}:${port}`;
  plan = domains.map(domain => ({ proxy, domain }));
}

const reps = parseInt(args.reps || '1', 10);
const expanded = [];
for (let i = 0; i < reps; i++) for (const p of plan) expanded.push(p);

console.log(`[paired] queueing ${expanded.length} rows: platform=${args.platform} action=${args.action} vary=${args.vary}`);
const TAG_NS = args.tag || `paired_${args.vary}_${Date.now()}`;
const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const ids = [];
for (const p of expanded) {
  const port = new URL(p.proxy).port;
  const tag = `${TAG_NS}_${port}_${p.domain}`;
  const body = { account_id: ACCOUNT_ID, platform: args.platform, action: args.action, status: 'queued', scheduled_at: new Date().toISOString(), params: { source: tag, proxy_url_override: p.proxy, force_email_domain: p.domain } };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/account_action_logs`, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) { console.error(`row INSERT failed http=${res.status}: ${(await res.text()).slice(0, 200)}`); process.exit(3); }
  const row = (await res.json())[0];
  ids.push(row.id);
  console.log(`  queued ${row.id.slice(0, 8)} port=${port} domain=${p.domain}`);
}
console.log(`\ntag namespace: ${TAG_NS}`);

// Chrome baseline auto-capture: for each unique proxy in the plan, run
// instrument_chrome.mjs from the SAME proxy as a paired counterfactual.
// instrument_chrome.mjs respects CAPTURE_DURATION_MS for self-termination
// (the script chooses its own capture window — no external killer).
// The resulting dump is greped for PerimeterX markers and inserted as a
// synthetic account_action_logs row with action=chrome_baseline_<platform>_register
// so the burn-attribution matcher can read it as a pairable row.
// Disable with --no-chrome.
if (args['no-chrome'] !== 'true') {
  const TARGET_URL = args.platform === 'linkedin' ? 'https://www.linkedin.com/signup' : '';
  if (!TARGET_URL) { console.log('[paired] no TARGET_URL mapping for platform=' + args.platform + '; skip chrome baselines'); }
  else {
    const { spawn } = await import('node:child_process');
    const { readFileSync } = await import('node:fs');
    const uniqueProxies = [...new Set(expanded.map(p => p.proxy))];
    console.log(`\n[paired] firing ${uniqueProxies.length} chrome baselines (CAPTURE_DURATION_MS=30000, parallel)`);
    const captures = uniqueProxies.map(proxy => new Promise((resolve) => {
      const env = { ...process.env, PLATFORM: args.platform, TARGET_URL, PROXY_URL: proxy, CHROME_BIN: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', CAPTURE_DURATION_MS: '30000', WELES_FIRST_RUN: '1' };
      const child = spawn('node', [join(WELES_ROOT, 'scripts', 'debug', 'instrument_chrome.mjs')], { env, stdio: 'pipe' });
      let outPath = '';
      child.stdout.on('data', d => { const s = d.toString(); const m = s.match(/output -> (\S+\.json)/); if (m) outPath = m[1]; });
      child.on('close', () => resolve({ proxy, port: new URL(proxy).port, dumpPath: outPath }));
    }));
    const results = await Promise.all(captures);
    for (const r of results) {
      if (!r.dumpPath) { console.log(`  chrome ${r.port}: capture had no dump path (likely chrome failed to launch)`); continue; }
      let protechts = 0;
      try { protechts = (readFileSync(r.dumpPath, 'utf8').match(/protechts\.net/g) || []).length; } catch (e) { console.log(`  chrome ${r.port}: read err ${e.message?.slice(0, 60)}`); continue; }
      const baseDomain = args.vary === 'ip' ? args['hold-domain'] : (plan.find(p => p.proxy === r.proxy)?.domain ?? '');
      const status = protechts > 0 ? 'failed' : 'completed';
      const body = { account_id: ACCOUNT_ID, platform: args.platform, action: `chrome_baseline_${args.platform}_register`, status, scheduled_at: new Date().toISOString(), completed_at: new Date().toISOString(), result: { session: { provider: 'chrome', proxy_host: new URL(r.proxy).hostname, proxy_port: r.port }, ban_signal: { healthy: protechts === 0, signal: protechts > 0 ? 'perimeterx_loaded' : 'clean', details: { protechts_count: protechts, dump_path: r.dumpPath } }, artifacts: { videos: [], video: null, screenshots: [], dom: [], logs: [r.dumpPath] } }, params: { source: `${TAG_NS}_chrome_${r.port}`, proxy_url_override: r.proxy, force_email_domain: baseDomain, browser: 'chrome' } };
      const ins = await fetch(`${SUPABASE_URL}/rest/v1/account_action_logs`, { method: 'POST', headers, body: JSON.stringify(body) });
      if (!ins.ok) { console.log(`  chrome ${r.port}: INSERT failed http=${ins.status}`); continue; }
      const row = (await ins.json())[0];
      console.log(`  chrome ${r.port}: protechts=${protechts} status=${status} row=${row.id.slice(0, 8)}`);
    }
  }
}

console.log('\nquery:');
console.log(`  curl "${SUPABASE_URL}/rest/v1/account_action_logs?params->>source=like.${TAG_NS}%25&select=status,action,params->>force_email_domain,result->session->>exit_ip,result->ban_signal->signal"`);
console.log('attribution fires on next /api/cron/burn-attribution tick (every 4h).');
