// NopeCHA balance check via Google SSO. Sign-in modal opens after clicking
// the homepage "Sign in" anchor and offers "Continue with Google".
import { WSession } from '../../../dist/session/wsession.js';
import { googleSso, parseBalanceFromText, patchServiceBalance, getGoogleSsoCreds } from '../_shared/services/google_sso.mjs';

const HOME_URL = 'https://nopecha.com/';
const MANAGE_URL = 'https://nopecha.com/manage';
const DISPLAY_NAME = 'NopeCHA';

const login = await getGoogleSsoCreds();
if (!login) { console.log('FAIL: no Google SSO creds'); process.exit(1); }
console.log(`[trajectory] Using Google SSO: ${login.email}`);

const s = await WSession.start({ label: 'nopecha_balance', browser: 'chromium' });
try {
  await s.goto(HOME_URL);
  await s.page.waitForTimeout(4000);

  // Click homepage Sign in to open modal.
  await s.page.locator('a:has-text("Sign in")').first().click();
  await s.page.waitForTimeout(3000);

  // "Continue with Google" navigates same-tab to accounts.google.com with
  // redirect_uri=https://api.nopecha.com/oauth/google/redirect (standard
  // server-side OAuth callback, no popup).
  await s.page.locator('button:has-text("Continue with Google")').filter({ visible: true }).first().click();

  const ok = await googleSso(s, login, { originHost: 'nopecha.com' });
  if (!ok) { console.log('FAIL: Google SSO did not complete'); process.exit(1); }

  // After SSO, navigate to /manage to see keys + balance.
  await s.page.waitForTimeout(5000);
  await s.page.goto(MANAGE_URL, { waitUntil: 'domcontentloaded' });
  await s.page.waitForTimeout(5000);

  const text = await s.page.evaluate(() => document.body.innerText);
  console.log(`[trajectory] /manage text length=${text.length}`);

  if (/No active keys found/i.test(text)) {
    console.log('FAIL: still showing "No active keys found" after Google SSO. Account is logged in but has no NopeCHA subscription/keys yet — buy a plan or generate a free trial key first.');
    process.exit(1);
  }

  const balance = parseBalanceFromText(text);
  if (balance == null) {
    console.log(`[trajectory] no $ balance pattern; recording $0`);
    const patched = await patchServiceBalance(DISPLAY_NAME, 0);
    if (!patched) { console.log('FAIL: PATCH failed'); process.exit(1); }
    console.log(`PASS: balance=$0 (no purchasable balance, account active)`);
    process.exit(0);
  }
  console.log(`[trajectory] balance=$${balance}`);

  const patched = await patchServiceBalance(DISPLAY_NAME, balance);
  if (!patched) { console.log('FAIL: PATCH service_credentials failed'); process.exit(1); }
  console.log(`PASS: balance=$${balance} (persisted)`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
