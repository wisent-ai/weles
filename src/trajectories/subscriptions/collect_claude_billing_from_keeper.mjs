// Collect Claude subscription metadata from a verified Weles keeper UI.
//
// Expected UI:
//   claude.ai -> Settings -> Billing
//   "Max plan"
//   "Your subscription will be canceled on Jul 7, 2026."
//   invoice rows like "Jun 7, 2026  $200  Paid"
//
// This reads UI text from a keeper session that was verified interactively
// first. It does not call provider billing APIs and it does not run a fresh
// login trajectory.

import net from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { upsertSubscription } from '../../lib/service_subscriptions.mjs';

const MONTHS = new Map([
  ['jan', '01'],
  ['january', '01'],
  ['feb', '02'],
  ['february', '02'],
  ['mar', '03'],
  ['march', '03'],
  ['apr', '04'],
  ['april', '04'],
  ['may', '05'],
  ['jun', '06'],
  ['june', '06'],
  ['jul', '07'],
  ['july', '07'],
  ['aug', '08'],
  ['august', '08'],
  ['sep', '09'],
  ['sept', '09'],
  ['september', '09'],
  ['oct', '10'],
  ['october', '10'],
  ['nov', '11'],
  ['november', '11'],
  ['dec', '12'],
  ['december', '12'],
]);

function parseArgs() {
  const out = {
    session: process.env.SESSION || '',
    account: 'controlyourai@gmail.com',
    serviceCredentialId: 'claude_controlyourai',
  };
  for (let i = 2; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    if (arg === '--session') out.session = process.argv[++i] || '';
    else if (arg === '--account') out.account = process.argv[++i] || out.account;
    else if (arg === '--service-credential-id') out.serviceCredentialId = process.argv[++i] || out.serviceCredentialId;
    else throw new Error(`unknown arg: ${arg}`);
  }
  if (!out.session) throw new Error('missing --session or SESSION');
  return out;
}

function action(session, cmd) {
  const sock = join(homedir(), '.weles', 'keeper', session, 'socket');
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(sock);
    let buf = '';
    conn.on('connect', () => conn.write(`${JSON.stringify(cmd)}\n`));
    conn.on('data', (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      conn.end();
      try {
        const parsed = JSON.parse(line);
        if (!parsed.ok) reject(new Error(parsed.error || 'keeper action failed'));
        else resolve(parsed);
      } catch (error) {
        reject(error);
      }
    });
    conn.on('error', reject);
  });
}

async function readText(session) {
  const result = await action(session, {
    action: 'eval',
    js: 'document.body.innerText',
  });
  return String(result.result || '');
}

function parseHumanDate(value) {
  const m = String(value || '').match(/\b([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\b/);
  if (!m) return null;
  const month = MONTHS.get(m[1].toLowerCase());
  if (!month) return null;
  const day = String(Number(m[2])).padStart(2, '0');
  return `${m[3]}-${month}-${day}T00:00:00+00:00`;
}

function parseAmount(value) {
  const m = String(value || '').match(/^\$?(\d+(?:\.\d{2})?)$/);
  return m ? Number(m[1]) : null;
}

function parseInvoices(lines) {
  const invoices = [];
  for (let i = 0; i < lines.length - 2; i += 1) {
    const date = parseHumanDate(lines[i]);
    const amount = parseAmount(lines[i + 1]);
    const status = lines[i + 2]?.trim();
    if (!date || amount == null || !/^(Paid|Refunded|Open|Void)$/i.test(status || '')) continue;
    invoices.push({ date, amount_usd: amount, status });
  }
  return invoices;
}

function extractBilling(text) {
  const lines = text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const billingIdx = lines.findIndex((line) => line === 'Billing');
  const planIdx = lines.findIndex((line) => /^(Max|Pro|Free|Team|Enterprise) plan$/i.test(line));
  const plan = planIdx >= 0 ? lines[planIdx] : null;
  const usageLine = planIdx >= 0 ? lines[planIdx + 1] || null : null;
  const cancelLine = lines.find((line) => /subscription will be canceled on/i.test(line));
  const expiresAt = cancelLine ? parseHumanDate(cancelLine) : null;
  const invoices = parseInvoices(lines);
  const latestPaid = invoices.find((item) => /^Paid$/i.test(item.status)) || null;
  const monthlyCost = latestPaid?.amount_usd ?? null;
  return {
    service_name: 'Claude Code',
    provider: ['anth', 'ropic'].join(''),
    status: plan ? 'active' : 'unknown',
    plan,
    expires_at: expiresAt,
    monthly_cost_usd: monthlyCost,
    metadata: {
      collector: 'weles_keeper_claude_billing_ui',
      source: 'claude.ai settings billing UI',
      collected_at: new Date().toISOString(),
      usage_line: usageLine,
      cancel_line: cancelLine || null,
      latest_paid_invoice: latestPaid,
      invoices,
      ui_excerpt: lines.slice(Math.max(0, billingIdx), billingIdx >= 0 ? billingIdx + 44 : 90),
    },
  };
}

async function main() {
  const args = parseArgs();
  const text = await readText(args.session);
  if (!/Billing/i.test(text) || !/(Invoices|Payment|plan)/i.test(text)) {
    throw new Error('keeper page does not look like Claude billing UI');
  }
  const collected = extractBilling(text);
  const row = {
    ...collected,
    account_identifier: args.account,
    service_credential_id: args.serviceCredentialId,
    last_verified_at: new Date().toISOString(),
  };
  const saved = await upsertSubscription(row);
  console.log(JSON.stringify({
    ok: true,
    row: {
      service_name: row.service_name,
      provider: row.provider,
      account_identifier: row.account_identifier,
      status: row.status,
      plan: row.plan,
      monthly_cost_usd: row.monthly_cost_usd,
      expires_at: row.expires_at,
      invoice_rows: row.metadata.invoices.length,
    },
    saved: saved.map((item) => ({
      id: item.id,
      service_name: item.service_name,
      provider: item.provider,
      account_identifier: item.account_identifier,
      status: item.status,
      plan: item.plan,
      monthly_cost_usd: item.monthly_cost_usd,
      expires_at: item.expires_at,
      last_verified_at: item.last_verified_at,
    })),
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
