#!/usr/bin/env node
// Paired-comparison isolation test queuer.
//
// Replaces hand-crafted curl POSTs for queueing paired comparisons. Provider
// credentials are resolved from exact scoped Skarbiec items.
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
import { readScopedProxy, readScopedSecret } from '../../_shared/scoped-secrets.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WELES_ROOT = join(__dirname, '..', '..', '..');
const ENV_PATH = join(WELES_ROOT, '.env');
if (!existsSync(ENV_PATH)) { console.error(`weles/.env not found at ${ENV_PATH}`); process.exit(2); }
const ENV = Object.fromEntries(readFileSync(ENV_PATH, 'utf8').split('\n').filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));

const SUPABASE_URL = process.env.WELES_SUPABASE_URL || ENV.WELES_SUPABASE_URL || ENV.WELES_SUPABASE_URL;
const SUPABASE_KEY = process.env.WELES_SUPABASE_SERVICE_ROLE_KEY || ENV.WELES_SUPABASE_SERVICE_ROLE_KEY;
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
    const creds = readScopedProxy('oxylabsDedicatedIsp');
    const host = readScopedSecret('oxylabsDedicatedIsp', 'host');
    const ports = readScopedSecret('oxylabsDedicatedIsp', 'ports').split(',');
    return ports.filter(Boolean).map((port) => `http://${encodeURIComponent(creds.username)}:${encodeURIComponent(creds.password)}@${host}:${port.trim()}`);
  }
  if (name === 'oxylabs-residential') {
    // Counterfactual residential IP class against Decodo/Oxylabs Comcast static
    // ISP pools. pr.oxylabs.io:7777 with sticky sessid. The pool rotates IPs by
    // design; the sessid+sesstime hint pins exits within a 30-min window per
    // session, so each --reps invocation produces N distinct exits across the
    // pool — exactly the IP-class variation needed to attribute static-ISP
    // burns against a residential counterfactual.
    const creds = readScopedProxy('oxylabsResidential');
    const user = creds.username;
    const pass = creds.password;
    const sessions = parseInt(process.env.PAIRED_RESIDENTIAL_SESSIONS || '1', Number('10'));
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
  else if (host === readScopedSecret('oxylabsDedicatedIsp', 'host')) {
    const creds = readScopedProxy('oxylabsDedicatedIsp');
    user = creds.username;
    pass = creds.password;
  }
  else { console.error(`unknown proxy host: ${host}`); process.exit(2); }
  const proxy = `http://${user}:${pass}@${host}:${port}`;
  plan = domains.map(domain => ({ proxy, domain }));
}

const reps = parseInt(args.reps || '1', 10);
let expanded = [];
for (let i = 0; i < reps; i++) for (const p of plan) expanded.push(p);

if (args.vary === 'ip' && args['no-smart-plan'] !== 'true') {
  const { repinPlanDomain } = await import('./smart_plan.mjs');
  const freshness = parseInt(args['freshness-hours'] || '168', 10);
  const sp = await repinPlanDomain({ supabaseUrl: SUPABASE_URL, supabaseKey: SUPABASE_KEY, action: args.action, plan, holdDomain: args['hold-domain'], freshnessHours: freshness });
  if (sp.changed) {
    console.log(`[paired] smart-plan: re-pinning hold-domain '${args['hold-domain']}' -> '${sp.holdDomain}' (${sp.coverageCount}/${sp.totalProxies} planned proxies have existing failure at this domain)`);
    plan = sp.plan;
    expanded = [];
    for (let i = 0; i < reps; i++) for (const p of plan) expanded.push(p);
  }
}

console.log(`[paired] planning ${expanded.length} rows: platform=${args.platform} action=${args.action} vary=${args.vary}`);
const TAG_NS = args.tag || `paired_${args.vary}_${Date.now()}`;
const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' };

// Cache check: matcher reads 168h of history, so any prior terminal-state
// row with same (action, proxy_url_override, force_email_domain) is reusable
// — no need to re-run. Override window with --freshness-hours; force re-run
// with --no-cache.
const FRESHNESS_HOURS = parseInt(args['freshness-hours'] || '168', 10);
const sinceIso = new Date(Date.now() - FRESHNESS_HOURS * 3600 * 1000).toISOString();
async function findFreshRow(action, proxy, domain) {
  if (args['no-cache'] === 'true') return null;
  const qp = new URLSearchParams();
  qp.set('select', 'id,status,completed_at');
  qp.set('action', `eq.${action}`);
  qp.set('params->>proxy_url_override', `eq.${proxy}`);
  qp.set('params->>force_email_domain', `eq.${domain}`);
  qp.set('status', 'in.(completed,failed)');
  qp.set('completed_at', `gte.${sinceIso}`);
  qp.set('order', 'completed_at.desc');
  qp.set('limit', '1');
  const res = await fetch(`${SUPABASE_URL}/rest/v1/account_action_logs?${qp}`, { headers });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0] || null;
}

const ids = [];
let queued = 0, reused = 0;
for (const p of expanded) {
  const port = new URL(p.proxy).port;
  const cached = await findFreshRow(args.action, p.proxy, p.domain);
  if (cached) {
    ids.push(cached.id);
    reused++;
    console.log(`  reuse  ${cached.id.slice(0, 8)} (${cached.status}, ${cached.completed_at?.slice(0, 16)}) port=${port} domain=${p.domain}`);
    continue;
  }
  const tag = `${TAG_NS}_${port}_${p.domain}`;
  const body = { account_id: ACCOUNT_ID, platform: args.platform, action: args.action, status: 'queued', scheduled_at: new Date().toISOString(), params: { source: tag, proxy_url_override: p.proxy, force_email_domain: p.domain } };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/account_action_logs`, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) { console.error(`row INSERT failed http=${res.status}: ${(await res.text()).slice(0, 200)}`); process.exit(3); }
  const row = (await res.json())[0];
  ids.push(row.id);
  queued++;
  console.log(`  queued ${row.id.slice(0, 8)} port=${port} domain=${p.domain}`);
}
console.log(`\n[paired] queued=${queued} reused=${reused} (freshness=${FRESHNESS_HOURS}h)`);
console.log(`tag namespace: ${TAG_NS}`);

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
    const chromeAction = `chrome_baseline_${args.platform}_register`;
    const allProxies = [...new Set(expanded.map(p => p.proxy))];
    const uniqueProxies = [];
    let chromeReused = 0;
    for (const proxy of allProxies) {
      const baseDomain = args.vary === 'ip' ? args['hold-domain'] : (plan.find(p => p.proxy === proxy)?.domain ?? '');
      const cached = await findFreshRow(chromeAction, proxy, baseDomain);
      if (cached) {
        chromeReused++;
        console.log(`  reuse  chrome ${cached.id.slice(0, 8)} (${cached.status}) port=${new URL(proxy).port}`);
      } else {
        uniqueProxies.push(proxy);
      }
    }
    console.log(`\n[paired] chrome baselines: reused=${chromeReused} to_capture=${uniqueProxies.length}`);
    const captures = uniqueProxies.map(proxy => new Promise((resolve) => {
      const env = { ...process.env, PLATFORM: args.platform, TARGET_URL, PROXY_URL: proxy, CHROME_BIN: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', CAPTURE_DURATION_MS: '30000', WELES_FIRST_RUN: '1' };
      const child = spawn('node', [join(WELES_ROOT, 'scripts', 'debug', 'instrument_chrome.mjs')], { env, stdio: 'pipe' });
      let outPath = '';
      child.stdout.on('data', d => { const s = d.toString(); const m = s.match(/output -> (\S+\.json)/); if (m) outPath = m[1]; });
      child.on('close', () => resolve({ proxy, port: new URL(proxy).port, dumpPath: outPath }));
    }));
    const { execSync } = await import('node:child_process');
    const results = await Promise.all(captures);
    for (const r of results) {
      if (!r.dumpPath) { console.log(`  chrome ${r.port}: capture had no dump path (likely chrome failed to launch)`); continue; }
      let protechts = 0;
      try { protechts = (readFileSync(r.dumpPath, 'utf8').match(/protechts\.net/g) || []).length; } catch (e) { console.log(`  chrome ${r.port}: read err ${e.message?.slice(0, 60)}`); continue; }
      // Probe exit_ip through the proxy so chrome rows are directly pairable
      // with weles rows (matcher's rowExitIp reads result.session.exit_ip).
      let exitIp = null;
      try {
        const out = execSync(`curl -s --max-time 10 --proxy '${r.proxy}' https://api.ipify.org`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        if (/^\d+\.\d+\.\d+\.\d+$/.test(out)) exitIp = out;
      } catch (_) { /* exitIp stays null */ }
      const baseDomain = args.vary === 'ip' ? args['hold-domain'] : (plan.find(p => p.proxy === r.proxy)?.domain ?? '');
      const status = protechts > 0 ? 'failed' : 'completed';
      const body = { account_id: ACCOUNT_ID, platform: args.platform, action: `chrome_baseline_${args.platform}_register`, status, scheduled_at: new Date().toISOString(), completed_at: new Date().toISOString(), result: { session: { provider: 'chrome', proxy_host: new URL(r.proxy).hostname, proxy_port: r.port, exit_ip: exitIp }, ban_signal: { healthy: protechts === 0, signal: protechts > 0 ? 'perimeterx_loaded' : 'clean', details: { protechts_count: protechts, dump_path: r.dumpPath } }, artifacts: { videos: [], video: null, screenshots: [], dom: [], logs: [r.dumpPath] } }, params: { source: `${TAG_NS}_chrome_${r.port}`, proxy_url_override: r.proxy, force_email_domain: baseDomain, browser: 'chrome' } };
      const ins = await fetch(`${SUPABASE_URL}/rest/v1/account_action_logs`, { method: 'POST', headers, body: JSON.stringify(body) });
      if (!ins.ok) { console.log(`  chrome ${r.port}: INSERT failed http=${ins.status}`); continue; }
      const row = (await ins.json())[0];
      console.log(`  chrome ${r.port}: protechts=${protechts} exit_ip=${exitIp ?? 'unknown'} status=${status} row=${row.id.slice(0, 8)}`);
    }
  }
}

console.log('\nquery:');
console.log(`  curl "${SUPABASE_URL}/rest/v1/account_action_logs?params->>source=like.${TAG_NS}%25&select=status,action,params->>force_email_domain,result->session->>exit_ip,result->ban_signal->signal"`);

// Auto-wait for queued rows to reach terminal status, then trigger
// burn-attribution. Closes the gap so the runner exits only after the
// matcher has scored this batch. Disable with --no-attribute.
if (args['no-attribute'] !== 'true' && ids.length > 0) {
  const CONTENT_PLATFORM_URL = process.env.CONTENT_PLATFORM_URL || ENV.CONTENT_PLATFORM_URL || 'https://content.wisent.ai';
  const POLL_MS = parseInt(args['poll-ms'] || '15000', 10);
  const idList = ids.join(',');
  console.log(`\n[paired] polling ${ids.length} rows to terminal status (every ${POLL_MS / 1000}s)`);
  let lastSummary = '';
  while (true) {
    const pollRes = await fetch(`${SUPABASE_URL}/rest/v1/account_action_logs?id=in.(${idList})&select=id,status`, { headers });
    if (!pollRes.ok) { console.log(`  poll err http=${pollRes.status}: ${(await pollRes.text()).slice(0, 200)}`); break; }
    const pollRows = await pollRes.json();
    const open = pollRows.filter(r => r.status === 'queued' || r.status === 'running');
    const completed = pollRows.filter(r => r.status === 'completed').length;
    const failed = pollRows.filter(r => r.status === 'failed').length;
    const summary = `open=${open.length} completed=${completed} failed=${failed}`;
    if (summary !== lastSummary) { console.log(`  [poll] ${summary}`); lastSummary = summary; }
    if (open.length === 0) break;
    await new Promise(r => setTimeout(r, POLL_MS)); // allow-raw-playwright: REST poll loop, no browser/page context
  }
  console.log(`[paired] firing ${CONTENT_PLATFORM_URL}/api/cron/burn-attribution (manual-trigger bypass)`);
  const attribRes = await fetch(`${CONTENT_PLATFORM_URL}/api/cron/burn-attribution`, { method: 'POST', headers: { 'x-cron-secret': 'manual-trigger' } });
  const attribText = await attribRes.text();
  console.log(`[paired] attribution http=${attribRes.status} body=${attribText.slice(0, 400)}`);

  // Per-IP verdict report. Re-fetches the participating rows + the live
  // burned_proxies table, groups by exit_ip (falling back to proxy host:port
  // when ipify is null), and prints BURNED/HEALTHY plus the matcher's
  // attribution stamp if present.
  const finalRowsRes = await fetch(`${SUPABASE_URL}/rest/v1/account_action_logs?id=in.(${idList})&select=id,action,status,params,result`, { headers });
  const finalRows = finalRowsRes.ok ? await finalRowsRes.json() : [];
  const burnedRes = await fetch(`${SUPABASE_URL}/rest/v1/system_settings?key=eq.burned_proxies&select=value`, { headers });
  const burnedHosts = burnedRes.ok ? ((await burnedRes.json())[0]?.value?.hosts ?? {}) : {};
  const byIp = {};
  for (const row of finalRows) {
    const u = new URL(row.params?.proxy_url_override ?? 'http://x');
    const ip = row.result?.session?.exit_ip ?? `${u.hostname}:${u.port}`;
    if (!byIp[ip]) byIp[ip] = [];
    byIp[ip].push(row);
  }
  console.log('\n[paired] VERDICT (per exit IP)');
  console.log('='.repeat(72));
  for (const [ip, rows] of Object.entries(byIp)) {
    const burned = ip in burnedHosts;
    const passes = rows.filter(r => r.status === 'completed').length;
    const fails = rows.filter(r => r.status === 'failed').length;
    const attributions = rows.map(r => r.result?.attribution).filter(Boolean);
    const verdict = burned ? 'BURNED' : (passes > 0 && fails === 0 ? 'HEALTHY' : 'UNATTRIBUTED');
    console.log(`  ${ip}: ${verdict}  pass=${passes} fail=${fails} rows=${rows.length}`);
    if (burned) {
      const e = burnedHosts[ip];
      console.log(`    burned_at=${e.last_burned_at} signals=${e.signals.join(',')} platforms=${e.platforms.join(',')}`);
    }
    for (const a of attributions) console.log(`    attributed: factor=${a.attributed_factor} value=${a.attributed_value} reason=${a.reason}`);
  }
} else {
  console.log('[paired] auto-attribution skipped (--no-attribute)');
}
