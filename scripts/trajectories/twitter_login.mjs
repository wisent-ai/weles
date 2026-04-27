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

async function captureCookies() {
  if (!acct.id) return;
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!supabaseUrl || !key) return;
  try {
    const cookies = await s.ctx.cookies();
    const r = await fetch(`${supabaseUrl}/rest/v1/social_accounts?id=eq.${acct.id}&select=metadata`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    const rows = await r.json();
    const merged = { ...(rows?.[0]?.metadata ?? {}), cookies };
    await fetch(`${supabaseUrl}/rest/v1/social_accounts?id=eq.${acct.id}`, {
      method: 'PATCH',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ metadata: merged }),
    });
    console.log(`[cookie-capture] refreshed ${cookies.length} cookies for account ${acct.id}`);
  } catch (e) { console.log('[cookie-capture] err:', e.message); }
}

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
    await captureCookies();
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
      await captureCookies();
    } else {
      const result = await execute(s, `You are on x.com login flow. Username/email is $SVC_EMAIL, password is $SVC_PASSWORD. If you see a username/email input, fill it and click Next. If you see a "confirm it's you" challenge asking for phone/email/username, fill it with $SVC_EMAIL and click Next. If you see a password input, fill it with $SVC_PASSWORD and click Log in. If you see a 2FA/verification-code prompt, use check_email to retrieve the code and submit it. done(value="logged in") once x.com/home is loaded.`, {
        envHints: { SVC_EMAIL: process.env.SVC_EMAIL, SVC_PASSWORD: '***' },
        flowName: 'twitter_login',
        maxSteps: 25,
      });
      console.log('PASS:', result.value);
      await captureCookies();
    }
  }
} catch (e) {
  // Write a structured ban_signal so the worker doesn't fall back to
  // 'unknown_error'. Twitter login can fail at proxy CONNECT (chrome-error),
  // at the suspended/locked landing page, or simply because the agent loop
  // can't get through 2FA. Surface each cleanly.
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
    else if (/\/i\/flow\/login\/check|\/account\/locked|\/i\/flow\/(verify|access)/.test(finalUrl)) sig = 'checkpoint';
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
