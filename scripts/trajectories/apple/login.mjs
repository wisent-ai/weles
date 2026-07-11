// Apple ID login via appstoreconnect.apple.com.
// Flow: load ASC login document -> idmsa iframe -> email -> password -> native trusted-device 2FA -> trusted.

import { getSocialAccount, resolveAccountSession } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { persistFreshCookieJar } from '../_shared/cookie-freshness.mjs';
import { completeAppleNativeTwoFactorChallenge } from './native_2fa/native_2fa.mjs';

const URL = 'https://appstoreconnect.apple.com/login?targetUrl=%2Fapps&authResult=FAILED';

const acct = await getSocialAccount('apple');
if (!acct) { console.log('FAIL: no active apple account in DB'); process.exit(1); }
if (!acct.metadata?.email || !acct.metadata?.password) { console.log('FAIL: apple account missing email/password'); process.exit(1); }

const email = acct.metadata.email;
const password = acct.metadata.password;
console.log(`[apple-login] using account: ${acct.username} (${email})`);

const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'apple_login', proxy: proxyUrl ?? (process.env.PROXY_URL || undefined), persona });
try {
  // The unauthenticated root shell references protected /access/static assets.
  // ASC redirects those asset requests to HTML login responses, so the shell
  // cannot bootstrap and never inserts the idmsa iframe. Load the login
  // document directly, with bounded navigation, instead.
  await s.page.goto(URL, { waitUntil: 'domcontentloaded', timeout: Number(process.env.WELES_APPLE_NAV_TIMEOUT_MS ?? '60000') });
  await s.wait(5);

  // The ASC page embeds an iframe at idmsa.apple.com/appleauth/auth/signin.
  // We need to interact with that iframe, not the top frame.
  const authFrame = await s.page.waitForSelector('iframe[src*="idmsa.apple.com"]', { timeout: 30_000 }).catch(() => null);
  if (!authFrame) { console.log('FAIL: no idmsa auth iframe found'); process.exit(1); }
  const frame = await authFrame.contentFrame();
  if (!frame) { console.log('FAIL: could not access auth iframe'); process.exit(1); }
  console.log('[apple-login] auth iframe loaded');

  // Step 1: fill email (Apple ID)
  console.log('[apple-login] > waitForSelector email');
  await frame.waitForSelector('#account_name_text_field', { timeout: 15_000 });
  console.log('[apple-login] > click email');
  await frame.locator('#account_name_text_field').click();
  console.log('[apple-login] > type email');
  await frame.locator('#account_name_text_field').pressSequentially(email);
  console.log('[apple-login] email filled');
  // The Continue button (#sign-in) is Angular-bound and stays `disabled` until
  // the field validates; .fill() doesn't fire the keystroke it waits for, so
  // clicking it hangs. Submit via Enter instead — Apple's form advances on it.
  console.log('[apple-login] > submit email (Enter)');
  await frame.locator('#account_name_text_field').press('Enter');
  await s.wait(5);

  // Step 2: Apple now shows a choice: "Continue with Password" / "Sign in with Passkey".
  // Click Continue with Password to reveal the password input.
  const continuePwBtn = frame.locator('#continue-password');
  console.log('[apple-login] > check continue-password');
  if (await continuePwBtn.isVisible().catch(() => false)) {
    await continuePwBtn.click();
    console.log('[apple-login] clicked Continue with Password');
    await s.wait(4);
  }

  // Step 3: fill password — try known selectors in order
  const pwSelectors = ['#password_text_field', 'input[type="password"]', 'input[name="password"]', 'input[aria-label*="assword"]'];
  let pwField = null;
  console.log('[apple-login] > find password field');
  for (const sel of pwSelectors) {
    const visible = await frame.locator(sel).first().isVisible().catch(() => false);
    if (visible) { pwField = sel; break; }
  }
  if (!pwField) {
    const probe = await frame.evaluate(() => ({
      inputs: Array.from(document.querySelectorAll('input')).map(i => ({ id: i.id, type: i.type, visible: i.offsetParent !== null })),
      buttons: Array.from(document.querySelectorAll('button')).map(b => ({ id: b.id, text: b.textContent?.trim()?.slice(0, 40), visible: b.offsetParent !== null })).filter(b => b.visible),
    }));
    console.log('[apple-login] probe after continue-password:', JSON.stringify(probe));
    console.log('FAIL: password field not found'); process.exit(1);
  }
  console.log(`[apple-login] password selector: ${pwField}`);
  await frame.locator(pwField).first().click();
  await frame.locator(pwField).first().pressSequentially(password);
  console.log('[apple-login] password filled');
  await frame.locator(pwField).first().press('Enter');
  await s.wait(5);

  // Probe what's on screen post-password: either dashboard redirect, 2FA, or error
  await s.wait(3);
  const postPw = await frame.evaluate(() => ({
    inputs: Array.from(document.querySelectorAll('input')).map(i => ({ id: i.id, type: i.type, ariaLabel: i.getAttribute('aria-label'), visible: i.offsetParent !== null })).filter(i => i.visible),
    buttons: Array.from(document.querySelectorAll('button')).map(b => ({ id: b.id, text: b.textContent?.trim()?.slice(0, 50), visible: b.offsetParent !== null })).filter(b => b.visible),
    bodyText: document.body?.innerText?.slice(0, 800),
  })).catch(() => ({ inputs: [], buttons: [], bodyText: '(iframe gone — probably redirected)' }));
  console.log('[apple-login] post-password probe:', JSON.stringify(postPw));

  // Step 4: 2FA if prompted. Apple's trusted-device flow shows 6 single-char boxes.
  const twoFaInput = await frame.locator('input[aria-label*="digit"], input[aria-label*="Digit"], input[id*="char"], input[type="tel"][maxlength="1"]').first().isVisible().catch(() => false);
  if (twoFaInput) {
    console.log('[apple-login] 2FA prompt detected');
    const twoFa = await completeAppleNativeTwoFactorChallenge(s, frame, {
      logPrefix: '[apple-login]',
    });
    if (!twoFa.ok) {
      console.log(`FAIL: Apple native 2FA did not complete (${twoFa.codeFile || 'no code file'})`);
      process.exit(2);
    }
    console.log('[apple-login] native 2FA completed');
    await s.wait(5);
  }

  // Wait for redirect to ASC dashboard — outer URL must leave /login
  for (let i = 0; i < 30; i++) {
    const url = s.page.url?.() ?? '';
    const isDashboard = url.includes('appstoreconnect.apple.com') && !url.includes('/login') && !url.includes('idmsa');
    if (isDashboard) {
      console.log(`PASS: logged in — ${url}`);
      // Persist the fresh cookie jar so cross_login (reddit_login_via_apple,
      // tiktok_login_via_apple, etc.) can replay it on the next OAuth click
      // without forcing a re-login on appleid.apple.com.
      try {
        const cookies = await s.ctx.cookies();
        const persisted = await persistFreshCookieJar(acct, cookies, { currentProxyUrl: proxyUrl, currentPersona: persona });
        console.log(`[apple-login] cookie persist: ${persisted?.ok ? `ok (${cookies.length})` : `FAIL ${persisted?.reason}`}`);
      } catch (e) { console.log(`[apple-login] cookie persist err: ${e.message?.slice(0, 120)}`); }
      await s.saveAccount('apple', { username: acct.username, email, password });
      process.exit(0);
    }
    await s.wait(1);
  }
  console.log(`FAIL: did not reach ASC dashboard, still at ${s.page.url?.()}`);
  process.exit(1);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
