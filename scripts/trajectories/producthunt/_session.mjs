// Shared session helpers for ProductHunt trajectories.
//
// PH gates fresh OAuth sessions through reCAPTCHA at /my/captcha_verification.
// What looked like a "browser crash" was actually a Playwright CDP disconnect
// triggered by WSession's heavy event interception + recordVideo during the
// reCAPTCHA iframe's out-of-process render-target swap. A plain
// chromium.launch() with the weles binary survives the captcha page fine.
//
// So loginViaTwitter() runs OAuth + captcha clear in a plain browser, then
// hands the resulting captcha-cleared cookies back to the WSession context.

import { chromium } from 'playwright';
import { existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getCaptchaCredentials } from '../../../dist/utils/credentials.js';
import { generate, toConfig, toCppConfig } from '../../../dist/fingerprint.js';

const CHROMIUM_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--disable-dev-shm-usage',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-infobars',
  '--window-position=0,0',
];

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

function findWelesBinary() {
  const home = process.env.HOME ?? '';
  const candidates = [
    join(home, '.local/share/weles-chromium/147.0.7727.108-weles.1/Chromium.app/Contents/MacOS/Chromium'),
    join(home, 'Documents/CodingProjects/Wisent/chromium-build/src/out/Weles/Chromium.app/Contents/MacOS/Chromium'),
    '/opt/chromium/Chromium',
  ];
  return candidates.find(p => existsSync(p));
}

// Run the entire OAuth + captcha clear in a PLAIN playwright/weles browser
// with the full weles fingerprint config (so Cloudflare passes), but no
// WSession overhead (no recordVideo, no aggressive request listeners) so
// the CDP connection survives PH's reCAPTCHA iframe load.
// Returns the cleared producthunt cookies.
export async function clearCaptchaInPlainBrowser(ptCookies, twCookies) {
  const executablePath = findWelesBinary();
  if (!executablePath) throw new Error('weles_binary_not_found');
  // Apply the same fingerprint stack as WSession: write toCppConfig to a temp
  // file and pass via --weles-fingerprint=<path>. This is what makes weles
  // pass Cloudflare on /auth/* endpoints.
  const fp = generate('macos');
  const fpConfig = toConfig(fp, 'macos', 'chromium');
  const cppConfig = toCppConfig(fpConfig, 'macos');
  const fpDir = mkdtempSync(join(tmpdir(), 'weles-fp-ph-'));
  const fpFile = join(fpDir, 'config.json');
  writeFileSync(fpFile, JSON.stringify(cppConfig));
  const args = [...CHROMIUM_ARGS, `--weles-fingerprint=${fpFile}`];
  console.log(`[ph-session] launching plain weles browser (fp=${fpFile})`);
  const browser = await chromium.launch({
    headless: false,
    executablePath,
    args,
    ignoreDefaultArgs: ['--enable-automation', '--enable-unsafe-swiftshader', '--disable-breakpad'],
  });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await injectCookies(ctx, ptCookies, '.producthunt.com');
    await injectTwitterCookies(ctx, twCookies);
    const page = await ctx.newPage();

    await page.goto('https://www.producthunt.com/', { waitUntil: 'domcontentloaded' });
    await sleep(3);
    await page.locator('button:has-text("Sign in"), a:has-text("Sign in")').first().click().catch(() => {});
    await sleep(3);
    await page.locator('button:has-text("Sign in with X"), button:has-text("Continue with Twitter")').first().click().catch(() => {});
    await sleep(8);
    for (let i = 0; i < 3; i++) {
      const t = await page.evaluate(`(() => (document.body?.innerText || '').toLowerCase().slice(0, 800))()`).catch(() => '');
      if (t.includes('authorize') || (t.includes('allow') && t.includes('producthunt'))) {
        await page.locator('button:has-text("Authorize"), input[value*="Authorize"]').first().click().catch(() => {});
        await sleep(4);
      } else break;
    }
    for (let i = 0; i < 20; i++) {
      const u = page.url();
      if (u.includes('producthunt.com') && !u.includes('/auth/') && !u.includes('twitter.com') && !u.includes('x.com')) break;
      await sleep(2);
    }
    const u = page.url();
    // Snapshot cookies immediately after OAuth lands (before the browser has
    // any chance to disconnect during subsequent steps)
    let cookieSnapshot = [];
    try { cookieSnapshot = await ctx.cookies('https://www.producthunt.com/'); } catch (e) { console.log(`[ph-session] cookie snapshot err: ${e.message?.slice(0, 80)}`); }
    console.log(`[ph-session] snapshot ${cookieSnapshot.length} cookies after OAuth`);
    if (!u.includes('/captcha_verification')) {
      console.log(`[ph-session] no captcha gate; landed at: ${u}`);
      return cookieSnapshot.length > 0 ? cookieSnapshot : await ctx.cookies('https://www.producthunt.com/').catch(() => []);
    }

    console.log('[ph-session] on captcha page — solving + clicking Verify me!');
    await page.waitForSelector('iframe[src*="recaptcha/api2/anchor"]').catch(() => {});
    await sleep(3);
    const sitekey = await page.evaluate(`(() => {
      var ifr = document.querySelector('iframe[src*="recaptcha/api2/anchor"]');
      if (!ifr) return null;
      var m = (ifr.getAttribute('src') || '').match(/[?&]k=([^&]+)/);
      return m ? m[1] : null;
    })()`);
    if (!sitekey) throw new Error('sitekey_not_extracted');
    console.log(`[ph-session] sitekey: ${sitekey}`);

    const token = await solveRecaptchaV2WithUrl(u, sitekey);
    if (!token) throw new Error('anticaptcha_no_token');
    console.log(`[ph-session] token: ${token.slice(0, 20)}...`);

    // Stay on the captcha page — the Referer matters for PH's anti-bot check.
    // Install a request interceptor FIRST so when React fires the real click
    // we capture its exact body (which we can replay if this path fails).
    const captured = [];
    page.on('request', (req) => {
      if (req.method() === 'POST' && req.url().includes('/frontend/graphql')) {
        captured.push({ headers: req.headers(), body: req.postData()?.slice(0, 2000) });
      }
    });

    // Inject token + fire reCAPTCHA callback so React enables + clicks on our behalf
    await page.evaluate(`(() => {
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
    await page.waitForFunction(`(() => {
      var b = Array.from(document.querySelectorAll('button[type="submit"]')).find(b => /verify me/i.test(b.textContent || ''));
      return b && !b.disabled;
    })`).catch(() => {});
    await page.locator('button:has-text("Verify me!")').first().click().catch((e) => console.log(`[ph-session] verify click: ${e.message?.slice(0, 80)}`));
    await sleep(6);

    if (captured.length > 0) {
      console.log(`[ph-session] CAPTURED real submit:`);
      for (const c of captured) {
        console.log(`  headers: ${JSON.stringify(c.headers).slice(0, 400)}`);
        console.log(`  body: ${c.body?.slice(0, 600)}`);
      }
    } else {
      console.log('[ph-session] no real submit captured — falling back to manual fetch');
    }

    // Post-capture: did URL change away from captcha page?
    for (let i = 0; i < 10; i++) {
      const newUrl = page.url();
      if (!newUrl.includes('/captcha_verification')) {
        console.log(`[ph-session] captcha cleared via React click, now at: ${newUrl}`);
        return await ctx.cookies('https://www.producthunt.com/');
      }
      await sleep(2);
    }

    // If click didn't clear, navigate to safe page and try manual fetch with captured headers
    await page.goto('https://www.producthunt.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await sleep(2);
    const graphqlRes = await page.evaluate(`(async () => {
      var query = 'mutation UserVerify($input: UserRecaptchaEnterInput!) { response: userRecaptchaEnter(input: $input) { node errors { field messages } } }';
      var body = JSON.stringify([{
        operationName: 'UserVerify',
        query: query,
        variables: { input: { gRecaptchaResponse: ${JSON.stringify(token)} } },
      }]);
      try {
        var r = await fetch('/frontend/graphql', {
          method: 'POST', credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'Accept': '*/*',
            'X-Requested-With': 'XMLHttpRequest',
            'X-PH-Timezone': Intl.DateTimeFormat().resolvedOptions().timeZone,
            'X-PH-Referer': 'https://www.producthunt.com/my/captcha_verification',
          },
          body: body,
        });
        var text = await r.text();
        return { status: r.status, body: text.slice(0, 800) };
      } catch (e) { return { error: (e.message || '').slice(0, 200) }; }
    })()`).catch((e) => ({ error: e.message?.slice(0, 200) }));
    console.log(`[ph-session] UserVerify mutation: ${JSON.stringify(graphqlRes)}`);

    // Verify by navigating to a /my/* page
    await page.goto('https://www.producthunt.com/my/details/edit', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await sleep(3);
    const verifyUrl = page.url();
    console.log(`[ph-session] post-mutation nav: ${verifyUrl}`);
    if (verifyUrl.includes('/captcha_verification')) throw new Error('captcha_did_not_clear_after_graphql');
    return await ctx.cookies('https://www.producthunt.com/');
  } finally {
    await browser.close().catch(() => {});
  }
}

export async function loginViaTwitter(s) {
  const tw = await findActiveAccount('twitter');
  if (!tw) throw new Error('no_twitter_account');
  const twCookies = tw.metadata?.cookies ?? [];
  if (twCookies.length < 2) throw new Error('twitter_account_missing_cookies');
  const ph = await findActiveAccount('producthunt');
  const ptCookies = ph?.metadata?.cookies ?? [];

  const cleared = await clearCaptchaInPlainBrowser(ptCookies, twCookies);
  await s.ctx.clearCookies({ domain: '.producthunt.com' }).catch(() => {});
  await s.ctx.clearCookies({ domain: 'www.producthunt.com' }).catch(() => {});
  await s.ctx.addCookies(cleared);
  console.log(`[ph-session] re-injected ${cleared.length} cleared cookies into WSession`);
  return true;
}
