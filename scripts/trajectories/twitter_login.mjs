import { getSocialAccount, resolveAccountSession } from '../../dist/utils/credentials.js';
import { WSession } from '../../dist/session/wsession.js';
import { humanFill } from '../../dist/human/keyboard.js';
import { humanClickLocator } from '../../dist/human/mouse.js';
import { persistFreshCookieJar } from './_shared/cookie-freshness.mjs';

const LOGIN_URL = 'https://x.com/i/flow/login';
const HOME_URL = 'https://x.com/home';

const acct = await getSocialAccount('twitter');
if (!acct) { console.log('FAIL: no active twitter account in DB'); process.exit(1); }
process.env.SVC_EMAIL = acct.metadata.email ?? acct.username;
process.env.SVC_PASSWORD = acct.metadata.password ?? '';
console.log(`[trajectory] Using account: ${acct.username}`);

const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'twitter_login', proxy: proxyUrl, persona });

async function captureCookies() {
  if (!acct.id) return;
  try {
    const cookies = await s.ctx.cookies();
    await persistFreshCookieJar(acct, cookies, { currentProxyUrl: proxyUrl, currentPersona: persona });
  } catch (e) { console.log('[cookie-capture] err:', e.message); }
}

// REMOVED tryCookieFirstLogin — cookies-as-login is a false-positive
// generator. See _shared/auth-probe.mjs for the rationale. Login always
// means form login now; action trajectories use assertAuthed() to verify
// a real authed session before doing anything.
async function _removedCookieFirstLogin_doNotReintroduce() {
  const stored = Array.isArray(acct.metadata?.cookies) ? acct.metadata.cookies : [];
  if (stored.length === 0) return false;
  const hasAuthToken = stored.some((c) => c?.name === 'auth_token');
  if (!hasAuthToken) return false;

  const prepared = stored
    .filter((c) => c && c.name && c.value && (c.domain || c.url))
    .map((c) => ({ ...c, path: c.path || '/' }));
  if (prepared.length === 0) return false;

  try {
    await s.ctx.addCookies(prepared);
    console.log(`[trajectory] injected ${prepared.length} stored cookies (auth_token present) — trying cookie-first login`);
  } catch (e) {
    console.log(`[trajectory] cookie inject failed: ${e.message?.slice(0, 200)}`);
    return false;
  }

  await s.goto(HOME_URL);
  await s.page.waitForLoadState('domcontentloaded').catch(() => {});
  await new Promise((r) => setTimeout(r, 4000));

  const url = s.page.url();
  // If the cookies worked, we land on /home. Otherwise Twitter redirects to
  // /i/flow/login or shows the logged-out splash.
  if (/\/home/.test(url) && !/\/i\/flow\/login/.test(url)) {
    // Double-check by looking for the primary column (only visible when authed)
    // or absence of the Sign-in modal.
    const hasPrimaryCol = await s.page.locator('[data-testid="primaryColumn"], [aria-label="Home timeline"]').first().isVisible().catch(() => false);
    if (hasPrimaryCol) {
      await s.screenshot('cookie_first_ok').catch(() => {});
      return true;
    }
  }
  await s.screenshot('cookie_first_not_logged_in').catch(() => {});
  return false;
}

async function deterministicLogin() {
  const usernameSel = 'input[autocomplete="username"], input[name="text"]';
  const passwordSel = 'input[autocomplete="current-password"], input[name="password"]';
  const nextBtnSel = '[data-testid="LoginForm_Login_Button"], button:has-text("Next")';
  const loginBtnSel = '[data-testid="LoginForm_Login_Button"], button:has-text("Log in")';

  await s.page.waitForSelector(usernameSel);
  await humanFill(s.page, s.page.locator(usernameSel).first(), process.env.SVC_EMAIL);
  await humanClickLocator(s.page, s.page.locator(nextBtnSel).first());

  // Wait for the password input. If a challenge step intervenes (phone/email
  // confirm, 2FA, arkose), the password input never appears and this throws
  // after Playwright's default — outer catch persists ban_signal=checkpoint.
  await s.page.locator(passwordSel).first().waitFor({ state: 'visible' });
  await humanFill(s.page, s.page.locator(passwordSel).first(), process.env.SVC_PASSWORD);
  await humanClickLocator(s.page, s.page.locator(loginBtnSel).first());

  // Wait for /home — auth complete. /i/flow/login/check or any non-/home
  // landing means a post-password challenge (rate limit, locked, suspended)
  // and we throw to ban_signal.
  await s.page.waitForURL(/x\.com\/home/);
}

try {
  // Cookie-first removed — login always means form login. See auth-probe.mjs.
  await s.goto(LOGIN_URL);
  await new Promise((r) => setTimeout(r, 3000));
  await deterministicLogin();
  console.log('PASS: logged in (deterministic email/password)');
  await captureCookies();
} catch (e) {
  // Write a structured ban_signal so the worker doesn't bucket as
  // 'unknown_error'. Twitter login can fail at proxy CONNECT (chrome-error),
  // at the suspended/locked landing page, on a 2FA/arkose challenge that
  // intercepts the password step, or simply because /home never loads after
  // submit (rate limit). Each surfaces with a distinct ban_signal below.
  try {
    const dir = (await import('node:path')).join(process.cwd(), 'recordings', 'twitter_login');
    (await import('node:fs')).mkdirSync(dir, { recursive: true });
    const finalUrl = s.page?.url?.() ?? '';
    const msg = e.message ?? '';
    let sig = 'action_failed';
    // HTTP-level rejection beats chrome-error URL detection: ip_blocked is
    // actionable (worker auto-burns the proxy host) while proxy_failed is
    // ambiguous (could be tunnel failure or rejection). Pattern order matches
    // the linkedin_login fix.
    if (/ERR_HTTP_RESPONSE_CODE_FAILURE|ERR_BLOCKED_BY_RESPONSE|ERR_BLOCKED_BY_CLIENT|ERR_BLOCKED_BY_ADMINISTRATOR/.test(msg)) sig = 'ip_blocked';
    else if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED/.test(msg)) sig = 'proxy_failed';
    else if (finalUrl.startsWith('chrome-error://')) sig = 'proxy_failed';
    else if (/account\/access|account_access/.test(finalUrl)) sig = 'suspended';
    // Any /i/flow/login* (including bare /i/flow/login when /home never
    // loads after submit) is cookies-stale: the trajectory got the form
    // rendered but couldn't push past auth. Same 24h skip as the explicit
    // /check URL.
    else if (/\/i\/flow\/login|\/account\/locked|\/i\/flow\/(verify|access)/.test(finalUrl)) sig = 'checkpoint';
    (await import('node:fs')).writeFileSync((await import('node:path')).join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'twitter_login', signal: sig, healthy: false, details: { final_url: finalUrl, reason: e.message?.slice(0, 200) ?? 'no message' }, ts: new Date().toISOString() }, null, 2));
    // suspended → deactivate row; checkpoint → mark cookies stale (24h skip).
    if (sig === 'suspended') { const { deactivateAccount } = await import('../../dist/account/state.js'); await deactivateAccount(acct.id, acct.metadata, 'TWITTER_SUSPENDED'); }
    else if (sig === 'checkpoint') { const { markCookiesStale } = await import('../../dist/utils/credentials.js'); if (acct.id) await markCookiesStale(acct.id); }
  } catch {}
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
