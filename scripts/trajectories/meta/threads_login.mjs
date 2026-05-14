// Threads form login. Threads has no native form (the public login page only
// renders 'Continue with Instagram' — verified 2026-05-02 by the login-modes
// probe at .work/login-modes/captures/threads_login.json). This trajectory
// pulls the IG account row, injects IG cookies onto threads.net via the
// extra-mirror-domains path (same trick as meta/threads_register.mjs), then
// drives the SSO consent and persists the resulting Threads cookies.

import { getSocialAccount, resolveAccountSession } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { humanClickLocator, humanIdlePause } from '../../../dist/human/mouse.js';
import {
  injectProviderCookies,
  handleOAuthConsent,
  waitForNavBackTo,
} from '../../../dist/platforms/_shared/cross_platform_oauth.js';
import { persistFreshCookieJar } from '../_shared/cookie-freshness.mjs';

const URL = 'https://www.threads.net/login';

const acct = await getSocialAccount('threads');
if (!acct) { console.log('FAIL: no active threads account in DB'); process.exit(1); }

const igAcct = await getSocialAccount('instagram');
if (!igAcct) { console.log('FAIL: no instagram account to drive Threads SSO'); process.exit(1); }
const igCookies = igAcct.metadata?.cookies ?? [];
if (igCookies.length < 2) { console.log(`FAIL: instagram ${igAcct.username} has ${igCookies.length} cookies — login IG first`); process.exit(1); }

console.log(`[threads-login] target=${acct.username} via instagram=${igAcct.username}`);

const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'threads_login', proxy: proxyUrl, persona });

try {
  // Inject IG cookies onto both .instagram.com and .threads.net (mirror).
  const injected = await injectProviderCookies(s.ctx, 'instagram', igCookies, { extraMirrorDomains: ['.threads.net'] });
  console.log(`[threads-login] injected ${injected} instagram+threads cookies`);

  await s.goto(URL);
  await humanIdlePause('deliberate');

  // If we already authed via the cookie mirror, the page redirects straight
  // off /login to the home feed. Otherwise click the 'Continue with Instagram'
  // SSO button and walk consent.
  const url1 = s.page.url?.() ?? '';
  if (/threads\.(net|com)\/(login|accounts\/login)/.test(url1)) {
    const ssoBtn = s.page.getByRole('button', { name: /^\s*Continue with Instagram\s*$/i }).first();
    const ssoLink = s.page.getByRole('link', { name: /^\s*Continue with Instagram\s*$/i }).first();
    const target = (await ssoBtn.isVisible().catch(() => false)) ? ssoBtn : ssoLink;
    if (await target.isVisible().catch(() => false)) {
      await humanClickLocator(s.page, target);
      await humanIdlePause('deliberate');
      await handleOAuthConsent(s);
      await waitForNavBackTo(s.page, 'threads', ['accounts.google.com', 'instagram.com/oauth'], 30);
    }
  }

  // Confirm we left /login. If still there, IG cookies are stale — surface as
  // a deterministic blocker.
  const finalUrl = s.page.url?.() ?? '';
  if (/threads\.(net|com)\/(login|accounts\/login)/.test(finalUrl)) {
    throw new Error(`threads_login_did_not_advance: ${finalUrl}`);
  }

  const cookies = await s.ctx.cookies();
  const persisted = await persistFreshCookieJar(acct, cookies, { currentProxyUrl: proxyUrl, currentPersona: persona });
  if (!persisted?.ok) throw new Error(`threads_persist_failed: ${persisted?.reason}`);
  console.log(`PASS: threads logged in (${cookies.length} cookies persisted, final=${finalUrl})`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close().catch(() => {});
}
