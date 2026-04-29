// JuicySMS topup via Google SSO. Dry-run by default.
import { WSession } from '../../../dist/session/wsession.js';
import { googleSso, getGoogleSsoCreds } from '../_shared/services/google_sso.mjs';
import { topupOpts, dryRunExit } from '../_shared/services/topup_common.mjs';

const { usd, confirm } = topupOpts();
const login = await getGoogleSsoCreds();
if (!login) { console.log('FAIL: no Google SSO creds'); process.exit(1); }

const s = await WSession.start({ label: 'juicysms_topup', browser: 'chromium' });
try {
  await s.goto('https://juicysms.com/login');
  await s.page.waitForTimeout(8000);
  const popupPromise = s.page.waitForEvent('popup').catch(() => null);
  await s.page.locator('a:has-text("LOGIN WITH GOOGLE"), button:has-text("LOGIN WITH GOOGLE"), a:has-text("Login with Google")').filter({ visible: true }).first().click();
  const popup = await Promise.race([popupPromise, new Promise(r => setTimeout(() => r(null), 8000))]);
  const ok = await googleSso(s, login, { originHost: 'juicysms.com', page: popup ?? undefined });
  if (!ok) { console.log('FAIL: Google SSO did not complete'); process.exit(1); }

  for (let i = 0; i < 30; i++) { await s.page.waitForTimeout(1000); if (!/\/login/.test(s.page.url())) break; }
  await s.page.goto('https://juicysms.com/payment', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await s.page.waitForTimeout(5000);

  const amtIn = s.page.locator('input[type="number"], input[name*="amount" i], input[inputmode="numeric"]').filter({ visible: true }).first();
  if (await amtIn.isVisible().catch(() => false)) {
    await amtIn.click(); await amtIn.fill(String(usd));
    console.log(`[trajectory] amount filled: $${usd}`);
  }

  if (!confirm) { await dryRunExit(s, 'juicysms', usd); process.exit(0); }

  // CONFIRM: Find and click pay button
  const { findAndClickPayButton } = await import('../_shared/services/topup_common.mjs');
  const clicked = await findAndClickPayButton(s.page);
  if (!clicked) {
    console.log('FAIL: could not find pay/checkout button');
    process.exit(1);
  }
  await s.page.waitForTimeout(8000);
  console.log(`PASS-CHARGED: checkout initiated, url=${s.page.url().slice(0, 100)}`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
