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
import tls from 'node:tls';

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

// Resolve upstream proxy creds from env vars per provider.
export function probeCredsFor(displayName) {
  const e = process.env;
  switch (displayName) {
    case 'Bright Data':
      if (!e.BRIGHTDATA_USERNAME || !e.BRIGHTDATA_PASSWORD) return null;
      return {
        host: 'brd.superproxy.io',
        port: 22225,
        username: e.BRIGHTDATA_USERNAME.startsWith('brd-customer-')
          ? e.BRIGHTDATA_USERNAME
          : `brd-customer-${e.BRIGHTDATA_USERNAME}-zone-${e.BRIGHTDATA_ZONE ?? 'isp'}`,
        password: e.BRIGHTDATA_PASSWORD,
      };
    case 'PacketStream':
      return e.PACKETSTREAM_USERNAME && e.PACKETSTREAM_PASSWORD
        ? { host: 'proxy.packetstream.io', port: 31112, username: e.PACKETSTREAM_USERNAME, password: e.PACKETSTREAM_PASSWORD }
        : null;
    case 'Oxylabs Residential':
    case 'Oxylabs Mobile':
      return e.OXYLABS_USERNAME && e.OXYLABS_PASSWORD
        ? { host: 'pr.oxylabs.io', port: 7777, username: e.OXYLABS_USERNAME, password: e.OXYLABS_PASSWORD }
        : null;
    case 'IPRoyal Residential':
    case 'IPRoyal Mobile':
      return e.IPROYAL_USERNAME && e.IPROYAL_PASSWORD
        ? { host: 'geo.iproyal.com', port: 12321, username: e.IPROYAL_USERNAME, password: e.IPROYAL_PASSWORD }
        : null;
    case 'Pingproxies':
      return e.PINGPROXIES_USERNAME && e.PINGPROXIES_PASSWORD
        ? { host: 'residential.pingproxies.com', port: 8000, username: e.PINGPROXIES_USERNAME, password: e.PINGPROXIES_PASSWORD }
        : null;
    default:
      return null;
  }
}

// Persist BOTH dashboard balance and probe outcome. If probe returned 407
// (auth rejected upstream), override balance_usd to 0 and append a note so
// the operator can see the discrepancy. The cron's topup decision is then
// driven by EFFECTIVE balance (= 0 when unusable), not dashboard claim.
export async function patchEffectiveBalance(displayName, dashboardBalance) {
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!supabaseUrl || !key) return false;

  const creds = probeCredsFor(displayName);
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

  const update = {
    last_balance_check: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    balance_usd: effective,
  };
  // Read-modify-write notes so we don't clobber procurement context the
  // operator may have written. Only update notes when we just observed a
  // probe failure (positive signal) — successful probe leaves notes alone.
  if (note) {
    const r0 = await fetch(`${supabaseUrl}/rest/v1/service_credentials?display_name=eq.${encodeURIComponent(displayName)}&select=notes`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (r0.ok) {
      const rows = await r0.json();
      const existing = (rows[0]?.notes ?? '').replace(/(\s|^)Effective balance \$0:[^.]*\.?/g, '').trim();
      update.notes = existing ? `${existing} | ${note}` : note;
    }
  }

  const r = await fetch(`${supabaseUrl}/rest/v1/service_credentials?display_name=eq.${encodeURIComponent(displayName)}`, {
    method: 'PATCH',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(update),
  });

  console.log(`[probe] ${displayName} dashboard=$${dashboardBalance} probe=${probe ? `${probe.code} ${probe.ok ? 'OK' : (probe.error ?? probe.reason)}` : 'no-creds'} effective=$${effective}`);
  return r.ok;
}
