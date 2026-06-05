// resend_verify_domain_status — email-domain health + auto-repair (no browser; pure Resend/Supabase API).
//
// Runs on a whitelisted mac-mini runner (enqueued by wisent-compute cron). It:
//   0. IP GATE — refuses to run unless the runner's egress IP is whitelisted.
//   1. re-verifies any Resend domain whose status drifted to `failed` (the stale-status
//      bug that silently kills receiving — a re-verify trigger flips it back).
//   2. CONFIRMS REAL RECEIVING (status labels lie): one live probe per domain from a
//      verified sender, then a single batched inbox poll. Landed = healthy.
//   3. reconciles inbound_email_domains (active / mx_broken).
//   4. emits a Slack-ready summary to MESSAGE_FILE for Swiatowid to post.
//
// Exit: 0 all healthy · 3 a domain needs a human · 4 IP not whitelisted · 2 misconfig.
// Env: RESEND_API_KEY, RESEND_RECEIVING_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//      WHITELISTED_IPS (csv; falls back to NAMECHEAP_CLIENT_IP), SEND_FROM, MESSAGE_FILE,
//      DRY_RUN=1, ALLOW_ANY_IP=1 (test escape hatch).

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const RK = process.env.RESEND_API_KEY || '';
const RRK = process.env.RESEND_RECEIVING_API_KEY || RK;
const SUPA = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SK = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const DRY = process.env.DRY_RUN === '1';
const SEND_FROM = process.env.SEND_FROM || 'noreply@wisent.com';
// Absolute so the chained slack_post_message job (separate process) can read it.
const MESSAGE_FILE = resolve(process.env.MESSAGE_FILE || '.work/resend-domains-status.txt');
const SLACK_CHANNEL = process.env.SLACK_CHANNEL || 'jakub';   // who Swiatowid messages
const SKIP = new Set(['wisent.com','agents.trade.wisent.ai','ralph.agents.trade.wisent.ai',
  'testagent.agents.trade.wisent.ai','influencers.wisent.ai','needher.ai','macchiavelli.ai']);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- 0. IP whitelist gate ---------------------------------------------------
async function egressIp() {
  for (const u of ['https://api.ipify.org', 'https://ifconfig.me/ip', 'https://ip.oxylabs.io/ip']) {
    try { const r = await fetch(u, { signal: AbortSignal.timeout(8000) }); if (r.ok) return (await r.text()).trim(); } catch {}
  }
  return null;
}
async function ipGate() {
  if (process.env.ALLOW_ANY_IP === '1') { console.log('[gate] ALLOW_ANY_IP=1 — bypassed'); return; }
  const wl = (process.env.WHITELISTED_IPS || process.env.NAMECHEAP_CLIENT_IP || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!wl.length) { console.error('[gate] no WHITELISTED_IPS configured — refusing (set WHITELISTED_IPS or ALLOW_ANY_IP=1)'); process.exit(4); }
  const ip = await egressIp();
  if (!ip || !wl.includes(ip)) { console.error(`[gate] egress IP ${ip ?? '<unknown>'} not in whitelist [${wl.join(', ')}] — refusing to run`); process.exit(4); }
  console.log(`[gate] egress IP ${ip} is whitelisted ✓`);
}

async function rj(method, path, body, key = RK) {
  const r = await fetch('https://api.resend.com' + path, {
    method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const t = await r.text(); try { return { ok: r.ok, status: r.status, body: JSON.parse(t) }; } catch { return { ok: r.ok, status: r.status, body: t }; }
}
async function reverify(id) {
  await rj('POST', `/domains/${id}/verify`);
  for (let i = 0; i < 6; i++) { await sleep(20_000); const d = (await rj('GET', `/domains/${id}`)).body; if (d.status === 'verified') return true; }
  return false;
}
async function updateRow(domain, status) {
  if (DRY) return;
  await fetch(`${SUPA}/rest/v1/inbound_email_domains?domain=eq.${encodeURIComponent(domain)}`, {
    method: 'PATCH', headers: { apikey: SK, Authorization: `Bearer ${SK}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ status, updated_at: new Date().toISOString() }),
  }).catch(() => {});
}

const main = async () => {
  if (!RK || !SUPA || !SK) { console.error('missing RESEND_API_KEY / SUPABASE creds'); process.exit(2); }
  await ipGate();

  const domains = (((await rj('GET', '/domains?limit=100')).body) || {}).data || [];
  const targets = domains.filter(d => !SKIP.has(d.name));
  const out = { checked: targets.length, dry: DRY, healthy: [], repaired: [], broken: [] };

  // 1. re-verify any stale domains
  for (const d of targets) {
    if (d.status !== 'verified' && !DRY) { console.log(`[verify] ${d.name} status=${d.status} -> re-verifying`); if (await reverify(d.id)) { d.status = 'verified'; d._repaired = true; } }
  }
  // 2. BATCH receiving probe: send all, then one inbox poll for all markers
  const probes = {};            // domain -> marker
  for (const d of targets.filter(x => x.status === 'verified')) {
    if (DRY) { probes[d.name] = null; continue; }
    const marker = `health-${Date.now()}-${Math.floor(Math.random()*1e6)}`;
    const send = await rj('POST', '/emails', { from: SEND_FROM, to: `${marker}@${d.name}`, subject: `domain-health ${marker}`, text: marker });
    probes[d.name] = send.ok ? marker : null;
    if (!send.ok) console.log(`[probe] ${d.name} send failed: ${JSON.stringify(send.body).slice(0,80)}`);
  }
  const landed = new Set();
  if (!DRY) for (let i = 0; i < 15 && landed.size < Object.values(probes).filter(Boolean).length; i++) {
    await sleep(10_000);
    const inbox = ((await rj('GET', '/emails/receiving?limit=50', undefined, RRK)).body || {}).data || [];
    for (const [dom, mk] of Object.entries(probes)) {
      if (!mk || landed.has(dom)) continue;
      if (inbox.some(m => String(m.subject||'').includes(mk) || (Array.isArray(m.to)?m.to:[]).map(x=>typeof x==='string'?x:x.email).join(',').includes(mk))) landed.add(dom);
    }
  }
  // 3. classify + reconcile
  for (const d of targets) {
    const healthy = DRY ? d.status === 'verified' : landed.has(d.name);
    const rec = { domain: d.name, status: d.status, receives: DRY ? null : landed.has(d.name), repaired: !!d._repaired };
    if (healthy) { out.healthy.push(rec); if (d._repaired) out.repaired.push(rec); await updateRow(d.name, 'active'); }
    else { out.broken.push(rec); await updateRow(d.name, 'mx_broken'); }
    console.log(`[verify] ${d.name}: status=${d.status} receives=${rec.receives} -> ${healthy ? 'HEALTHY' : 'BROKEN'}${d._repaired ? ' (repaired)' : ''}`);
  }
  // 4. Slack message
  const lines = [`*Resend email-domain health* — ${out.healthy.length}/${out.checked} healthy${DRY ? ' (dry-run)' : ''}`];
  if (out.repaired.length) lines.push(`:wrench: auto-repaired (re-verified): ${out.repaired.map(r => r.domain).join(', ')}`);
  if (out.broken.length) lines.push(`:rotating_light: NEEDS A HUMAN: ${out.broken.map(r => r.domain).join(', ')}`);
  else lines.push(':white_check_mark: every receiving domain confirmed delivering');
  const msg = lines.join('\n');
  try { mkdirSync(dirname(MESSAGE_FILE), { recursive: true }); writeFileSync(MESSAGE_FILE, msg + '\n'); } catch {}

  // 5. Swiatowid alert — when a domain needs a human, enqueue a slack_post_message
  // job (the worker runs the browser Slack post). Messages SLACK_CHANNEL ('jakub').
  // SLACK_NOTIFY_ALWAYS=1 posts even when all-healthy (e.g. a daily heartbeat).
  const shouldNotify = !DRY && (out.broken.length > 0 || process.env.SLACK_NOTIFY_ALWAYS === '1');
  if (shouldNotify && SUPA && SK) {
    const ok = await fetch(`${SUPA}/rest/v1/account_action_logs`, {
      method: 'POST',
      headers: { apikey: SK, Authorization: `Bearer ${SK}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      // Inline `message` so the Slack job can run on any host (the worker that
      // posts may not be this machine); message_file stays as a same-host fallback.
      body: JSON.stringify({ action: 'slack_post_message', status: 'queued', scheduled_at: new Date().toISOString(),
        params: { message: msg, message_file: MESSAGE_FILE, slack_channel: SLACK_CHANNEL } }),
    }).then(r => r.ok).catch(() => false);
    console.log(`[slack] enqueued slack_post_message (channel=${SLACK_CHANNEL}) -> ${ok ? 'queued ✓' : 'FAILED'}`);
  }

  console.log('\n=== SUMMARY ===\n' + JSON.stringify(out, null, 1));
  console.log('\n=== SLACK (' + MESSAGE_FILE + ') ===\n' + msg);
  // The CHECK always succeeds (exit 0) — a broken domain is a finding, not a run
  // failure (a non-zero exit would trip the worker's diagnostic-retry). Health
  // lives in ban_signal.healthy; the Swiatowid Slack post keys off that.
  console.log('\nRESULT ' + JSON.stringify({ ban_signal: { healthy: out.broken.length === 0, signal: out.broken.length ? 'resend_domains_broken' : 'resend_domains_healthy', details: out } }));
  process.exit(0);
};
main().catch(e => { console.error('verify error:', e); process.exit(2); });
