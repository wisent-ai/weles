// Microsoft account form login — refreshes cookies for an existing
// social_accounts row (platform='microsoft') by walking login.live.com.
// Used by linkedin_login_via_microsoft + the cross_login periodic refresher.

import { getSocialAccount, resolveAccountSession } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { humanType } from '../../../dist/human/keyboard.js';
import { humanClickLocator, humanIdlePause } from '../../../dist/human/mouse.js';
import { persistFreshCookieJar } from '../_shared/cookie-freshness.mjs';

const URL = 'https://login.live.com/login.srf';

const acct = await getSocialAccount('microsoft');
if (!acct) { console.log('FAIL: no active microsoft account in DB'); process.exit(1); }
const email = acct.metadata?.email ?? acct.username;
const password = acct.metadata?.password;
if (!email || !password) { console.log('FAIL: microsoft account missing email/password'); process.exit(1); }
console.log(`[ms-login] using account: ${acct.username} <${email}>`);

const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'microsoft_login', proxy: proxyUrl, persona });

try {
  await s.goto(URL);
  await humanIdlePause('deliberate');

  // 1. Email
  const emailIn = s.page.locator('input[name="loginfmt"], input#i0116, input[type="email"]').filter({ visible: true }).first();
  await emailIn.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, emailIn);
  await humanType(s.page, email);
  await humanClickLocator(s.page, s.page.locator('input[type="submit"]#idSIButton9, button[type="submit"]:has-text("Next"), input[type="submit"]:has-text("Next")').filter({ visible: true }).first());
  await humanIdlePause('deliberate');

  // 2. Password
  const pwIn = s.page.locator('input[name="passwd"], input#i0118, input[type="password"]').filter({ visible: true }).first();
  await pwIn.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, pwIn);
  await humanType(s.page, password);
  await humanClickLocator(s.page, s.page.locator('input[type="submit"]#idSIButton9, button[type="submit"]:has-text("Sign in"), input[type="submit"]:has-text("Sign in")').filter({ visible: true }).first());
  await humanIdlePause('long');

  // 3. "Stay signed in?" prompt — click Yes for sticky session.
  const ksiOk = s.page.locator('input#idSIButton9, button:has-text("Yes")').filter({ visible: true }).first();
  if (await ksiOk.isVisible().catch(() => false)) {
    await humanClickLocator(s.page, ksiOk);
    await humanIdlePause('deliberate');
  }

  // 4. Land on account.microsoft.com or any *.live.com authed surface.
  const finalUrl = s.page.url?.() ?? '';
  if (!/account\.microsoft\.com|outlook\.live\.com|outlook\.office\.com|microsoft365\.com|login\.live\.com\/oauth20/i.test(finalUrl)) {
    // Try a known landing to confirm session.
    await s.page.goto('https://account.microsoft.com').catch(() => {});
    await humanIdlePause('deliberate');
  }

  const cookies = await s.ctx.cookies();
  const persisted = await persistFreshCookieJar(acct, cookies, { currentProxyUrl: proxyUrl, currentPersona: persona });
  if (!persisted?.ok) throw new Error(`microsoft_persist_failed: ${persisted?.reason}`);
  console.log(`PASS: microsoft logged in (${cookies.length} cookies persisted)`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close().catch(() => {});
}
