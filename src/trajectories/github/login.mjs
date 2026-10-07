import { getSocialAccount } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { humanClickLocator } from '../../../dist/human/mouse.js';
import { persistFreshCookieJar } from '../_shared/auth/cookie-freshness.mjs';
import { runRecordingsDir } from '../../../dist/session/run-recordings.js';
import {
  getReceived,
  listReceivedFrom,
} from '../../_shared/resend-receiving.mjs';
import { pageSettled } from '../_shared/page/settled.mjs';

const URL = 'https://github.com/login';

const acct = await getSocialAccount('github');
if (!acct) {
  console.error('FAIL: no active github account in DB');
  process.exitCode = 1;
}
if (!acct.metadata.password) {
  console.error(`FAIL: account ${acct.username} has no password`);
  process.exitCode = 1;
}
// Skip stubs from a registration that never completed. metadata.status set by
// src/trajectories/github/register.mjs:245 (captcha_blocked) and similar
// signup-fail paths. These rows have no cookies and no real GitHub identity —
// form-login produces "incorrect credentials" forever. Stop the storm here so
// each failed attempt isn't logged as exit 1 against an unrecoverable account.
{
  const s = acct.metadata?.status;
  if (
    [
      'captcha_blocked',
      'unverified',
      'needs_verification',
      'captcha_signup_failed',
    ].includes(s)
  ) {
    console.error(
      `FAIL: account ${acct.username} has metadata.status=${s} — registration never completed; login can't recover (mark account inactive in DB to remove from pool)`,
    );
    process.exitCode = 1;
  }
}
process.env.SVC_EMAIL = acct.metadata.email ?? acct.username;
process.env.SVC_PASSWORD = acct.metadata.password;

// GitHub login: direct egress by default. Empirically, saved Oxylabs
// Mobile BR proxies + PacketStream residential both get rejected by
// GitHub's login endpoint (ERR_EMPTY_RESPONSE from PacketStream, post-
// submit redirect back to /login from Oxylabs BR). Only the first
// successful session-refresh we've seen across the fleet was on direct
// egress (swiftwolf6387 via GCE IP).
//
// Override paths, in priority order:
//   PROXY_URL         — explicit full URL wins
//   FORCE_RESIDENTIAL — pick from provider rotation
//   USE_SAVED_PROXY   — honor the account's metadata.proxy.server
//   (default)         — no proxy, direct egress
const savedProxy = acct.metadata.proxy;
let proxyUrl;
if (process.env.PROXY_URL) {
  proxyUrl = process.env.PROXY_URL;
  console.log(`[login] Using PROXY_URL override`);
} else if (process.env.FORCE_RESIDENTIAL === '1') {
  proxyUrl = 'residential';
  console.log(`[login] Using residential rotation (FORCE_RESIDENTIAL=1)`);
} else if (
  process.env.USE_SAVED_PROXY === '1' &&
  savedProxy?.server &&
  savedProxy?.username
) {
  const u = new globalThis.URL(savedProxy.server);
  proxyUrl = `${u.protocol}//${savedProxy.username}:${savedProxy.password}@${u.hostname}:${u.port}`;
  console.log(
    `[login] Using saved proxy: ${u.hostname}:${u.port} (USE_SAVED_PROXY=1)`,
  );
} else {
  proxyUrl = undefined;
  console.log(
    `[login] No proxy — direct egress (GitHub-friendly default; override with PROXY_URL, FORCE_RESIDENTIAL=1, or USE_SAVED_PROXY=1)`,
  );
}
console.log(`[login] Account: ${acct.username} (${process.env.SVC_EMAIL})`);

// One session, started once: a homepage that does not load is this run's
// failure with Playwright's own cause, not a cue to try again a set number of
// times. Cookie-first is removed — github.com serves a logged-out homepage
// shell and saved cookies might be device-mismatched, so login always means
// form login.
const s = await WSession.start({ label: 'github_login', proxy: proxyUrl });
await s.goto('https://github.com/');
await s.page.waitForLoadState('load', { timeout: 0 });
console.log('[login] Homepage loaded');

try {
  // Cookie-first PASS branch removed. Always do form login.
  await s.ctx.clearCookies();
  await s.goto(URL);
  await pageSettled(s.page);

  // Confirm the login form actually loaded before filling. If we ended up
  // anywhere other than /login or /session/*, something redirected and the
  // form isn't present; bail with a specific error.
  const urlAfterGoto = s.page.url?.() ?? '';
  if (!urlAfterGoto.includes('/login') && !urlAfterGoto.includes('/session')) {
    console.error(
      `FAIL: goto(${URL}) landed at ${urlAfterGoto} — login form not present`,
    );
    process.exitCode = 1;
  }

  await s.fill('Username or email', '$SVC_EMAIL');
  await pageSettled(s.page);
  await s.fill('Password', '$SVC_PASSWORD');
  await pageSettled(s.page);

  // Submit — match ONLY the login form's submit control (value~="Sign in")
  // to avoid hitting unrelated submit buttons on other pages. Use Playwright
  // locator so the click routes through CDP with isTrusted=true (see
  // docs/DETECTION_ANTIPATTERNS.md §1). Login submit is exactly the kind of
  // event github's spam ML reads isTrusted on.
  // Wait for any submit-type control. GitHub serves either classic
  // <input type="submit" name="commit"> or React <button type="submit">.
  // Avoid :has-text — Playwright's text-engine intermittently fails on
  // GitHub's whitespace-padded button text.
  await s.page
    .locator('input[type="submit"], button[type="submit"]')
    .first()
    .waitFor({ state: 'attached' });
  const submitLoc = s.page
    .locator(
      'input[type="submit"][value*="Sign in" i], input[name="commit"], form[action*="/session"] button[type="submit"], button[type="submit"]',
    )
    .first();
  let submitted = { clicked: false };
  if ((await submitLoc.count()) > 0) {
    submitted = await humanClickLocator(s.page, submitLoc)
      .then(() => ({ clicked: true, via: 'humanClickLocator' }))
      .catch((e) => ({ clicked: false, err: e.message }));
    if (!submitted.clicked) {
      // Locator.click hit Chromium synthesizeMouseEvent disconnect; submit form
      // via JS instead. Form has action="/session" so requestSubmit triggers POST.
      const jsOk = await s.page
        .evaluate(
          `(() => { const f = document.querySelector('form[action*="/session"]'); if (!f) return false; if (typeof f.requestSubmit === 'function') f.requestSubmit(); else f.submit(); return true; })()`,
        )
        .catch(() => false);
      if (jsOk) submitted = { clicked: true, via: 'js-form-submit' };
    }
  }
  console.log(`[login] Submit: ${JSON.stringify(submitted)}`);
  if (!submitted.clicked) {
    console.error('FAIL: no Sign-in submit control found on login page');
    process.exitCode = 1;
  }

  // Wait until the page leaves the login form, or GitHub shows its error
  // banner on it; the banner's text is the failure.
  const leftLogin = s.page
    .waitForURL(
      (url) =>
        !url.pathname.startsWith('/login') &&
        !url.pathname.startsWith('/session'),
      { timeout: 0 },
    )
    .then(() => null);
  const banner = s.page
    .locator('.flash-error, [role="alert"]')
    .filter({ visible: true })
    .first();
  const refused = banner
    .waitFor({ state: 'visible', timeout: 0 })
    .then(() => banner.innerText());
  const loginRefusal = await Promise.race([leftLogin, refused]);
  if (loginRefusal !== null)
    throw new Error(`login refused: ${loginRefusal.trim()}`);
  let url2 = s.page.url?.() ?? '';
  console.log(`[login] After submit: ${url2}`);

  // Check for device verification (email code)
  if (
    url2.includes('sessions/verified-device') ||
    url2.includes('launch_code') ||
    url2.includes('two-factor')
  ) {
    console.log(
      '[login] Device verification required, polling Resend for code...',
    );
    const emailAddr = process.env.SVC_EMAIL;
    // The code arrives when GitHub sends it; the inbox is read until it does.
    let otp = null;
    while (!otp) {
      await pageSettled(s.page);
      for (const em of await listReceivedFrom(10, emailAddr, 'github.com')) {
        const full = await getReceived(em.id);
        const body = (full.html ?? '') + (full.text ?? '');
        const m = body.match(/\b(\d{6,8})\b/);
        if (m) {
          otp = m[1];
          break;
        }
      }
    }
    {
      console.log(`[login] Device code: ${otp}`);
      await s.page
        .evaluate(`(code => {
        const inputs = document.querySelectorAll('input[autocomplete="one-time-code"], input[name*="code"], input[inputmode="numeric"]');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        if (inputs.length === 1) { setter.call(inputs[0], code); inputs[0].dispatchEvent(new Event('input', {bubbles:true})); }
        else if (inputs.length >= code.length) { for (let i = 0; i < code.length; i++) { setter.call(inputs[i], code[i]); inputs[i].dispatchEvent(new Event('input', {bubbles:true})); } }
      })(${JSON.stringify(otp)})`)
        .catch(() => {});
      await pageSettled(s.page);
      url2 = s.page.url?.() ?? '';
      console.log(`[login] After device verify: ${url2}`);
    }
  }

  // Verify logged in via fresh user_session cookie. We cleared cookies before
  // form submit, so any user_session present now is from the just-completed
  // password POST → it's proof the session is valid. Avatar-DOM check is
  // unreliable because Chromium can disconnect during the heavy /settings page
  // load before the eval runs.
  const postLoginCookies = await s.ctx.cookies().catch(() => []);
  const sessionCookieFresh = postLoginCookies.find(
    (c) => c.name === 'user_session' && c.value,
  );
  const finalUrl = s.page.url?.() ?? '';
  const isLoginPage =
    finalUrl.includes('/login') || finalUrl.includes('/session');
  if (sessionCookieFresh && !isLoginPage) {
    const finalCookies = postLoginCookies;
    console.log(`PASS: logged in as ${acct.username} — ${finalUrl}`);
    // Persist fresh cookies back to the account, stamped with cookies_minted_at
    // and the proxy they were minted under, so action trajectories inject only
    // a jar a verified login minted under their own egress.
    try {
      await persistFreshCookieJar(acct, finalCookies, {
        currentProxyUrl: proxyUrl,
      });
    } catch (e) {
      console.log('[cookie-capture] err:', e.message);
    }
  } else {
    // Classify the failure so operators can triage. GitHub returns distinct
    // signals for bad credentials vs anti-abuse vs device-verification gates,
    // but they all funnel through /login eventually.
    const diag = await s.page
      .evaluate(`(() => {
      const flash = document.querySelector('.flash-error,[role="alert"]')?.innerText?.trim() || '';
      const body = document.body ? document.body.innerText : '';
      let reason = 'unknown';
      if (/Incorrect username or password|incorrect email|Incorrect password/i.test(flash + body)) reason = 'invalid_credentials';
      else if (/suspended|flagged|abuse/i.test(flash + body)) reason = 'account_suspended';
      else if (/unusual activity|verify your device|verification code/i.test(flash + body)) reason = 'device_verification_required';
      else if (/too many|try again later|rate limit/i.test(flash + body)) reason = 'rate_limited';
      else if (/captcha|are you human|puzzle/i.test(flash + body)) reason = 'captcha_required';
      return { reason, flash, title: document.title };
    })()`)
      .catch(() => ({ reason: 'unknown', flash: '', title: '' }));
    console.error(
      `FAIL: not logged in at ${finalUrl} — reason=${diag.reason} flash=${JSON.stringify(diag.flash)} title=${JSON.stringify(diag.title)}`,
    );
    process.exitCode = 1;
  }
} catch (e) {
  // Structured ban_signal so the worker can route this row correctly. Three
  // common failure tails: chrome-error proxy CONNECT, GitHub's account-locked
  // landing, or an opaque agent give_up after the password page wouldn't
  // accept submitted creds.
  try {
    const path = await import('node:path');
    const fs = await import('node:fs');
    const dir = runRecordingsDir('github_login');
    fs.mkdirSync(dir, { recursive: true });
    const finalUrl = s.page?.url?.() ?? '';
    const msg = e.message ?? '';
    let sig = 'action_failed';
    if (
      /ERR_HTTP_RESPONSE_CODE_FAILURE|ERR_BLOCKED_BY_RESPONSE|ERR_BLOCKED_BY_CLIENT|ERR_BLOCKED_BY_ADMINISTRATOR/.test(
        msg,
      )
    )
      sig = 'ip_blocked';
    else if (
      /ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED/.test(msg)
    )
      sig = 'proxy_failed';
    else if (finalUrl.startsWith('chrome-error://')) sig = 'proxy_failed';
    else if (
      /\/account_lockout|\/account\/locked|\/account_recovery|\/sessions\/two-factor|\/sessions\/verified-device/.test(
        finalUrl,
      )
    )
      sig = 'checkpoint';
    fs.writeFileSync(
      path.join(dir, 'ban_signal.json'),
      JSON.stringify(
        {
          account_id: acct.id,
          username: acct.username,
          action: 'github_login',
          signal: sig,
          healthy: false,
          details: { final_url: finalUrl, reason: e.message ?? 'no message' },
          ts: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  } catch {}
  console.error('FAIL:', e.message);
  process.exitCode = 1;
} finally {
  await s.close();
}
