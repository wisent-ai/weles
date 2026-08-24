// Probe whether a proxy provider's upstream actually accepts our auth.
//
// Why this exists: balance trajectories scrape the dashboard (e.g. "you have
// $8.75 left"), but the upstream proxy gateway can independently refuse the
// CONNECT — KYC pending, traffic limit reached, account suspended, fraud
// flag — and dashboard balance has no relation to that. Pingproxies showed
// $8.75 in dashboard but returned 407 on every CONNECT for weeks while KYC
// was pending. We were storing meaningless numbers.
//
// This helper does a real CONNECT through the upstream and returns the auth
// status. patchEffectiveBalance() in google_sso.mjs uses it to override the
// stored balance to 0 when the upstream is unusable, so the daily cron makes
// auto-topup decisions on EFFECTIVE balance, not aspirational balance.

import net from 'node:net';
import { findProxyByDisplayName, persistProxyContext } from '../skarbiec_proxies.mjs';

// CONNECT a known endpoint (api.ipify.org:443) through the proxy and report
// the proxy's response code. 200 = auth accepted; 407 = auth rejected (no
// money / KYC / suspended); other = network/upstream issue.
export async function probeProxyAuth({ host, port, username, password, timeoutMs = 10_000 }) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port, timeout: timeoutMs });
    let done = false;
    const finish = (result) => { if (done) return; done = true; try { sock.destroy(); } catch {} resolve(result); };
    sock.on('error', (e) => finish({ ok: false, code: 0, error: `connect: ${e.code ?? e.message}` }));
    sock.on('timeout', () => finish({ ok: false, code: 0, error: 'timeout' }));
    sock.on('connect', () => {
      const auth = Buffer.from(`${username}:${password}`).toString('base64');
      const req = `CONNECT api.ipify.org:443 HTTP/1.1\r\nHost: api.ipify.org:443\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`;
      sock.write(req);
    });
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      if (buf.includes('\r\n\r\n')) {
        const m = buf.match(/^HTTP\/\d\.\d (\d{3}) (.*)\r\n/);
        if (m) {
          const code = Number(m[1]);
          const reason = m[2].trim();
          finish({ ok: code === 200, code, reason });
        }
      }
    });
  });
}

// Resolve upstream proxy credentials and endpoint from its exact Skarbiec item.
export async function probeCredsFor(displayName) {
  const proxy = findProxyByDisplayName(displayName);
  if (!proxy?.host || !proxy?.port || !proxy?.username || !proxy?.password) return null;
  let username = proxy.username;
  if (displayName === 'Bright Data') {
    const zone = proxy.context.zone ?? proxy.metadata.zone;
    if (zone && !username.startsWith('brd-customer-')) {
      username = `brd-customer-${username}-zone-${zone}`;
    }
  }
  return {
    id: proxy.id,
    host: proxy.host,
    port: proxy.port,
    username,
    password: proxy.password,
  };
}

// Persist BOTH dashboard balance and probe outcome. If probe returned 407
// (auth rejected upstream), override balance_usd to 0 and append a note so
// the operator can see the discrepancy. The cron's topup decision is then
// driven by EFFECTIVE balance (= 0 when unusable), not dashboard claim.
export async function patchEffectiveBalance(displayName, dashboardBalance) {

  const creds = await probeCredsFor(displayName);
  let probe = null;
  if (creds) probe = await probeProxyAuth(creds);

  // probe-fail (407 / non-200 / network): write 0 + note. probe-OK or
  // no-probe: write whatever the dashboard scraped, including 0 — every
  // balance trajectory now forensic-dumps on regex miss and throws before
  // calling this helper, so dashboardBalance==null cannot reach here. A
  // scraped 0 is a real "depleted" reading and must be trusted; the prior
  // 2026-05-08 "preserve prior balance on probe-OK + dashboard-zero" branch
  // perpetuated $0 forever once a row was ever 0.
  let effective = dashboardBalance;
  let note = null;
  if (probe && !probe.ok) {
    effective = 0;
    if (probe.code === 407) note = `Effective balance $0: upstream returned 407 ${probe.reason ?? ''}`.trim();
    else if (probe.code === 0) note = `Effective balance $0: probe ${probe.error}`;
    else note = `Effective balance $0: upstream returned ${probe.code} ${probe.reason ?? ''}`.trim();
  }

  const now = new Date().toISOString();
  const patch = {
    balance_usd: effective,
    last_balance_check: now,
    updated_at: now,
  };
  if (probe) {
    patch.last_probe = {
      at: now,
      ok: probe.ok,
      code: probe.code,
      ...(probe.reason ? { reason: probe.reason } : {}),
      ...(probe.error ? { error: probe.error } : {}),
    };
  }
  if (note) patch.notes = note;
  if (!creds?.id) return false;
  const persisted = persistProxyContext(creds.id, patch);
  console.log(`[probe] ${displayName} dashboard=$${dashboardBalance} probe=${probe ? `${probe.code} ${probe.ok ? 'OK' : (probe.error ?? probe.reason)}` : 'no-creds'} effective=$${effective}`);
  return persisted;
}
