// Bright Data balance check via real browser login. Account was created with
// Google SSO so the customer portal refuses password login ("You already
// created an account using Google"). Drive Google SSO; password stored in
// service_credentials.login_password IS the Google password.
import { getServiceLogin } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { googleSso, parseBalanceFromText } from '../_shared/services/google_sso.mjs';
import { patchEffectiveBalance } from '../_shared/services/proxy_probe.mjs';

const LOGIN_URL = 'https://brightdata.com/cp/login';
const DASH_URL  = 'https://brightdata.com/cp/api_example';
const DISPLAY_NAME = 'Bright Data';

const login = await getServiceLogin(DISPLAY_NAME);
if (!login) { console.log('FAIL: no Bright Data credentials in DB'); process.exit(1); }
console.log(`[trajectory] Using service login: ${login.email}`);

const s = await WSession.start({ label: 'brightdata_balance', browser: 'chromium' });
try {
  await s.goto(LOGIN_URL);
  await s.page.waitForTimeout(2500);

  await s.page.locator('button:has-text("Log in with Google")').filter({ visible: true }).first().click();

  const ok = await googleSso(s, login, { originHost: 'brightdata.com' });
  if (!ok) { console.log('FAIL: Google SSO did not land back on brightdata.com'); process.exit(1); }

  await s.page.waitForTimeout(3000);
  // Bright Data lists balance on the billing page.
  await s.page.goto('https://brightdata.com/cp/setting/billing', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await s.page.waitForTimeout(8000);

  const text = await s.page.evaluate(() => document.body.innerText);
  console.log(`[trajectory] dashboard text length=${text.length}`);
  const balance = parseBalanceFromText(text);
  if (balance == null) {
    console.log(`FAIL: could not parse balance from dashboard text. First 600 chars: ${text.slice(0, 600).replace(/\n/g, ' | ')}`);
    process.exit(1);
  }
  console.log(`[trajectory] balance=$${balance}`);

  const patched = await patchEffectiveBalance(DISPLAY_NAME, balance);
  if (!patched) { console.log('FAIL: balance scraped but PATCH service_credentials failed'); process.exit(1); }
  console.log(`PASS: dashboard=$${balance} (effective balance written + probed)`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
