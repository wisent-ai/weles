import { getSocialAccount, resolveAccountSession } from '../../dist/utils/credentials.js';
import { WSession } from '../../dist/session/wsession.js';
import { execute } from '../../dist/agent/loop.js';
import { humanType } from '../../dist/human/keyboard.js';
import { humanClickLocator, humanIdlePause } from '../../dist/human/mouse.js';

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
  // If we stayed on /foryou, validate logged-in state via sessionid cookie
  // and the absence of "Log in" CTA. Verified 2026-04-29: TikTok renders /foryou
  // for logged-out users with no top-right "Log in" button if the page hasn't
  // fully hydrated yet — checking only the button is unreliable. Require
  // BOTH (no login button AND sessionid cookie) to declare the cookie-first
  // attempt successful. Without the sessionid check, every stale-cookie call
  // produced a false PASS that downstream tiktok_follow / tiktok_like then
  // bailed on with "cookies stale (no sessionid)".
  if (/\/foryou/.test(url)) {
    const loginBtnVisible = await s.page.locator('button:has-text("Log in"), a:has-text("Log in"), [data-e2e="top-login-button"]').first().isVisible().catch(() => false);
    const hasSessionId = await s.page.evaluate(() => document.cookie.includes('sessionid')).catch(() => false);
    if (!loginBtnVisible && hasSessionId) {
      await s.screenshot('cookie_first_ok').catch(() => {});
      return true;
    }
    if (!hasSessionId) console.log('[trajectory] cookie-first failed: no sessionid cookie');
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
    // Deterministic email/password login. Avoids the LLM agent loop when
    // possible (LLM may be out of quota / hitting rate limits / not yet
    // configured). The TikTok login form has stable selectors:
    //   input[name="username"] (email/phone)
    //   input[type="password"]
    //   button[data-e2e="login-button"]
    let loggedIn = false;
    try {
      await s.goto(PASSWORD_URL);
      await s.page.waitForTimeout(3000);
      const emailIn = s.page.locator('input[name="username"], input[type="text"][placeholder*="email" i], input[type="email"]').filter({ visible: true }).first();
      const pwIn = s.page.locator('input[type="password"]').filter({ visible: true }).first();
      await emailIn.waitFor({ state: 'visible', timeout: 15000 });
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
      // Wait for redirect away from /login OR a captcha widget OR an error msg.
      for (let i = 0; i < 30; i++) {
        await s.page.waitForTimeout(1000);
        const u = s.page.url();
        const hasSession = await s.page.evaluate(() => document.cookie.includes('sessionid')).catch(() => false);
        if (hasSession && !/\/login/.test(u)) { loggedIn = true; break; }
        if (/captcha|verify-app|app-download/i.test(u)) break;
      }
    } catch (e) {
      console.log(`[trajectory] deterministic login failed: ${e.message?.slice(0, 200)}`);
    }
    if (loggedIn) {
      console.log('PASS: logged in (deterministic email/password)');
      await captureCookies();
    } else {
      // Last-resort fallback: agent loop. Will fail if LLM out-of-quota; the
      // catch below produces a structured ban_signal.
      const result = await execute(s, `Open ${PASSWORD_URL}. ${GOAL}`, {
        envHints: { SVC_EMAIL: process.env.SVC_EMAIL, SVC_PASSWORD: '***' },
        flowName: 'tiktok_login',
      });
      console.log('PASS:', result.value);
      await captureCookies();
    }
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
