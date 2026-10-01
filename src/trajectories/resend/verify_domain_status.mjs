// resend_verify_domain_status — email-domain health + auto-repair (no browser;
// wisent-integrations' Resend actions + Skarbiec state).
//
// Runs on a whitelisted mac-mini runner (enqueued by wisent-compute cron). It:
//   0. IP GATE — refuses to run unless the runner's egress IP is whitelisted.
//   1. re-verifies any Resend domain whose status drifted to `failed` (the stale-status
//      bug that silently kills receiving — a re-verify trigger flips it back) and
//      reads its status once.
//   2. CONFIRMS REAL RECEIVING (status labels lie): reads the inbox once for the
//      probe each domain was sent on the previous run (marker kept in Skarbiec);
//      landed = healthy, not landed = broken, never probed = unprobed. Then sends
//      this run's probe to every verified domain and records its marker, so mail
//      delivery time is the gap between runs — no run waits for mail.
//   3. reconciles per-domain status in Skarbiec (active / mx_broken).
//   4. emits a Slack-ready summary and queues delivery through Stado.
//
// The Resend key stays in wisent-integrations; this journey holds only Weles'
// integration bearer (WELES_STADO_INTEGRATION_TOKEN, STADO_INTEGRATION_API_URL).
//
// Exit: 0 all healthy · 3 a domain needs a human · 4 IP not whitelisted · 2 misconfig.
// Env: WHITELISTED_IPS, MESSAGE_FILE, ALLOW_ANY_IP=1 (test escape hatch).

import { runOutputPath } from '#run-output';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { promises as dnsp } from 'node:dns';
import { submitWelesRun } from '../../../dist/worker/run-submit/index.js';
import { readDomainProbes, writeDomainProbe, writeDomainStatus } from '../_shared/skarbiec/accounts.mjs';
import { integrationAction, integrationsConfigured } from '../../_shared/integrations.mjs';
import { listReceived } from '../../_shared/resend-receiving.mjs';

// Absolute so the chained slack_post_message job (separate process) can read it.
const MESSAGE_FILE = resolve(process.env.MESSAGE_FILE || runOutputPath('resend-domains-status.txt'));
const SLACK_CHANNEL = process.env.SLACK_CHANNEL || 'jakub';   // who Swiatowid messages
const SKIP = new Set(['wisent.com','agents.trade.wisent.ai','ralph.agents.trade.wisent.ai',
  'testagent.agents.trade.wisent.ai','influencers.wisent.ai','needher.ai','macchiavelli.ai']);

// ---- 0. IP whitelist gate ---------------------------------------------------
async function egressIp() {
  for (const u of ['https://api.ipify.org', 'https://ifconfig.me/ip', 'https://ip.oxylabs.io/ip']) {
    try { const r = await fetch(u); if (r.ok) return (await r.text()).trim(); } catch {}
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

function domains(action, body) {
  return integrationAction('email-domains', action, body);
}
async function reverify(id) {
  await domains('resend.domain.verify', { id });
  const d = await domains('resend.domain.get', { id });
  return d.status === 'verified';
}
function updateRow(domain, status) {
  writeDomainStatus(domain, status);
}

// Why is a domain not receiving? A live DNS lookup names the actual cause so the
// alert is actionable instead of a generic "broken". The big one: a registrar
// WHOIS/registrant-contact-verification hold repoints the nameservers to
// failed-whois-verification.* / verify-contact-details.* and suspends DNS — no
// API can clear it; a human must verify the registrant contact at the registrar.
async function diagnoseBroken(domain) {
  let ns = [];
  try { ns = await dnsp.resolveNs(domain); }
  catch (e) {
    if (['ENOTFOUND', 'NXDOMAIN', 'ENODATA', 'SERVFAIL'].includes(e.code))
      return { code: 'dns_unresolved', label: 'domain does not resolve (NXDOMAIN / no nameservers)' };
  }
  if (ns.some((h) => /verify|whois/i.test(h)))
    return { code: 'whois_hold', label: `WHOIS/registrant-contact verification hold — registrar suspended DNS (ns: ${ns.join(', ')}); a human must verify the registrant contact at the registrar to restore` };
  let mx = [];
  try { mx = await dnsp.resolveMx(domain); } catch {}
  if (!mx.length)
    return { code: 'no_mx', label: 'no inbound MX record — add MX 10 inbound-smtp.us-east-1.amazonaws.com' };
  return { code: 'mx_present_no_receive', label: `MX present (${mx.map((m) => m.exchange).join(', ')}) but probe mail not landing — SES routing / propagation` };
}

const main = async () => {
  if (!integrationsConfigured()) { console.error('missing STADO_INTEGRATION_API_URL or WELES_STADO_INTEGRATION_TOKEN'); process.exit(2); }
  await ipGate();

  const listed = (await domains('resend.domain.list', {})).data || [];
  const targets = listed.filter(d => !SKIP.has(d.name));
  const out = { checked: targets.length, healthy: [], repaired: [], broken: [] };

  // 1. re-verify any stale domains
  for (const d of targets) {
    if (d.status !== 'verified') { console.log(`[verify] ${d.name} status=${d.status} -> re-verifying`); if (await reverify(d.id)) { d.status = 'verified'; d._repaired = true; } }
  }
  // 2a. judge the probes the previous run sent: one inbox read.
  const previous = readDomainProbes();
  const inbox = (await listReceived(100)).data || [];
  const landed = new Set(Object.entries(previous)
    .filter(([, probe]) => inbox.some((m) => String(m.subject || '').includes(probe.marker)
      || (Array.isArray(m.to) ? m.to : []).map((x) => typeof x === 'string' ? x : x.email).join(',').includes(probe.marker)))
    .map(([dom]) => dom));
  // 2b. send this run's probe to every verified domain; a refused send is
  // reported by name and that domain stays without a fresh probe.
  const refused = {};
  for (const d of targets.filter((x) => x.status === 'verified')) {
    try {
      writeDomainProbe(d.name, (await domains('resend.domain.probe', { domain: d.name })).marker);
    } catch (error) {
      refused[d.name] = error.message;
      console.log(`[probe] ${d.name} send refused: ${error.message}`);
    }
  }
  // 3. classify + reconcile (diagnose the cause for anything broken)
  out.unprobed = [];
  for (const d of targets) {
    const rec = { domain: d.name, status: d.status, receives: landed.has(d.name), repaired: !!d._repaired, probe_refused: refused[d.name] ?? null };
    if (!previous[d.name]) {
      out.unprobed.push(rec);
      console.log(`[verify] ${d.name}: no probe from an earlier run yet -> UNPROBED`);
      continue;
    }
    if (rec.receives) { out.healthy.push(rec); if (d._repaired) out.repaired.push(rec); await updateRow(d.name, 'active'); }
    else {
      rec.diagnosis = await diagnoseBroken(d.name);
      out.broken.push(rec); await updateRow(d.name, 'mx_broken');
    }
    console.log(`[verify] ${d.name}: status=${d.status} receives=${rec.receives} -> ${rec.receives ? 'HEALTHY' : 'BROKEN'}${rec.diagnosis ? ` [${rec.diagnosis.code}]` : ''}${d._repaired ? ' (repaired)' : ''}`);
  }
  // 4. Slack message
  const lines = [`*Resend email-domain health* — ${out.healthy.length}/${out.checked} healthy`];
  if (out.healthy.length) lines.push(`:white_check_mark: healthy: ${out.healthy.map(r => r.domain).sort().join(', ')}`);
  if (out.repaired.length) lines.push(`:wrench: auto-repaired (re-verified): ${out.repaired.map(r => r.domain).join(', ')}`);
  if (out.unprobed.length) lines.push(`:hourglass: first probe sent, judged on the next run: ${out.unprobed.map(r => r.domain).sort().join(', ')}`);
  if (out.broken.length) {
    const SHORT = {
      whois_hold: 'WHOIS/registrant-contact verification hold — verify the registrant contact at the registrar (no API fix)',
      no_mx: 'missing inbound MX record (add MX → inbound-smtp.us-east-1.amazonaws.com)',
      mx_present_no_receive: 'MX present but mail not landing (SES routing / propagation)',
      dns_unresolved: 'domain does not resolve (NXDOMAIN)',
    };
    lines.push(':rotating_light: NEEDS A HUMAN:');
    for (const r of out.broken) lines.push(`   • ${r.domain} — ${SHORT[r.diagnosis?.code] || r.diagnosis?.label || 'not receiving'}`);
  } else if (!out.healthy.length) lines.push(':grey_question: no receiving domains configured');
  const msg = lines.join('\n');
  try { mkdirSync(dirname(MESSAGE_FILE), { recursive: true }); writeFileSync(MESSAGE_FILE, msg + '\n'); } catch {}

  // 5. Swiatowid alert — when a domain needs a human, enqueue a slack_post_message
  // job (the worker runs the browser Slack post). Messages SLACK_CHANNEL ('jakub').
  // SLACK_NOTIFY_ALWAYS=1 posts even when all-healthy (e.g. a daily heartbeat).
  const shouldNotify = out.broken.length > 0 || process.env.SLACK_NOTIFY_ALWAYS === '1';
  if (shouldNotify) {
    const runId = await submitWelesRun({
      action: 'slack_post_message',
      params: { message: msg, message_file: MESSAGE_FILE, slack_channel: SLACK_CHANNEL },
    });
    console.log(`[slack] started slack_post_message as Weles run ${runId} (channel=${SLACK_CHANNEL})`);
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
