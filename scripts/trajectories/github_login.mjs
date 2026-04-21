import { getSocialAccount } from '../../dist/utils/credentials.js';
import { WSession } from '../../dist/session/wsession.js';

const URL = 'https://github.com/login';

const acct = await getSocialAccount('github');
if (!acct) { console.log('FAIL: no active github account in DB'); process.exit(1); }
if (!acct.metadata.password) { console.log(`FAIL: account ${acct.username} has no password`); process.exit(1); }
process.env.SVC_EMAIL = acct.metadata.email ?? acct.username;
process.env.SVC_PASSWORD = acct.metadata.password;

// GitHub login has no strong residential-IP requirement and repeatedly
// returns ERR_EMPTY_RESPONSE on PacketStream residential — those IPs sit on
// GitHub's abuse list. Default to the account's stored proxy if present,
// otherwise PROXY_URL override, otherwise NO proxy (direct egress). Set
// FORCE_RESIDENTIAL=1 to opt back into the old residential-picker behavior.
const savedProxy = acct.metadata.proxy;
let proxyUrl = process.env.PROXY_URL
  || (process.env.FORCE_RESIDENTIAL === '1' ? 'residential' : undefined);
if (savedProxy?.server && savedProxy?.username) {
  const u = new globalThis.URL(savedProxy.server);
  proxyUrl = `${u.protocol}//${savedProxy.username}:${savedProxy.password}@${u.hostname}:${u.port}`;
  console.log(`[login] Using saved proxy: ${u.hostname}:${u.port} sessid=${savedProxy.username.match(/sessid-(\d+)/)?.[1]}`);
} else if (proxyUrl === undefined) {
  console.log(`[login] No proxy (direct egress from worker IP — GitHub accepts this)`);
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
  // to avoid hitting unrelated submit buttons on other pages.
  const submitted = await s.page.evaluate(`(() => {
    const btn = document.querySelector('input[type="submit"][value*="Sign in" i], input[name="commit"][value*="Sign in" i]');
    if (btn) { btn.click(); return { clicked: true, tag: btn.tagName, value: btn.value || btn.innerText }; }
    const form = document.querySelector('form[action*="/session"]');
    if (form) { form.requestSubmit?.(); return { clicked: 'form' }; }
    return { clicked: false };
  })()`);
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

  // Verify logged in. Cookie presence alone is NOT sufficient — we injected 14
  // stale cookies at session start, so user_session will always be set even
  // when the password path never actually authenticated. Navigate to a page
  // that requires auth (user settings) and confirm the avatar renders, which
  // only happens when the session is valid.
  await s.goto('https://github.com/settings/profile');
  await s.wait(3);
  const finalUrl = s.page.url?.() ?? '';
  const hasAvatar = await s.page.evaluate('!!document.querySelector(\'[aria-label*="View profile"], summary img.avatar-user\')').catch(() => false);
  const isLoginPage = finalUrl.includes('/login') || finalUrl.includes('/session');
  if (hasAvatar && !isLoginPage) {
    const finalCookies = await s.ctx.cookies();
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
    const errText = await s.page.evaluate("(()=>{const e=document.querySelector('.flash-error,[role=\"alert\"]'); return e?e.innerText.trim().slice(0,200):null;})()").catch(() => null);
    console.log(`FAIL: not logged in at ${finalUrl}${errText ? ` — ${errText}` : ''}`);
    process.exit(1);
  }
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
