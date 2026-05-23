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
  throw new Error(`unknown pool: ${name} (supported: decodo, oxylabs-dedicated-isp)`);
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
console.log('query:');
console.log(`  curl "${SUPABASE_URL}/rest/v1/account_action_logs?params->>source=like.${TAG_NS}%25&select=status,params->>force_email_domain,result->session->>exit_ip,result->ban_signal->signal"`);
console.log('attribution fires on next /api/cron/burn-attribution tick (every 4h).');
