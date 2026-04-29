// Oxylabs topup via Google GSI iframe + popup OAuth. Oxylabs uses
// plan-based billing (not USD wallet) so dry-run lands on billing page.
import { WSession } from '../../../dist/session/wsession.js';
import { googleSso, getGoogleSsoCreds } from '../_shared/services/google_sso.mjs';
import { topupOpts, dryRunExit } from '../_shared/services/topup_common.mjs';

const { usd, confirm } = topupOpts();
const login = await getGoogleSsoCreds();
if (!login) { console.log('FAIL: no Google SSO creds'); process.exit(1); }

const s = await WSession.start({ label: 'oxylabs_topup', browser: 'chromium' });
try {
  await s.goto('https://dashboard.oxylabs.io/');
  await s.page.waitForTimeout(5000);
  const gsiFrame = s.page.frames().find(f => /gsi\/button/.test(f.url()));
  if (!gsiFrame) { console.log('FAIL: GSI iframe not found'); process.exit(1); }
  const popupPromise = s.page.waitForEvent('popup').catch(() => null);
  await gsiFrame.locator('div[role="button"]').first().click();
  const popup = await Promise.race([popupPromise, new Promise(r => setTimeout(() => r(null), 15000))]);
  if (!popup) { console.log('FAIL: popup did not open'); process.exit(1); }
  await popup.waitForLoadState('domcontentloaded').catch(() => {});
  const ok = await googleSso(s, login, { originHost: 'oxylabs.io', page: popup });
  if (!ok) { console.log('FAIL: Google SSO did not complete'); process.exit(1); }

  for (let i = 0; i < 60; i++) { await s.page.waitForTimeout(1000); const u = s.page.url(); if (!/^https:\/\/dashboard\.oxylabs\.io\/en\/?(\?.*)?$/.test(u)) break; }
  console.log(`[trajectory] post-login url=${s.page.url()}`);

  // Oxylabs sells GB plans, not USD wallet top-up. Land on billing/plans.
  for (const txt of [/Mobile Proxies/i, /Residential/i]) {
    const btn = s.page.getByText(txt).first();
    if (await btn.isVisible().catch(() => false)) { await btn.click({ force: true }).catch(() => {}); break; }
  }
  await s.page.waitForTimeout(5000);

  if (!confirm) { await dryRunExit(s, 'oxylabs', usd); process.exit(0); }
  console.log('FAIL: Oxylabs uses plan-based purchases (GB packages), not USD wallet — TOPUP_CONFIRM=1 not wired. Buy a plan via the dashboard manually.');
  process.exit(1);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally { await s.close(); }
