import { getSocialAccount } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { humanType } from '../../../dist/human/keyboard.js';
import { humanClickLocator } from '../../../dist/human/mouse.js';
import { persistFreshCookieJar } from '../_shared/cookie-freshness.mjs';

const URL = 'https://accounts.snapchat.com/accounts/login';

const acct = await getSocialAccount('snapchat');
if (!acct) { console.log('FAIL: no active snapchat account in DB'); process.exit(1); }
process.env.SVC_USER = acct.metadata.email ?? acct.username;
process.env.SVC_PASSWORD = acct.metadata.password ?? '';
console.log(`[trajectory] Using account: ${acct.username}`);

const s = await WSession.start({ label: 'snapchat_login', proxy: process.env.PROXY_URL || undefined });
try {
  await s.goto(URL);
  await s.page.waitForTimeout(2500);
  // Step 1: username/email input → Next.
  const userIn = s.page.locator('input[name="username"], input#username, input[autocomplete="username"], input[type="email"]').filter({ visible: true }).first();
  await userIn.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, userIn);
  await humanType(s.page, process.env.SVC_USER);
  await humanClickLocator(s.page, s.page.locator('button[type="submit"], button:has-text("Next"), button:has-text("Continue")').filter({ visible: true }).first());
  // Step 2: password → Log In.
  const pwIn = s.page.locator('input[name="password"], input[type="password"], input[autocomplete="current-password"]').filter({ visible: true }).first();
  await pwIn.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, pwIn);
  await humanType(s.page, process.env.SVC_PASSWORD);
  await humanClickLocator(s.page, s.page.locator('button[type="submit"], button:has-text("Log In"), button:has-text("Sign in")').filter({ visible: true }).first());
  await s.page.waitForFunction(() => /accounts\.snapchat\.com\/(?!.*login)/.test(location.href) || /accounts\.snapchat\.com\/account\/?$/.test(location.href), { timeout: 25000 });
  // Persist with cookies_minted_at for freshness window enforcement.
  try { const cookies = await s.ctx.cookies(); await persistFreshCookieJar(acct, cookies, { currentProxyUrl: process.env.PROXY_URL }); }
  catch (e) { console.log('[cookie-capture] err:', e.message?.slice(0, 100)); }
  console.log(`PASS: logged in (${s.page.url()})`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
