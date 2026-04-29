// JuicySMS balance check via Google SSO. juicysms.com/login has
// "LOGIN WITH GOOGLE" button (and Cloudflare Turnstile).
import { WSession } from '../../../dist/session/wsession.js';
import { googleSso, parseBalanceFromText, patchServiceBalance, getGoogleSsoCreds } from '../_shared/services/google_sso.mjs';

const LOGIN_URL = 'https://juicysms.com/login';
const DISPLAY_NAME = 'JuicySMS';

const login = await getGoogleSsoCreds();
if (!login) { console.log('FAIL: no Google SSO credentials in DB'); process.exit(1); }
console.log(`[trajectory] Using Google SSO: ${login.email}`);

const s = await WSession.start({ label: 'juicysms_balance', browser: 'chromium' });
try {
  await s.goto(LOGIN_URL);
  await s.page.waitForTimeout(8000); // Turnstile auto-solve window

  const popupPromise = s.page.waitForEvent('popup').catch(() => null);
  await s.page.locator('a:has-text("LOGIN WITH GOOGLE"), button:has-text("LOGIN WITH GOOGLE"), a:has-text("Login with Google"), button:has-text("Login with Google")').filter({ visible: true }).first().click();
  const popup = await Promise.race([popupPromise, new Promise(r => setTimeout(() => r(null), 8000))]);

  const ok = await googleSso(s, login, { originHost: 'juicysms.com', page: popup ?? undefined });
  if (!ok) { console.log('FAIL: Google SSO did not complete'); process.exit(1); }

  for (let i = 0; i < 30; i++) { await s.page.waitForTimeout(1000); if (!/\/login/.test(s.page.url())) break; }
  if (/\/login/.test(s.page.url())) {
    await s.page.goto('https://juicysms.com/dashboard', { waitUntil: 'domcontentloaded' }).catch(() => {});
  }
  await s.page.waitForTimeout(5000);

  const text = await s.page.evaluate(() => document.body.innerText);
  console.log(`[trajectory] dashboard text length=${text.length}`);
  const balance = parseBalanceFromText(text);
  if (balance == null) {
    console.log(`FAIL: could not parse balance. First 600 chars: ${text.slice(0, 600).replace(/\n/g, ' | ')}`);
    process.exit(1);
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
