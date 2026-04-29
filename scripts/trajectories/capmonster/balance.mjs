// CapMonster Cloud balance check via Google SSO. login goes through Keycloak
// at auth.capmonster.cloud which exposes a "Login with Google" link.
import { WSession } from '../../../dist/session/wsession.js';
import { googleSso, parseBalanceFromText, patchServiceBalance, getGoogleSsoCreds } from '../_shared/services/google_sso.mjs';

const LOGIN_URL = 'https://dash.capmonster.cloud/?culture=en';
const DISPLAY_NAME = 'CapMonster Cloud';

const login = await getGoogleSsoCreds();
if (!login) { console.log('FAIL: no Google SSO credentials in DB'); process.exit(1); }
console.log(`[trajectory] Using Google SSO: ${login.email}`);

const s = await WSession.start({ label: 'capmonster_balance', browser: 'chromium' });
try {
  await s.goto(LOGIN_URL);
  await s.page.waitForTimeout(4000);

  await s.page.locator('a:has-text("Login with Google"), a:has-text("Continue with Google"), a:has-text("Sign in with Google")').filter({ visible: true }).first().click();

  const ok = await googleSso(s, login, { originHost: 'capmonster.cloud' });
  if (!ok) { console.log('FAIL: Google SSO did not land back on capmonster.cloud'); process.exit(1); }

  await s.page.waitForTimeout(6000);
  const text = await s.page.evaluate(() => document.body.innerText);
  console.log(`[trajectory] dashboard text length=${text.length}`);
  const balance = parseBalanceFromText(text);
  if (balance == null) {
    console.log(`FAIL: could not parse balance. First 600 chars: ${text.slice(0, 600).replace(/\n/g, ' | ')}`);
    process.exit(1);
  }
  console.log(`[trajectory] balance=$${balance}`);

  const patched = await patchServiceBalance(DISPLAY_NAME, balance);
  if (!patched) { console.log('FAIL: balance scraped but PATCH service_credentials failed'); process.exit(1); }
  console.log(`PASS: balance=$${balance} (persisted)`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
