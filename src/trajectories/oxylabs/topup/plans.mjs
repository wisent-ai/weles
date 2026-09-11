// The Oxylabs Mobile Proxies plans, the nearest one to a budget, and reading which plan
// the account is on.
import { humanIdlePause } from '../../../../dist/human/mouse.js';

// Oxylabs Mobile Proxies plans
export const PLANS = [
  { name: 'Starter', price: 30, gb: 4 },
  { name: 'Basic', price: 100, gb: 15 },
  { name: 'Standard', price: 270, gb: 45 },
  { name: 'Advanced', price: 500, gb: 100 },
];
export function nearestPlan(usd) {
  return PLANS.reduce((a, b) => Math.abs(b.price - usd) < Math.abs(a.price - usd) ? b : a);
}

export async function detectCurrentPlan(s, plan) {
  // Oxylabs subscription model (verified 2026-05-05 via /MP/plan-change +
  // /RP/overview body scrapes): each product (MP, RP) supports BOTH a
  // fixed-tier monthly subscription (Starter $30/Basic $100/Standard $270/
  // Advanced $500) AND pay-as-you-go GB credit topups via the page-level
  // "Add more traffic" button. Auto-topup must use the PAYG path only —
  // tier subscriptions are recurring monthly charges that the user must
  // commit to explicitly. Fixed-tier upgrade lives in this file as a
  // separate branch but is gated to never run from auto-cron context.
  await s.goto('https://dashboard.oxylabs.io/en/overview/MP', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await humanIdlePause('long');
  const planText = await s.page.evaluate(() => document.body.innerText);
  const isPayAsYouGo = /Current plan\s*\|?\s*Pay as you go/i.test(planText) || /\bPay as you go\b/i.test(planText);
  let currentPlanName = isPayAsYouGo ? 'Pay as you go' : null;
  if (!currentPlanName) {
    for (const p of PLANS) {
      if (new RegExp(`\\b${p.name}\\b\\s*(Plan|\\$${p.price}|/mo|month)`, 'i').test(planText)) {
        currentPlanName = p.name; break;
      }
    }
  }
  console.log(`[trajectory] current plan=${currentPlanName ?? 'unknown'}; requested=${plan.name}`);
  if (!currentPlanName) {
    console.log(`FAIL: could not detect current Oxylabs plan from /overview/MP — refusing to charge with unknown state`);
    process.exit(1);
  }
  return { isPayAsYouGo, currentPlanName };
}
