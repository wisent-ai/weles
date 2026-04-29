import { getSocialAccount } from '../../dist/utils/credentials.js';
import { WSession } from '../../dist/session/wsession.js';
import { humanClickLocator } from '../../dist/human/mouse.js';

const URL = 'https://github.com/login';

const acct = await getSocialAccount('github');
if (!acct) { console.log('FAIL: no active github account in DB'); process.exit(1); }
if (!acct.metadata.password) { console.log(`FAIL: account ${acct.username} has no password`); process.exit(1); }
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
} else if (process.env.USE_SAVED_PROXY === '1' && savedProxy?.server && savedProxy?.username) {
  const u = new globalThis.URL(savedProxy.server);
  proxyUrl = `${u.protocol}//${savedProxy.username}:${savedProxy.password}@${u.hostname}:${u.port}`;
  console.log(`[login] Using saved proxy: ${u.hostname}:${u.port} (USE_SAVED_PROXY=1)`);
} else {
  proxyUrl = undefined;
  console.log(`[login] No proxy — direct egress (GitHub-friendly default; override with PROXY_URL, FORCE_RESIDENTIAL=1, or USE_SAVED_PROXY=1)`);
}
console.log(`[login] Account: ${acct.username} (${process.env.SVC_EMAIL})`);

let s;
for (let retry = 0; retry < 3; retry++) {
  try {
    s = await WSession.start({ label: 'github_login', proxy: proxyUrl });
    // Try cookie-first: inject github.com cookies from saved account before navigating
    const cookies = (acct.metadata.cookies ?? []).filter(c => (c.domain ?? '').includes('github.com'));
    if (cookies.length) {
      await s.ctx.addCookies(cookies).catch(e => console.log(`[login] cookie add error: ${e.message?.slice(0, 80)}`));
      console.log(`[login] Injected ${cookies.length} cookies`);
    }
    await s.goto('https://github.com/');
    let rendered = false;
    for (let i = 0; i < 15; i++) {
      if (await s.page.evaluate('document.readyState === "complete" && document.body?.innerText?.length > 100').catch(() => false)) { rendered = true; break; }
      await s.wait(1);
    }
    if (rendered) { console.log(`[login] Homepage rendered on attempt ${retry + 1}`); break; }
    console.log(`[login] Homepage failed on attempt ${retry + 1}, retrying...`);
  } catch (e) { console.log(`[login] Attempt ${retry + 1} crashed: ${e.message?.slice(0, 100)}`); }
  await s?.close().catch(() => {});
  s = null;
}
if (!s) { console.log('FAIL: homepage never rendered'); process.exit(1); }

try {
  // Check if cookie session already worked
  const sessionCookie = (await s.ctx.cookies()).find(c => c.name === 'user_session' && c.value);
  const url1 = s.page.url?.() ?? '';
  if (sessionCookie && !url1.includes('/login') && !url1.includes('/session')) {
    const hasAvatar = await s.page.evaluate('!!document.querySelector(\'[aria-label*="View profile"], summary img.avatar-user\')').catch(() => false);
    if (hasAvatar) { console.log(`PASS: cookie-first logged in — ${url1}`); process.exit(0); }
  }
  console.log('[login] Cookie session not valid, using password path');

  // Clear the injected stale cookies. With them present, github.com/login
  // treats us as partially-signed-in and redirects to the homepage, where
  // the subsequent fill/submit hit unrelated elements (search box + the
  // Submit-feedback widget) and produce false-positive "logged in" signals.
  await s.ctx.clearCookies();
  await s.goto(URL);
  await s.wait(3);

  // Confirm the login form actually loaded before filling. If we ended up
  // anywhere other than /login or /session/*, something redirected and the
  // form isn't present; bail with a specific error.
  const urlAfterGoto = s.page.url?.() ?? '';
  if (!urlAfterGoto.includes('/login') && !urlAfterGoto.includes('/session')) {
    console.log(`FAIL: goto(${URL}) landed at ${urlAfterGoto} — login form not present`);
    process.exit(1);
  }

  await s.fill('Username or email', '$SVC_EMAIL');
  await s.wait(1);
  await s.fill('Password', '$SVC_PASSWORD');
  await s.wait(1);

  // Submit — match ONLY the login form's submit control (value~="Sign in")
  // to avoid hitting unrelated submit buttons on other pages. Use Playwright
  // locator so the click routes through CDP with isTrusted=true (see
  // docs/DETECTION_ANTIPATTERNS.md §1). Login submit is exactly the kind of
  // event github's spam ML reads isTrusted on.
  // Wait for any submit-type control. GitHub serves either classic
  // <input type="submit" name="commit"> or React <button type="submit">.
  // Avoid :has-text — Playwright's text-engine intermittently fails on
  // GitHub's whitespace-padded button text.
  await s.page.locator('input[type="submit"], button[type="submit"]').first().waitFor({ state: 'attached' });
  const submitLoc = s.page.locator('input[type="submit"][value*="Sign in" i], input[name="commit"], form[action*="/session"] button[type="submit"], button[type="submit"]').first();
  let submitted = { clicked: false };
  if (await submitLoc.count() > 0) {
    submitted = await humanClickLocator(s.page, submitLoc).then(() => ({ clicked: true, via: 'humanClickLocator' })).catch((e) => ({ clicked: false, err: e.message?.slice(0, 100) }));
    if (!submitted.clicked) {
      // Locator.click hit Chromium synthesizeMouseEvent disconnect; submit form
      // via JS instead. Form has action="/session" so requestSubmit triggers POST.
      const jsOk = await s.page.evaluate(`(() => { const f = document.querySelector('form[action*="/session"]'); if (!f) return false; if (typeof f.requestSubmit === 'function') f.requestSubmit(); else f.submit(); return true; })()`).catch(() => false);
      if (jsOk) submitted = { clicked: true, via: 'js-form-submit' };
    }
  }
  console.log(`[login] Submit: ${JSON.stringify(submitted)}`);
  if (!submitted.clicked) {
    console.log('FAIL: no Sign-in submit control found on login page');
    process.exit(1);
  }

  // Wait for redirect
  let url2 = '';
  for (let i = 0; i < 10; i++) {
    await s.wait(2);
    url2 = s.page.url?.() ?? '';
    if (!url2.includes('/login') && !url2.includes('/session')) break;
  }
  console.log(`[login] After submit: ${url2}`);

  // Check for device verification (email code)
  if (url2.includes('sessions/verified-device') || url2.includes('launch_code') || url2.includes('two-factor')) {
    console.log('[login] Device verification required, polling Resend for code...');
    const resendKey = process.env.RESEND_RECEIVING_API_KEY;
    const emailAddr = process.env.SVC_EMAIL;
    let otp = null;
    for (let poll = 0; poll < 20 && !otp; poll++) {
      await s.wait(5);
      const emails = await (await fetch('https://api.resend.com/emails/receiving?limit=10', { headers: { Authorization: `Bearer ${resendKey}` } })).json();
      for (const em of emails.data ?? []) {
        const to = (em.to ?? []).map(t => typeof t === 'string' ? t : t.email).join(',');
        if (!to.includes(emailAddr) || !em.from?.toLowerCase().includes('github')) continue;
        const full = await (await fetch(`https://api.resend.com/emails/receiving/${em.id}`, { headers: { Authorization: `Bearer ${resendKey}` } })).json();
        const body = (full.html ?? '') + (full.text ?? '');
        const m = body.match(/\b(\d{6,8})\b/);
        if (m) { otp = m[1]; break; }
      }
    }
    if (otp) {
      console.log(`[login] Device code: ${otp}`);
      await s.page.evaluate(`(code => {
        const inputs = document.querySelectorAll('input[autocomplete="one-time-code"], input[name*="code"], input[inputmode="numeric"]');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        if (inputs.length === 1) { setter.call(inputs[0], code); inputs[0].dispatchEvent(new Event('input', {bubbles:true})); }
        else if (inputs.length >= code.length) { for (let i = 0; i < code.length; i++) { setter.call(inputs[i], code[i]); inputs[i].dispatchEvent(new Event('input', {bubbles:true})); } }
      })(${JSON.stringify(otp)})`).catch(() => {});
      await s.wait(5);
      url2 = s.page.url?.() ?? '';
      console.log(`[login] After device verify: ${url2}`);
    } else {
      console.log('FAIL: no device verification code received');
      process.exit(1);
    }
  }

  // Verify logged in via fresh user_session cookie. We cleared cookies before
  // form submit, so any user_session present now is from the just-completed
  // password POST → it's proof the session is valid. Avatar-DOM check is
  // unreliable because Chromium can disconnect during the heavy /settings page
  // load before the eval runs.
  const postLoginCookies = await s.ctx.cookies().catch(() => []);
  const sessionCookieFresh = postLoginCookies.find(c => c.name === 'user_session' && c.value);
  const finalUrl = s.page.url?.() ?? '';
  const isLoginPage = finalUrl.includes('/login') || finalUrl.includes('/session');
  if (sessionCookieFresh && !isLoginPage) {
    const finalCookies = postLoginCookies;
    console.log(`PASS: logged in as ${acct.username} — ${finalUrl}`);
    // Persist fresh cookies back to the account
    const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
    if (url && key && acct.id) {
      await fetch(`${url}/rest/v1/social_accounts?id=eq.${acct.id}`, {
        method: 'PATCH',
        headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ metadata: { ...acct.metadata, cookies: finalCookies, cookies_updated_at: new Date().toISOString() } }),
      }).catch(() => {});
    }
  } else {
    // Classify the failure so operators can triage. GitHub returns distinct
    // signals for bad credentials vs anti-abuse vs device-verification gates,
    // but they all funnel through /login eventually.
    const diag = await s.page.evaluate(`(() => {
      const flash = document.querySelector('.flash-error,[role="alert"]')?.innerText?.trim() || '';
      const body = (document.body?.innerText || '').slice(0, 2000);
      let reason = 'unknown';
      if (/Incorrect username or password|incorrect email|Incorrect password/i.test(flash + body)) reason = 'invalid_credentials';
      else if (/suspended|flagged|abuse/i.test(flash + body)) reason = 'account_suspended';
      else if (/unusual activity|verify your device|verification code/i.test(flash + body)) reason = 'device_verification_required';
      else if (/too many|try again later|rate limit/i.test(flash + body)) reason = 'rate_limited';
      else if (/captcha|are you human|puzzle/i.test(flash + body)) reason = 'captcha_required';
      return { reason, flash: flash.slice(0, 200), title: document.title };
    })()`).catch(() => ({ reason: 'unknown', flash: '', title: '' }));
    console.log(`FAIL: not logged in at ${finalUrl} — reason=${diag.reason} flash=${JSON.stringify(diag.flash)} title=${JSON.stringify(diag.title)}`);
    process.exit(1);
  }
} catch (e) {
  // Structured ban_signal so the worker can route this row correctly. Three
  // common failure tails: chrome-error proxy CONNECT, GitHub's account-locked
  // landing, or an opaque agent give_up after the password page wouldn't
  // accept submitted creds.
  try {
    const path = await import('node:path');
    const fs = await import('node:fs');
    const dir = path.join(process.cwd(), 'recordings', 'github_login');
    fs.mkdirSync(dir, { recursive: true });
    const finalUrl = s.page?.url?.() ?? '';
    const msg = e.message ?? '';
    let sig = 'action_failed';
    if (/ERR_HTTP_RESPONSE_CODE_FAILURE|ERR_BLOCKED_BY_RESPONSE|ERR_BLOCKED_BY_CLIENT|ERR_BLOCKED_BY_ADMINISTRATOR/.test(msg)) sig = 'ip_blocked';
    else if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED/.test(msg)) sig = 'proxy_failed';
    else if (finalUrl.startsWith('chrome-error://')) sig = 'proxy_failed';
    else if (/\/account_lockout|\/account\/locked|\/account_recovery|\/sessions\/two-factor|\/sessions\/verified-device/.test(finalUrl)) sig = 'checkpoint';
    fs.writeFileSync(path.join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'github_login', signal: sig, healthy: false, details: { final_url: finalUrl, reason: e.message?.slice(0, 200) ?? 'no message' }, ts: new Date().toISOString() }, null, 2));
  } catch {}
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
