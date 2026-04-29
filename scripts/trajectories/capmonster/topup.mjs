// CapMonster Cloud topup via Google SSO through Keycloak.
import { WSession } from '../../../dist/session/wsession.js';
import { googleSso, getGoogleSsoCreds } from '../_shared/services/google_sso.mjs';
import { topupOpts, dryRunExit, findAndClickPayButton } from '../_shared/services/topup_common.mjs';

const { usd, confirm } = topupOpts();
const login = await getGoogleSsoCreds();
if (!login) { console.log('FAIL: no Google SSO creds'); process.exit(1); }

const s = await WSession.start({ label: 'capmonster_topup', browser: 'chromium' });
try {
  await s.goto('https://dash.capmonster.cloud/?culture=en');
  await s.page.waitForTimeout(4000);
  await s.page.locator('a:has-text("Login with Google"), a:has-text("Continue with Google")').filter({ visible: true }).first().click();
  const ok = await googleSso(s, login, { originHost: 'capmonster.cloud' });
  if (!ok) { console.log('FAIL: Google SSO did not complete'); process.exit(1); }

  await s.page.waitForTimeout(5000);
  await s.page.goto('https://dash.capmonster.cloud/Profile/AddFunds', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await s.page.waitForTimeout(5000);

  // Fill amount if input exists
  const amtIn = s.page.locator('input[type="number"], input[name*="amount" i], input[inputmode="numeric"]').filter({ visible: true }).first();
  if (await amtIn.isVisible().catch(() => false)) {
    await amtIn.click(); await amtIn.fill(String(usd));
    console.log(`[trajectory] amount filled: $${usd}`);
  }

  if (!confirm) { await dryRunExit(s, 'capmonster', usd); process.exit(0); }

  // CONFIRM: Find and click the pay/checkout button
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
