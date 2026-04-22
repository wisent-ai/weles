// Shared session helpers for ProductHunt trajectories.
// findActiveAccount(platform)                -> account row from social_accounts
// injectCookies(ctx, cookies, defaultDomain) -> populates BrowserContext cookies
// loginViaTwitter(s)                          -> re-runs Twitter SSO + clears PH captcha
//
// PH gates fresh OAuth sessions through reCAPTCHA at /my/captcha_verification.
// The weles custom Chromium passes Cloudflare's JS challenge but disconnects
// when reCAPTCHA's iframe loads (same crash class as Instagram). So:
//   1. Drive the OAuth click sequence in the weles browser (passes Cloudflare).
//   2. As soon as we land on /captcha_verification, extract the sitekey within
//      ~2s before the iframe finishes loading and the renderer dies.
//   3. Navigate the page to about:blank to keep the renderer alive while
//      AntiCaptcha solves.
//   4. POST the captcha verification using ctx.request.post() — no browser
//      rendering required. Try several POST shapes (Rails forms typically
//      need authenticity_token + commit field; some apps accept JSON).

import { getCaptchaCredentials } from '../../../dist/utils/credentials.js';

const sleep = (sec) => new Promise(r => setTimeout(r, sec * 1000));

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
  console.log(`[ph-session] anticaptcha taskId=${taskId} for ${websiteURL.slice(0, 60)}`);
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

// POST captcha verification from WITHIN the browser context (the page must
// be on a safe same-origin URL, e.g. producthunt.com home). This way the
// request uses the browser's real TLS fingerprint + Cloudflare cookies, which
// playwright's Node-side ctx.request cannot replicate.
async function postCaptchaVerificationInPage(page, captchaPath, token) {
  return await page.evaluate(`(async () => {
    var token = ${JSON.stringify(token)};
    var path = ${JSON.stringify(captchaPath)};
    var csrf = (document.cookie.match(/(?:^|; )csrf_token=([^;]+)/) || [])[1];
    var attempts = [
      { name: 'rails-form-redirect-follow',
        opts: { method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'text/html', ...(csrf ? { 'X-CSRF-Token': decodeURIComponent(csrf) } : {}) },
          body: new URLSearchParams({ 'g-recaptcha-response': token, ...(csrf ? { authenticity_token: decodeURIComponent(csrf) } : {}), commit: 'Verify me!' }).toString() } },
    ];
    var results = [];
    for (var a of attempts) {
      try {
        var r = await fetch(path, { ...a.opts, redirect: 'follow' });
        var bodyHead = '';
        try { bodyHead = (await r.text()).slice(0, 600); } catch (e) {}
        var redirectedTo = r.url;
        results.push({ name: a.name, status: r.status, redirected: r.redirected, finalUrl: redirectedTo, body: bodyHead });
        // Success means we actually redirected away from /captcha_verification
        if (r.status >= 200 && r.status < 400 && !redirectedTo.includes('/captcha_verification')) {
          return { success: true, results: results };
        }
      } catch (e) {
        results.push({ name: a.name, error: (e.message || '').slice(0, 100) });
      }
    }
    return { success: false, results: results };
  })()`).catch((e) => ({ success: false, error: e.message?.slice(0, 100) }));
}

export async function loginViaTwitter(s) {
  console.log('[ph-session] performing Twitter SSO login via weles browser');
  const tw = await findActiveAccount('twitter');
  if (!tw) throw new Error('no_twitter_account');
  const twCookies = tw.metadata?.cookies ?? [];
  if (twCookies.length < 2) throw new Error('twitter_account_missing_cookies');
  console.log(`[ph-session] using twitter account ${tw.username}`);
  await injectTwitterCookies(s.ctx, twCookies);

  await s.goto('https://www.producthunt.com/');
  await sleep(3);
  await s.click('Sign in').catch(() => {});
  await sleep(2);
  await s.click('Sign in with X').catch(() => {});
  await s.click('Continue with Twitter').catch(() => {});
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
  for (let i = 0; i < 20; i++) {
    const u = s.page.url?.() ?? '';
    if (u.includes('producthunt.com') && !u.includes('/auth/') && !u.includes('twitter.com') && !u.includes('x.com')) break;
    await sleep(2);
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const u = s.page.url?.() ?? '';
    if (!u.includes('/captcha_verification')) return true;
    console.log(`[ph-session] captcha gate (attempt ${attempt}/3)`);
    await sleep(2);
    const sitekey = await s.page.evaluate(`(() => {
      var ifr = document.querySelector('iframe[src*="recaptcha/api2/anchor"]') || document.querySelector('iframe[src*="recaptcha"]');
      if (!ifr) return null;
      var m = (ifr.getAttribute('src') || '').match(/[?&]k=([^&]+)/);
      return m ? m[1] : null;
    })()`).catch(() => null);
    if (!sitekey) { await sleep(2); continue; }
    console.log(`[ph-session] sitekey: ${sitekey}`);
    const captchaUrl = u;
    // Solve while ON the captcha page — race the renderer crash. AntiCaptcha
    // v2 typically returns in ~30s; the weles crash usually happens at ~30-60s.
    // Set up request interception so when we click "Verify me!" with the token
    // injected, we capture the actual API URL PH's React app POSTs to.
    const capturedRequests = [];
    s.page.on('request', (req) => {
      const url = req.url();
      if (req.method() === 'POST' && (url.includes('producthunt.com') || url.includes('captcha'))) {
        capturedRequests.push({ url, headers: req.headers(), body: req.postData()?.slice(0, 500) });
      }
    });

    const token = await solveRecaptchaV2WithUrl(captchaUrl, sitekey).catch((e) => { console.log(`[ph-session] solver: ${e.message?.slice(0, 100)}`); return null; });
    if (!token) throw new Error('recaptcha_no_token');
    console.log(`[ph-session] token: ${token.slice(0, 20)}...`);

    // Page may have crashed by now; check
    if (s.page.isClosed?.()) {
      console.log(`[ph-session] page crashed during solve; falling back to in-page POST after navigating to home`);
      // Open a new page in the same context (cookies preserved), navigate to PH home (CF-friendly),
      // then POST from that fresh page
      const newPage = await s.ctx.newPage();
      await newPage.goto('https://www.producthunt.com/').catch(() => {});
      await sleep(2);
      const captchaPath = new URL(captchaUrl).pathname + new URL(captchaUrl).search;
      const result = await postCaptchaVerificationInPage(newPage, captchaPath, token);
      console.log(`[ph-session] post-crash POST: ${JSON.stringify(result).slice(0, 300)}`);
      await newPage.close().catch(() => {});
      if (result.success) return true;
      await sleep(3);
      continue;
    }

    // Page still alive: inject token + fire callbacks + click "Verify me!" — captures the real request via interception
    await s.page.evaluate(`(() => {
      var token = ${JSON.stringify(token)};
      document.querySelectorAll('textarea[name="g-recaptcha-response"], #g-recaptcha-response').forEach(function(ta) {
        ta.value = token;
        ta.dispatchEvent(new Event('change', { bubbles: true }));
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      });
      function walk(o, d) { if (!o || typeof o !== 'object' || d > 8) return;
        for (var k in o) { try { var v = o[k]; if (k === 'callback' && typeof v === 'function') v(token); else if (v && typeof v === 'object') walk(v, d + 1); } catch (e) {} }
      }
      if (window.___grecaptcha_cfg && window.___grecaptcha_cfg.clients) walk(window.___grecaptcha_cfg.clients, 0);
    })()`).catch(() => {});
    await sleep(2);
    await s.page.evaluate(`(() => {
      var b = Array.from(document.querySelectorAll('button[type="submit"]')).find(b => /verify me/i.test(b.textContent || ''));
      if (b) { b.disabled = false; b.classList.remove('cursor-not-allowed','opacity-50'); b.click(); }
    })()`).catch(() => {});
    await sleep(8);
    console.log(`[ph-session] captured POST requests: ${JSON.stringify(capturedRequests).slice(0, 600)}`);
    const newUrl = s.page.url?.() ?? '';
    if (!newUrl.includes('/captcha_verification')) {
      console.log(`[ph-session] captcha cleared by in-page click, now at: ${newUrl}`);
      return true;
    }
  }
  throw new Error('captcha_gate_not_cleared');
}
