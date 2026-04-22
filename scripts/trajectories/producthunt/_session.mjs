// Shared session helpers for ProductHunt trajectories.
// findActiveAccount(platform)                -> account row from social_accounts
// injectCookies(ctx, cookies, defaultDomain) -> populates BrowserContext cookies
// loginViaTwitter(page, ctx)                 -> re-runs Twitter SSO + clears PH captcha
// openStandardBrowser()                      -> playwright's bundled Chromium
//
// Why two captcha strategies coexist:
//  - The weles custom Chromium passes Cloudflare's JS challenge (fingerprint
//    stealth) but disconnects when reCAPTCHA's iframe loads on PH's
//    /my/captcha_verification page.
//  - Playwright's stock Chromium handles reCAPTCHA fine but Cloudflare flags
//    it as a bot and blocks /my/details/edit behind a JS challenge.
//
// clearCaptchaGate() therefore extracts the sitekey FAST (before the iframe
// finishes loading and the renderer dies), then navigates the page away to
// a safe URL, solves the token via AntiCaptcha, and submits the captcha
// verification using ctx.request.post() — no browser rendering required.

import { chromium } from 'playwright';
import { CaptchaSolver } from '../../../dist/captcha/solver.js';
import { getCaptchaCredentials } from '../../../dist/utils/credentials.js';

// Solve a reCAPTCHA v2 with an explicit website URL — the built-in
// CaptchaSolver reads page.url() at solve time, which is wrong when we have
// to navigate away from the captcha page to avoid a renderer crash during
// the AntiCaptcha poll wait.
async function solveRecaptchaV2WithUrl(websiteURL, sitekey) {
  const creds = await getCaptchaCredentials();
  const apiKey = creds.anticaptcha;
  if (!apiKey) throw new Error('no_anticaptcha_key');
  const create = await (await fetch('https://api.anti-captcha.com/createTask', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientKey: apiKey, task: { type: 'RecaptchaV2TaskProxyless', websiteURL, websiteKey: sitekey } }),
  })).json();
  if (create.errorId) throw new Error(`anticaptcha_create: ${create.errorCode} ${create.errorDescription}`);
  const taskId = create.taskId;
  console.log(`[ph-session] anticaptcha taskId=${taskId} for url=${websiteURL.slice(0, 60)}`);
  for (let i = 0; i < 60; i++) {
    await sleep(5);
    const r = await (await fetch('https://api.anti-captcha.com/getTaskResult', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: apiKey, taskId }),
    })).json();
    if (r.status === 'ready') return r.solution?.gRecaptchaResponse ?? null;
    if (r.errorId) throw new Error(`anticaptcha_result: ${r.errorCode} ${r.errorDescription}`);
  }
  return null;
}

const sleep = (sec) => new Promise(r => setTimeout(r, sec * 1000));

export async function findActiveAccount(platform) {
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
  if (!supabaseUrl || !supabaseKey) return null;
  const res = await fetch(
    `${supabaseUrl}/rest/v1/social_accounts?platform=eq.${platform}&is_active=eq.true&select=id,platform,username,metadata&order=created_at.desc&limit=20`,
    { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } },
  );
  if (!res.ok) return null;
  const rows = await res.json();
  for (const a of rows) {
    if (Array.isArray(a.metadata?.cookies) && a.metadata.cookies.length >= 1) return a;
  }
  return rows[0] ?? null;
}

export async function injectCookies(ctx, cookies, defaultDomain) {
  const norm = cookies
    .filter(c => c.name && c.value)
    .map(c => ({
      name: c.name, value: c.value,
      domain: c.domain?.startsWith('.') || c.domain?.includes('.') ? c.domain : defaultDomain,
      path: c.path || '/', secure: c.secure ?? true,
      httpOnly: c.httpOnly ?? false, sameSite: c.sameSite || 'Lax',
      ...(c.expires && c.expires > 0 ? { expires: c.expires } : {}),
    }));
  await ctx.addCookies(norm);
  return norm.length;
}

export async function openStandardBrowser({ headless = false } = {}) {
  const browser = await chromium.launch({ headless });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
  });
  const page = await ctx.newPage();
  return { browser, ctx, page };
}

// Launch the weles custom Chromium (passes Cloudflare via fingerprint stealth).
// Used for PH /my/* admin pages where Cloudflare's JS challenge would otherwise
// block stock playwright Chromium.
export async function openWelesBrowser({ headless = false } = {}) {
  const home = process.env.HOME ?? '';
  const candidates = [
    `${home}/.local/share/weles-chromium/147.0.7727.108-weles.1/Chromium.app/Contents/MacOS/Chromium`,
    `${home}/Documents/CodingProjects/Wisent/chromium-build/src/out/Weles/Chromium.app/Contents/MacOS/Chromium`,
  ];
  const fs = await import('node:fs');
  const executablePath = candidates.find(p => fs.existsSync(p));
  if (!executablePath) throw new Error('weles_chromium_not_found');
  const browser = await chromium.launch({ headless, executablePath });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
  });
  const page = await ctx.newPage();
  return { browser, ctx, page };
}

async function injectTwitterCookies(ctx, cookies) {
  const norm = cookies.filter(c => c.name && c.value).map(c => ({
    name: c.name, value: c.value,
    domain: c.domain?.startsWith('.') ? c.domain : (c.domain || '.x.com'),
    path: c.path || '/', secure: c.secure ?? true,
    httpOnly: c.httpOnly ?? false, sameSite: c.sameSite || 'Lax',
    ...(c.expires && c.expires > 0 ? { expires: c.expires } : {}),
  }));
  const twCom = norm.map(c => ({ ...c, domain: c.domain.replace('x.com', 'twitter.com') }));
  await ctx.addCookies([...norm, ...twCom]);
}

async function clearCaptchaGate(page, ctx) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const u = page.url();
    if (!u.includes('/captcha_verification')) return true;
    console.log(`[ph-session] captcha gate (attempt ${attempt}/3)`);
    // Race condition: the reCAPTCHA iframe must mount enough for us to see its
    // src (which carries the sitekey), but we must escape the page before the
    // iframe fully renders or the weles renderer crashes. ~2s is the sweet spot.
    await sleep(2);
    const sitekey = await page.evaluate(`(() => {
      var ifr = document.querySelector('iframe[src*="recaptcha/api2/anchor"]') || document.querySelector('iframe[src*="recaptcha"]');
      if (!ifr) return null;
      var m = (ifr.getAttribute('src') || '').match(/[?&]k=([^&]+)/);
      return m ? m[1] : null;
    })()`).catch(() => null);
    if (!sitekey) {
      // Iframe not mounted yet — wait a moment and retry; don't loiter on the page.
      await sleep(2);
      continue;
    }
    console.log(`[ph-session] sitekey: ${sitekey}`);
    const captchaUrl = u;
    // Escape the crashy page immediately so the renderer survives the solver wait.
    await page.goto('about:blank').catch(() => {});

    // Solve via direct AntiCaptcha API call so we can pass the captcha URL
    // explicitly (the page is now on about:blank).
    const token = await solveRecaptchaV2WithUrl(captchaUrl, sitekey).catch((e) => {
      console.log(`[ph-session] solver error: ${e.message?.slice(0, 100)}`);
      return null;
    });
    if (!token || typeof token !== 'string') throw new Error('recaptcha_no_token');
    console.log(`[ph-session] token: ${token.slice(0, 20)}...`);

    // Submit the captcha verification via context.request — this uses the same
    // cookie jar as the browser but doesn't need to render the captcha page.
    const csrfToken = (await ctx.cookies('https://www.producthunt.com/')).find(c => c.name === 'csrf_token')?.value;
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Origin': 'https://www.producthunt.com',
      'Referer': captchaUrl,
      ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
    };
    const body = new URLSearchParams({ 'g-recaptcha-response': token });
    if (csrfToken) body.set('_csrf_token', csrfToken);
    const resp = await ctx.request.post(captchaUrl, { headers, data: body.toString(), maxRedirects: 0 }).catch((e) => ({ status: () => 0, error: e.message?.slice(0, 100) }));
    const status = typeof resp.status === 'function' ? resp.status() : 0;
    const loc = typeof resp.headers === 'function' ? (resp.headers()['location'] || '') : '';
    console.log(`[ph-session] captcha POST: status=${status} location=${loc.slice(0, 80)}${resp.error ? ' err=' + resp.error : ''}`);

    // Now navigate back to PH — the verification cookie should be set on the context
    await page.goto('https://www.producthunt.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await sleep(3);
    const newUrl = page.url();
    console.log(`[ph-session] after captcha submit: ${newUrl}`);
    if (!newUrl.includes('/captcha_verification')) return true;
  }
  throw new Error('captcha_gate_not_cleared');
}

export async function loginViaTwitter(s) {
  // s is a WSession — we use s.click for vision-supported clicking and reach
  // s.page / s.ctx for the escape-and-POST captcha flow.
  console.log('[ph-session] performing Twitter SSO login');
  const tw = await findActiveAccount('twitter');
  if (!tw) throw new Error('no_twitter_account_for_relogin');
  const twCookies = tw.metadata?.cookies ?? [];
  if (twCookies.length < 2) throw new Error('twitter_account_missing_cookies');
  console.log(`[ph-session] using twitter account ${tw.username}`);
  await injectTwitterCookies(s.ctx, twCookies);

  await s.goto('https://www.producthunt.com/');
  await sleep(3);
  await s.click('Sign in').catch(() => {});
  await sleep(2);
  await s.click('Continue with Twitter').catch(() => {});
  await s.click('Continue with X').catch(() => {});
  await s.click('Sign in with Twitter').catch(() => {});
  await sleep(6);
  for (let i = 0; i < 3; i++) {
    const t = await s.page.evaluate(`(() => (document.body?.innerText ?? '').toLowerCase().substring(0, 1000))()`).catch(() => '');
    if (t.includes('authorize') || (t.includes('allow') && t.includes('producthunt'))) {
      await s.click('Authorize app').catch(() => {});
      await s.click('Authorize').catch(() => {});
      await s.click('Allow').catch(() => {});
      await sleep(4);
    } else break;
  }
  for (let i = 0; i < 15; i++) {
    const u = s.page.url?.() ?? '';
    if (u.includes('producthunt.com') && !u.includes('/login') && !u.includes('twitter.com') && !u.includes('x.com')) break;
    await sleep(2);
  }
  await clearCaptchaGate(s.page, s.ctx);
  return true;
}
