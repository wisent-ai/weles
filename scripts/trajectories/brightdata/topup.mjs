// Bright Data topup via Google SSO. Dry-run by default.
// Charges against the saved Mastercard *1400 when TOPUP_CONFIRM=1.
import { getServiceLogin } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { googleSso } from '../_shared/services/google_sso.mjs';
import { topupOpts, dryRunExit } from '../_shared/services/topup_common.mjs';

const { usd, confirm } = topupOpts();
const login = await getServiceLogin('Bright Data');
if (!login) { console.log('FAIL: no Bright Data creds'); process.exit(1); }

const s = await WSession.start({ label: 'brightdata_topup', browser: 'chromium' });
try {
  await s.goto('https://brightdata.com/cp/login');
  await s.page.waitForTimeout(2500);
  await s.page.locator('button:has-text("Log in with Google")').filter({ visible: true }).first().click();
  const ok = await googleSso(s, login, { originHost: 'brightdata.com' });
  if (!ok) { console.log('FAIL: Google SSO did not complete'); process.exit(1); }

  await s.page.waitForTimeout(3000);
  // Bright Data's Add Funds modal lives on a dedicated billing_flow page.
  await s.page.goto('https://brightdata.com/cp/billing_flow?type=top_up', { waitUntil: 'domcontentloaded' });
  await s.page.waitForTimeout(8000);

  // Dismiss any first-login survey popups that intercept clicks.
  for (const sel of ['button:has-text("Skip")', 'button:has-text("X")', '[aria-label="Close"]']) {
    const btn = s.page.locator(sel).first();
    if (await btn.isVisible().catch(() => false)) { await btn.click({ force: true }).catch(() => {}); await s.page.waitForTimeout(400); }
  }

  const amtIn = s.page.locator('input[type="number"]').filter({ visible: true }).first();
  await amtIn.waitFor({ state: 'visible' });
  await amtIn.click();
  await amtIn.fill(String(usd));
  console.log(`[trajectory] amount filled: $${usd}`);

  if (!confirm) { await dryRunExit(s, 'brightdata', usd); process.exit(0); }

  // Submit. The Pay button text mirrors the amount.
  const payBtn = s.page.locator(`button:has-text("Pay $${usd}"), button:has-text("Pay")`).filter({ visible: true }).first();
  await payBtn.waitFor({ state: 'visible' });
  console.log(`[trajectory] clicking Pay $${usd} (will charge saved payment method)`);
  await payBtn.click();
  await s.page.waitForTimeout(15000);
  console.log(`[trajectory] post-charge url=${s.page.url()}`);
  console.log(`PASS-CHARGED: $${usd} submitted to Bright Data. Verify via brightdata/balance.mjs in 1-2 minutes.`);
  process.exit(0);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
