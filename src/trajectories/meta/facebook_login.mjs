// Facebook form login. Refreshes cookies for an existing social_accounts
// row (platform='facebook') by walking facebook.com/login and persisting
// the resulting jar via persistFreshCookieJar. Used by cross_login
// (tiktok_login_via_facebook / instagram_login_via_facebook /
// producthunt_login_via_facebook) and the periodic login-refresh cron.

import { getSocialAccount, resolveAccountSession } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { humanType } from '../../../dist/human/keyboard.js';
import { humanClickLocator, humanIdlePause } from '../../../dist/human/mouse.js';
import { persistFreshCookieJar } from '../_shared/cookie-freshness.mjs';

const URL = 'https://www.facebook.com/login';

const acct = await getSocialAccount('facebook');
if (!acct) { console.log('FAIL: no active facebook account in DB'); process.exit(1); }
const email = acct.metadata?.email ?? acct.username;
const password = acct.metadata?.password;
if (!email || !password) { console.log('FAIL: facebook account missing email/password'); process.exit(1); }
console.log(`[fb-login] using account: ${acct.username} <${email}>`);

const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'facebook_login', proxy: proxyUrl, persona });

try {
  await s.goto(URL);
  await humanIdlePause('deliberate');

  // Cookie banner — hits a fixed-position blocking overlay on every visit.
  const cookieBtn = s.page.locator('button:has-text("Allow all cookies"), button:has-text("Accept all"), button[data-testid="cookie-policy-manage-dialog-accept-button"]').filter({ visible: true }).first();
  if (await cookieBtn.isVisible().catch(() => false)) {
    await humanClickLocator(s.page, cookieBtn);
    await humanIdlePause('deliberate');
  }

  // 1. Email or mobile.
  const emailIn = s.page.locator('input#email, input[name="email"], input[type="email"]').filter({ visible: true }).first();
  await emailIn.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, emailIn);
  await humanType(s.page, email);

  // 2. Password.
  const pwIn = s.page.locator('input#pass, input[name="pass"], input[type="password"]').filter({ visible: true }).first();
  await pwIn.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, pwIn);
  await humanType(s.page, password);

  // 3. Submit.
  const submit = s.page.locator('button[name="login"], button[type="submit"]:has-text("Log in"), input#loginbutton').filter({ visible: true }).first();
  await humanClickLocator(s.page, submit);
  await humanIdlePause('long');

  // 4. "Save your login info?" / new-device prompt — accept and continue.
  const saveLogin = s.page.locator('button:has-text("Save"), button:has-text("Continue"), div[role="button"]:has-text("Save")').filter({ visible: true }).first();
  if (await saveLogin.isVisible().catch(() => false)) {
    await humanClickLocator(s.page, saveLogin);
    await humanIdlePause('deliberate');
  }

  // 5. Confirm we landed on home (or a checkpoint URL — that's a fail signal).
  const finalUrl = s.page.url?.() ?? '';
  if (/\/checkpoint\/|\/login\/web|\/recover\//.test(finalUrl)) {
    throw new Error(`facebook_checkpoint: ${finalUrl}`);
  }
  if (!/facebook\.com\/(\?|$|home)/.test(finalUrl)) {
    await s.page.goto('https://www.facebook.com/').catch(() => {});
    await humanIdlePause('deliberate');
  }

  const cookies = await s.ctx.cookies();
  const persisted = await persistFreshCookieJar(acct, cookies, { currentProxyUrl: proxyUrl, currentPersona: persona });
  if (!persisted?.ok) throw new Error(`facebook_persist_failed: ${persisted?.reason}`);
  console.log(`PASS: facebook logged in (${cookies.length} cookies persisted)`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close().catch(() => {});
}
