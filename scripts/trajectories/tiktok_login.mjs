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
  // If we stayed on /foryou and there's no top-right "Log in" button visible,
  // the cookies were accepted — the signed-in header hides that CTA entirely.
  if (/\/foryou/.test(url)) {
    const loginBtnVisible = await s.page.locator('button:has-text("Log in"), a:has-text("Log in"), [data-e2e="top-login-button"]').first().isVisible().catch(() => false);
    if (!loginBtnVisible) {
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
    await captureCookies();
  } else {
    await s.goto(PASSWORD_URL);
    const result = await execute(s, `Open ${PASSWORD_URL}. ${GOAL}`, {
      envHints: { SVC_EMAIL: process.env.SVC_EMAIL, SVC_PASSWORD: '***' },
      flowName: 'tiktok_login',
    });
    console.log('PASS:', result.value);
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
    let sig = 'action_failed';
    if (finalUrl.startsWith('chrome-error://')) sig = 'proxy_failed';
    else if (/captcha|verify-app|app-download/i.test(e.message ?? '') || /\/login\/download-app|\/captcha/.test(finalUrl)) sig = 'captcha_challenge';
    else if (/\/login/.test(finalUrl)) sig = 'checkpoint';
    fs.writeFileSync(path.join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'tiktok_login', signal: sig, healthy: false, details: { final_url: finalUrl, reason: e.message?.slice(0, 200) ?? 'no message' }, ts: new Date().toISOString() }, null, 2));
  } catch {}
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
