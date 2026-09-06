// Collect Kimi subscription metadata from a verified Weles keeper UI.
//
// Expected UI:
//   kimi.com -> Settings -> Subscription
//   "Allegro"
//   "Next auto-renewal date: 2026-07-14"
//   tabs: Subscription Info, My Quota, Billing & Invoices
//
// This reads UI text from a keeper session that was verified interactively
// first. It does not call provider billing APIs and it does not run a fresh
// login trajectory.

import net from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { upsertSubscription } from '../../lib/service_subscriptions.mjs';

function parseArgs() {
  const out = {
    session: process.env.SESSION || '',
    account: 'lukasz.bartoszcze@gmail.com',
    serviceCredentialId: 'kimi-lukasz-google-sso',
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
  const result = await action(session, { action: 'eval', js: 'document.body.innerText' });
  return String(result.result || '');
}

async function clickExactText(session, textValue) {
  const result = await action(session, {
    action: 'eval',
    js: `(() => {
      const wanted = ${JSON.stringify(textValue)};
      for (const el of [...document.querySelectorAll('button,a,[role=button],div,span')]) {
        const text = (el.innerText || el.textContent || '').trim();
        if (text !== wanted) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 5 || r.height < 5) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none') continue;
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }
      return null;
    })()`,
  });
  if (!result.result) throw new Error(`no visible text target: ${textValue}`);
  await action(session, { action: 'humanclick', x: result.result.x, y: result.result.y });
  await action(session, { action: 'humanidle', kind: 'deliberate' });
}

function linesOf(text) {
  return text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseDate(value) {
  const m = String(value || '').match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  return m ? `${m[1]}T00:00:00+00:00` : null;
}

function parseInvoices(lines) {
  const invoices = [];
  for (let i = 0; i < lines.length - 2; i += 1) {
    const date = parseDate(lines[i]);
    const amount = lines[i + 1]?.match(/^\$(\d+(?:\.\d{2})?)$/);
    const status = lines[i + 2]?.trim();
    if (!date || !amount || !/^(Paid|Refunded|Open|Void)$/i.test(status || '')) continue;
    invoices.push({ date, amount_usd: Number(amount[1]), status });
  }
  return invoices;
}

function extractInfo(text) {
  const lines = linesOf(text);
  const upgradeIdx = lines.findIndex((line) => line === 'Upgrade Plan');
  const plan = upgradeIdx > 0 ? lines[upgradeIdx - 1] : lines.find((line) => line === 'Allegro') || null;
  const renewLine = lines.find((line) => /^Next auto-renewal date:/i.test(line));
  const renewalAt = renewLine ? parseDate(renewLine) : null;
  const benefitsStart = lines.findIndex((line) => line === 'Basic Benefits');
  const benefits = benefitsStart >= 0
    ? lines.slice(benefitsStart + 1).filter((line) => !['Cancel Plan'].includes(line))
    : [];
  return {
    plan,
    renewal_at: renewalAt,
    renewal_line: renewLine || null,
    benefits,
    ui_excerpt: lines.slice(Math.max(0, upgradeIdx - 2), upgradeIdx >= 0 ? upgradeIdx + 40 : 80),
  };
}

function extractQuota(text) {
  const lines = linesOf(text);
  const usageIdx = lines.findIndex((line) => line === 'Total usage');
  const giftIdx = lines.findIndex((line, idx) => line === 'Total usage' && idx > usageIdx);
  const resetLine = lines.find((line) => /^Reset time:/i.test(line));
  const giftExpiryLine = lines.find((line) => /^Expires on/i.test(line));
  const history = [];
  for (let i = 0; i < lines.length - 2; i += 1) {
    if (lines[i] !== 'Kimi Code') continue;
    const at = lines[i + 1];
    const percent = lines[i + 2];
    if (!/^20\d{2}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}$/.test(at)) continue;
    if (!/^\d+(?:\.\d+)?%$/.test(percent)) continue;
    history.push({ service: 'Kimi Code', at, percentage: percent });
  }
  return {
    total_usage_percent: usageIdx >= 0 ? lines[usageIdx + 1] || null : null,
    reset_at: resetLine ? parseDate(resetLine) : null,
    gift_usage_percent: giftIdx >= 0 ? lines[giftIdx + 1] || null : null,
    gift_expires_at: giftExpiryLine ? parseDate(giftExpiryLine) : null,
    recent_usage: history.slice(0, 40),
    ui_excerpt: lines.slice(Math.max(0, usageIdx - 3), usageIdx >= 0 ? usageIdx + 70 : 90),
  };
}

function selectCurrentPlanCost(invoices) {
  const paid = invoices.filter((item) => /^Paid$/i.test(item.status));
  if (!paid.length) return null;
  const latestDate = paid.map((item) => item.date).sort().at(-1);
  const latestPaid = paid.filter((item) => item.date === latestDate);
  return Math.max(...latestPaid.map((item) => item.amount_usd));
}

async function main() {
  const args = parseArgs();
  await action(args.session, { action: 'nav', url: 'https://www.kimi.com/membership/subscription' });
  await action(args.session, { action: 'humanidle', kind: 'deliberate' });

  const infoText = await readText(args.session);
  if (!/Subscription Info/i.test(infoText) || !/Next auto-renewal date/i.test(infoText)) {
    throw new Error('keeper page does not look like Kimi subscription UI');
  }
  const info = extractInfo(infoText);

  await clickExactText(args.session, 'Billing & Invoices');
  const billingText = await readText(args.session);
  const invoices = parseInvoices(linesOf(billingText));

  await clickExactText(args.session, 'My Quota');
  const quotaText = await readText(args.session);
  const quota = extractQuota(quotaText);

  const monthlyCost = selectCurrentPlanCost(invoices);
  const row = {
    service_name: 'Kimi Code',
    provider: 'moonshot',
    account_identifier: args.account,
    service_credential_id: args.serviceCredentialId,
    status: info.plan ? 'active' : 'unknown',
    plan: info.plan,
    expires_at: info.renewal_at,
    monthly_cost_usd: monthlyCost,
    last_verified_at: new Date().toISOString(),
    metadata: {
      collector: 'weles_keeper_kimi_subscription_ui',
      source: 'kimi.com membership subscription UI',
      collected_at: new Date().toISOString(),
      renewal_line: info.renewal_line,
      monthly_cost_basis: monthlyCost == null ? null : 'largest paid invoice on latest invoice date in Billing & Invoices UI',
      benefits: info.benefits,
      invoices,
      quota,
      ui_excerpt: {
        subscription_info: info.ui_excerpt,
        billing: linesOf(billingText).slice(0, 80),
        quota: quota.ui_excerpt,
      },
    },
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
      invoice_rows: invoices.length,
      usage_percent: quota.total_usage_percent,
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
