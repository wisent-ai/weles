import { getSocialAccount, resolveAccountSession } from '../../dist/utils/credentials.js';
import { WSession } from '../../dist/session/wsession.js';
import { execute } from '../../dist/agent/loop.js';

const LOGIN_URL = 'https://x.com/i/flow/login';
const HOME_URL = 'https://x.com/home';

const acct = await getSocialAccount('twitter');
if (!acct) { console.log('FAIL: no active twitter account in DB'); process.exit(1); }
process.env.SVC_EMAIL = acct.metadata.email ?? acct.username;
process.env.SVC_PASSWORD = acct.metadata.password ?? '';
console.log(`[trajectory] Using account: ${acct.username}`);

const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'twitter_login', proxy: proxyUrl, persona });

async function tryCookieFirstLogin() {
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

async function tryDirectLoginPath() {
  const usernameSel = 'input[autocomplete="username"], input[name="text"]';
  const passwordSel = 'input[autocomplete="current-password"], input[name="password"]';
  const nextBtnSel = '[data-testid="LoginForm_Login_Button"], button:has-text("Next")';
  const loginBtnSel = '[data-testid="LoginForm_Login_Button"], button:has-text("Log in")';

  await s.page.waitForSelector(usernameSel);
  await s.screenshot('direct_username_visible').catch(() => {});
  await s.page.fill(usernameSel, process.env.SVC_EMAIL);
  await s.page.click(nextBtnSel);

  const passwordLocator = s.page.locator(passwordSel).first();
  const challengeLocator = s.page.locator('input[data-testid="ocfEnterTextTextInput"]').first();
  const winner = await Promise.race([
    passwordLocator.waitFor({ state: 'visible' }).then(() => 'password').catch(() => null),
    challengeLocator.waitFor({ state: 'visible' }).then(() => 'challenge').catch(() => null),
  ]);

  if (winner !== 'password') {
    await s.screenshot(winner === 'challenge' ? 'direct_challenge_detected' : 'direct_post_next_unknown').catch(() => {});
    return 'agent-required';
  }

  await s.screenshot('direct_password_visible').catch(() => {});
  await s.page.fill(passwordSel, process.env.SVC_PASSWORD);
  await s.page.click(loginBtnSel);

  try { await s.page.waitForURL(/x\.com\/(home|i\/flow\/login\/check)/); } catch {}
  await s.screenshot('direct_after_submit').catch(() => {});
  return /x\.com\/home/.test(s.page.url()) ? 'ok' : 'agent-required';
}

try {
  const cookieOk = await tryCookieFirstLogin();
  if (cookieOk) {
    console.log('PASS: logged in (cookie-first)');
  } else {
    await s.goto(LOGIN_URL);
    await new Promise((r) => setTimeout(r, 3000));

    let outcome = 'agent-required';
    try {
      outcome = await tryDirectLoginPath();
    } catch (e) {
      console.log(`[trajectory] direct path errored: ${e.message?.slice(0, 200)}`);
      await s.screenshot('direct_errored').catch(() => {});
    }

    if (outcome === 'ok') {
      console.log('PASS: logged in (direct path)');
    } else {
      const result = await execute(s, `You are on x.com login flow. Username/email is $SVC_EMAIL, password is $SVC_PASSWORD. If you see a username/email input, fill it and click Next. If you see a "confirm it's you" challenge asking for phone/email/username, fill it with $SVC_EMAIL and click Next. If you see a password input, fill it with $SVC_PASSWORD and click Log in. If you see a 2FA/verification-code prompt, use check_email to retrieve the code and submit it. done(value="logged in") once x.com/home is loaded.`, {
        envHints: { SVC_EMAIL: process.env.SVC_EMAIL, SVC_PASSWORD: '***' },
        flowName: 'twitter_login',
        maxSteps: 25,
      });
      console.log('PASS:', result.value);
    }
  }
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
