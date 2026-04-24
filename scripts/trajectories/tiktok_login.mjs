import { getSocialAccount, resolveAccountSession } from '../../dist/utils/credentials.js';
import { WSession } from '../../dist/session/wsession.js';
import { execute } from '../../dist/agent/loop.js';

const PASSWORD_URL = 'https://www.tiktok.com/login/phone-or-email/email';
const FEED_URL = 'https://www.tiktok.com/foryou';
const GOAL = `Fill email with $SVC_EMAIL. Fill password with $SVC_PASSWORD. Click "Log in". Wait for redirect. If a slider-rotation captcha appears, solve_captcha(). done(value="logged in").`;

const acct = await getSocialAccount('tiktok');
if (!acct) { console.log('FAIL: no active tiktok account in DB'); process.exit(1); }
process.env.SVC_EMAIL = acct.metadata.email ?? acct.username;
process.env.SVC_PASSWORD = acct.metadata.password ?? '';
console.log(`[trajectory] Using account: ${acct.username}`);

const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'tiktok_login', proxy: proxyUrl, persona });

async function tryCookieFirstLogin() {
  const stored = Array.isArray(acct.metadata?.cookies) ? acct.metadata.cookies : [];
  if (stored.length === 0) return false;

  // Playwright requires url OR domain+path. Normalize any stored cookie shapes
  // that drop path, and filter out anything missing the core fields.
  const prepared = stored
    .filter((c) => c && c.name && c.value && (c.domain || c.url))
    .map((c) => ({ ...c, path: c.path || '/' }));

  if (prepared.length === 0) return false;

  try {
    await s.ctx.addCookies(prepared);
    console.log(`[trajectory] injected ${prepared.length} stored cookies — trying cookie-first login`);
  } catch (e) {
    console.log(`[trajectory] cookie inject failed: ${e.message?.slice(0, 200)}`);
    return false;
  }

  await s.goto(FEED_URL);
  await s.page.waitForLoadState('domcontentloaded').catch(() => {});

  // Detect logged-in state. TikTok shows a user-avatar button + /foryou feed
  // when authed; otherwise it redirects to /login or shows the login modal.
  const url = s.page.url();
  const loginMarker = /\/login|\/passport|\/foryou\?lang=/i.test(url);
  if (/\/foryou/.test(url) && !loginMarker) {
    const hasProfileNav = await s.page.locator('[data-e2e="profile-icon"], a[href^="/@"]').first().isVisible().catch(() => false);
    if (hasProfileNav) {
      await s.screenshot('cookie_first_ok').catch(() => {});
      return true;
    }
  }
  await s.screenshot('cookie_first_not_logged_in').catch(() => {});
  return false;
}

try {
  const cookieOk = await tryCookieFirstLogin();
  if (cookieOk) {
    console.log('PASS: logged in (cookie-first)');
  } else {
    await s.goto(PASSWORD_URL);
    const result = await execute(s, `Open ${PASSWORD_URL}. ${GOAL}`, {
      envHints: { SVC_EMAIL: process.env.SVC_EMAIL, SVC_PASSWORD: '***' },
      flowName: 'tiktok_login',
    });
    console.log('PASS:', result.value);
  }
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
