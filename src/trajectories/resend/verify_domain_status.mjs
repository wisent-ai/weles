// resend_verify_domain_status — email-domain health + auto-repair (no browser; Resend API + Skarbiec state).
//
// Runs on a whitelisted mac-mini runner (enqueued by wisent-compute cron). It:
//   0. IP GATE — refuses to run unless the runner's egress IP is whitelisted.
//   1. re-verifies any Resend domain whose status drifted to `failed` (the stale-status
//      bug that silently kills receiving — a re-verify trigger flips it back).
//   2. CONFIRMS REAL RECEIVING (status labels lie): one live probe per domain from a
//      verified sender, then a single batched inbox poll. Landed = healthy.
//   3. reconciles per-domain status in Skarbiec (active / mx_broken).
//   4. emits a Slack-ready summary and queues delivery through Stado.
//
// Exit: 0 all healthy · 3 a domain needs a human · 4 IP not whitelisted · 2 misconfig.
// Env: WHITELISTED_IPS, SEND_FROM, MESSAGE_FILE,
//      ALLOW_ANY_IP=1 (test escape hatch).

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { promises as dnsp } from 'node:dns';
import { enqueueWelesAction } from '../../_shared/stado-action-queue.mjs';
import { writeDomainStatus } from '../_shared/skarbiec_accounts.mjs';

const RK = process.env.RESEND_API_KEY || '';
const RRK = process.env.RESEND_RECEIVING_API_KEY || RK;
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
  if (!RK) { console.error('missing RESEND_API_KEY'); process.exit(2); }
  await ipGate();

  const domains = (((await rj('GET', '/domains?limit=100')).body) || {}).data || [];
  const targets = domains.filter(d => !SKIP.has(d.name));
  const out = { checked: targets.length, healthy: [], repaired: [], broken: [] };

  // 1. re-verify any stale domains
  for (const d of targets) {
    if (d.status !== 'verified') { console.log(`[verify] ${d.name} status=${d.status} -> re-verifying`); if (await reverify(d.id)) { d.status = 'verified'; d._repaired = true; } }
  }
  // 2. receiving probe. Resend rate-limits sends (~2/s); firing all probes in a
  // tight loop trips 429s, and a DROPPED SEND looks exactly like a broken domain.
  // So throttle (~2/s) and retry 429s before giving up on a send.
  const verifiedTargets = targets.filter(x => x.status === 'verified');
  const sendProbe = async (dom, kind) => {
    const marker = `${kind}-${Date.now()}-${Math.floor(Math.random()*1e6)}`;
    for (let attempt = 0; attempt < 4; attempt++) {
      const send = await rj('POST', '/emails', { from: SEND_FROM, to: `${marker}@${dom}`, subject: `domain-health ${marker}`, text: marker });
      if (send.ok) return marker;
      if (send.status === 429) { await sleep(1500); continue; }   // rate-limited: back off + retry
      console.log(`[probe] ${dom} send failed: ${JSON.stringify(send.body).slice(0,80)}`);
      return null;
    }
    console.log(`[probe] ${dom} send failed: rate-limited after retries`);
    return null;
  };
  const probes = {};            // domain -> marker
  for (const d of verifiedTargets) {
    probes[d.name] = await sendProbe(d.name, 'health');
    await sleep(600);           // stay under Resend's ~2 req/s
  }
  const landed = new Set();
  const pollInbox = async (markers, maxIters) => {
    const want = Object.values(markers).filter(Boolean).length;
    for (let i = 0; i < maxIters && [...Object.keys(markers)].filter(d => landed.has(d)).length < want; i++) {
      await sleep(10_000);
      const inbox = ((await rj('GET', '/emails/receiving?limit=50', undefined, RRK)).body || {}).data || [];
      for (const [dom, mk] of Object.entries(markers)) {
        if (!mk || landed.has(dom)) continue;
        if (inbox.some(m => String(m.subject||'').includes(mk) || (Array.isArray(m.to)?m.to:[]).map(x=>typeof x==='string'?x:x.email).join(',').includes(mk))) landed.add(dom);
      }
    }
  };
  await pollInbox(probes, 12);
  // CONFIRMATION re-probe: re-send to EVERY verified domain not yet landed —
  // covers BOTH a slow first delivery and a rate-limited first send — then poll
  // again. Only domains that miss this second pass too get flagged broken, so a
  // healthy domain is never flipped to mx_broken (and alerted) on one bad run.
  const suspects = verifiedTargets.map((d) => d.name).filter((dom) => !landed.has(dom));
  if (suspects.length) {
    console.log(`[probe] re-confirming ${suspects.length} not-yet-landed: ${suspects.join(', ')}`);
    const reprobes = {};
    for (const dom of suspects) { reprobes[dom] = await sendProbe(dom, 'recheck'); await sleep(600); }
    await pollInbox(reprobes, 12);
  }
  // 3. classify + reconcile (diagnose the cause for anything broken)
  for (const d of targets) {
    const healthy = landed.has(d.name);
    const rec = { domain: d.name, status: d.status, receives: landed.has(d.name), repaired: !!d._repaired };
    if (healthy) { out.healthy.push(rec); if (d._repaired) out.repaired.push(rec); await updateRow(d.name, 'active'); }
    else {
      rec.diagnosis = await diagnoseBroken(d.name);
      out.broken.push(rec); await updateRow(d.name, 'mx_broken');
    }
    console.log(`[verify] ${d.name}: status=${d.status} receives=${rec.receives} -> ${healthy ? 'HEALTHY' : 'BROKEN'}${rec.diagnosis ? ` [${rec.diagnosis.code}]` : ''}${d._repaired ? ' (repaired)' : ''}`);
  }
  // 4. Slack message
  const lines = [`*Resend email-domain health* — ${out.healthy.length}/${out.checked} healthy`];
  if (out.healthy.length) lines.push(`:white_check_mark: healthy: ${out.healthy.map(r => r.domain).sort().join(', ')}`);
  if (out.repaired.length) lines.push(`:wrench: auto-repaired (re-verified): ${out.repaired.map(r => r.domain).join(', ')}`);
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
    const jobId = enqueueWelesAction({
      action: 'slack_post_message',
      params: { message: msg, message_file: MESSAGE_FILE, slack_channel: SLACK_CHANNEL },
    });
    console.log(`[slack] submitted slack_post_message to Stado (channel=${SLACK_CHANNEL}) job=${jobId}`);
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
