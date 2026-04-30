import { getSocialAccount, resolveAccountSession } from '../../dist/utils/credentials.js';
import { WSession } from '../../dist/session/wsession.js';
import { humanType } from '../../dist/human/keyboard.js';
import { humanClickLocator, humanIdlePause } from '../../dist/human/mouse.js';

const PASSWORD_URL = 'https://www.tiktok.com/login/phone-or-email/email';
const FEED_URL = 'https://www.tiktok.com/foryou';

const acct = await getSocialAccount('tiktok');
if (!acct) { console.log('FAIL: no active tiktok account in DB'); process.exit(1); }
process.env.SVC_EMAIL = acct.metadata.email ?? acct.username;
process.env.SVC_PASSWORD = acct.metadata.password ?? '';
console.log(`[trajectory] Using account: ${acct.username}`);

const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'tiktok_login', proxy: proxyUrl, persona });

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
  // Give the TikTok SPA time to hydrate the nav rail + top bar before we
  // probe for logged-in markers.
  await new Promise((r) => setTimeout(r, 4000));

  const url = s.page.url();
  // If the browser was redirected to /login or /passport, the server rejected
  // our cookies and we're not authed.
  if (/\/login|\/passport/i.test(url)) {
    await s.screenshot('cookie_first_redirected_to_login').catch(() => {});
    return false;
  }
  // Definitive auth check: navigate to /messages — TikTok hard-redirects
  // unauthenticated users to /login?redirect_url=/messages here. The /foryou
  // page on its own is a *lying* indicator: TikTok serves /foryou (with
  // public videos) to logged-out users too, so "stayed on /foryou" was
  // always a false positive.
  //
  // Verified 2026-04-29: user9903356330248 had sessionid in cookies, /foryou
  // didn't bounce, BUT /messages redirected to /login — proving the saved
  // session was NOT actually authenticated. The msToken cookie had expired
  // ~2 months prior (saved 2026-02, current date 2026-04). TikTok's auth
  // requires BOTH a fresh msToken AND sessionid; only sessionid was valid.
  await s.page.goto('https://www.tiktok.com/messages', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await new Promise((r) => setTimeout(r, 4000));
  const messagesUrl = s.page.url();
  if (/\/login|\/passport/i.test(messagesUrl)) {
    console.log(`[trajectory] cookie-first failed: /messages redirected to ${messagesUrl}`);
    await s.screenshot('cookie_first_messages_login_redirect').catch(() => {});
    return false;
  }
  // /messages stayed put — session is genuinely authenticated.
  await s.screenshot('cookie_first_ok').catch(() => {});
  return true;
}

try {
  const cookieOk = await tryCookieFirstLogin();
  if (cookieOk) {
    console.log('PASS: logged in (cookie-first)');
    await captureCookies();
  } else {
    // Deterministic email/password login. The TikTok login form has stable selectors:
    //   input[name="username"] (email/phone)
    //   input[type="password"]
    //   button[data-e2e="login-button"]
    await s.goto(PASSWORD_URL);
    const emailIn = s.page.locator('input[name="username"], input[type="text"][placeholder*="email" i], input[type="email"]').filter({ visible: true }).first();
    const pwIn = s.page.locator('input[type="password"]').filter({ visible: true }).first();
    await emailIn.waitFor({ state: 'visible' });
    await humanClickLocator(s.page, emailIn);
    await humanIdlePause('short');
    await humanType(s.page, process.env.SVC_EMAIL);
    await humanIdlePause('short');
    await humanClickLocator(s.page, pwIn);
    await humanIdlePause('short');
    await humanType(s.page, process.env.SVC_PASSWORD);
    await humanIdlePause('short');
    const submitBtn = s.page.locator('button[data-e2e="login-button"], button[type="submit"]').filter({ visible: true }).first();
    await humanClickLocator(s.page, submitBtn);
    // Wait for sessionid cookie + navigation away from /login. If the login
    // does not complete (wrong credentials, server error, captcha), this
    // throws after Playwright's default and the outer catch persists
    // ban_signal with classified reason from final URL.
    await s.page.waitForFunction(() => document.cookie.includes('sessionid') && !location.pathname.startsWith('/login'));
    console.log('PASS: logged in (deterministic email/password)');
    await captureCookies();
  }
} catch (e) {
  // Structured ban_signal so the worker doesn't fall back to 'unknown_error'.
  // TikTok login fails commonly at chrome-error proxy CONNECT, captcha widget
  // (SadCaptcha-gated), or error_code:7 rate-limit on register_verify_login.
  try {
    const path = await import('node:path');
    const fs = await import('node:fs');
    const dir = path.join(process.cwd(), 'recordings', 'tiktok_login');
    fs.mkdirSync(dir, { recursive: true });
    const finalUrl = s?.page?.url?.() ?? '';
    const msg = e.message ?? '';
    let sig = 'action_failed';
    if (/ERR_HTTP_RESPONSE_CODE_FAILURE|ERR_BLOCKED_BY_RESPONSE|ERR_BLOCKED_BY_CLIENT|ERR_BLOCKED_BY_ADMINISTRATOR/.test(msg)) sig = 'ip_blocked';
    else if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED/.test(msg)) sig = 'proxy_failed';
    else if (finalUrl.startsWith('chrome-error://')) sig = 'proxy_failed';
    else if (/captcha|verify-app|app-download/i.test(msg) || /\/login\/download-app|\/captcha/.test(finalUrl)) sig = 'captcha_challenge';
    else if (/\/login/.test(finalUrl)) sig = 'checkpoint';
    fs.writeFileSync(path.join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'tiktok_login', signal: sig, healthy: false, details: { final_url: finalUrl, reason: e.message?.slice(0, 200) ?? 'no message' }, ts: new Date().toISOString() }, null, 2));
  } catch {}
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
