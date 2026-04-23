// Run PH OAuth in weles browser, capture Set-Cookie via raw CDP Network
// events. CDP events fire from the browser process, not the renderer, so
// we get them even when the renderer dies on /my/captcha_verification.

import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const supaUrl = process.env.SUPABASE_URL ?? '';
const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

async function getAccount(platform) {
  const r = await fetch(`${supaUrl}/rest/v1/social_accounts?platform=eq.${platform}&is_active=eq.true&select=username,metadata&order=created_at.desc&limit=1`,
    { headers: { apikey: supaKey, Authorization: `Bearer ${supaKey}` } }).then(r => r.json());
  return r?.[0];
}

const home = process.env.HOME ?? '';
const exe = [
  join(home, '.local/share/weles-chromium/147.0.7727.108-weles.1/Chromium.app/Contents/MacOS/Chromium'),
  join(home, 'Documents/CodingProjects/Wisent/chromium-build/src/out/Weles/Chromium.app/Contents/MacOS/Chromium'),
].find(p => existsSync(p));

const useStock = process.env.STOCK === '1';
const browser = await chromium.launch(useStock ? { headless: false } : { headless: false, executablePath: exe });
console.log(`[cdp] launched ${useStock ? 'STOCK' : 'WELES'} chromium`);
const ctx = await browser.newContext();

// Block /my/captcha_verification navigation — the browser dies as soon as
// it loads that page. The session cookie is set by the *response* that
// REDIRECTS to it (from /auth/twitter/callback), so by the time we'd be
// asked to render /captcha_verification, we already have the cookie.
await ctx.route('**/my/captcha_verification**', route => {
  console.log(`[cdp] BLOCKED nav to captcha_verification`);
  route.abort();
});

const tw = await getAccount('twitter');
const ph = await getAccount('producthunt');
const twNorm = (tw?.metadata?.cookies ?? []).filter(c => c.name && c.value).map(c => ({
  name: c.name, value: c.value,
  domain: c.domain?.startsWith('.') ? c.domain : (c.domain || '.x.com'),
  path: c.path || '/', secure: c.secure ?? true, httpOnly: c.httpOnly ?? false,
  sameSite: c.sameSite || 'Lax',
  ...(c.expires && c.expires > 0 ? { expires: c.expires } : {}),
}));
await ctx.addCookies([...twNorm, ...twNorm.map(c => ({ ...c, domain: c.domain.replace('x.com', 'twitter.com') }))]);
const phNorm = (ph?.metadata?.cookies ?? []).filter(c => c.name && c.value).map(c => ({
  name: c.name, value: c.value,
  domain: c.domain?.includes('producthunt.com') ? c.domain : '.producthunt.com',
  path: c.path || '/', secure: c.secure ?? true, httpOnly: c.httpOnly ?? false,
  sameSite: c.sameSite || 'Lax',
  ...(c.expires && c.expires > 0 ? { expires: c.expires } : {}),
}));
await ctx.addCookies(phNorm);

const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
await cdp.send('Network.enable');

const requestUrlById = {};
cdp.on('Network.requestWillBeSent', (e) => {
  requestUrlById[e.requestId] = e.request.url;
});

const captured = [];
cdp.on('Network.responseReceivedExtraInfo', (e) => {
  const headers = e.headers || {};
  const url = requestUrlById[e.requestId] || '(unknown)';
  const setCookie = headers['set-cookie'] || headers['Set-Cookie'] || '';
  if (setCookie && url.includes('producthunt.com')) {
    captured.push({ url, setCookie: setCookie.slice(0, 1000) });
    console.log(`[cdp] ${url.slice(0, 70)}: ${setCookie.slice(0, 250).replace(/\n/g, ' || ')}`);
  }
});

console.log('[cdp] OAuth flow start');
await page.goto('https://www.producthunt.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
await new Promise(r => setTimeout(r, 5000));

const c1 = await page.locator('button:has-text("Sign in"), a:has-text("Sign in")').first().click().then(() => 'clicked').catch(e => `err: ${e.message?.slice(0, 80)}`);
console.log(`[cdp] Sign in click: ${c1}`);
await new Promise(r => setTimeout(r, 5000));
// Dump body excerpt after Sign in click to confirm modal
const modalText = await page.evaluate(`(() => (document.body?.innerText || '').slice(0, 400))()`).catch(() => '');
console.log(`[cdp] after Sign in: ${modalText.replace(/\n/g, ' | ').slice(0, 300)}`);

const c2 = await page.locator('button:has-text("Sign in with X"), button:has-text("Sign in with Twitter"), a:has-text("Sign in with X"), a:has-text("Sign in with Twitter")').first().click().then(() => 'clicked').catch(e => `err: ${e.message?.slice(0, 80)}`);
console.log(`[cdp] Sign in with X click: ${c2}`);
// Wait up to 60s for OAuth round-trip (CF challenge + Twitter redirect + callback)
for (let i = 0; i < 30; i++) {
  await new Promise(r => setTimeout(r, 2000));
  const u = page.url();
  console.log(`[cdp] oauth t=${i*2}s url=${u.slice(0, 80)}`);
  if (u.includes('producthunt.com') && !u.includes('/auth/') && !u.includes('twitter.com') && !u.includes('x.com')) break;
  // Click authorize if Twitter shows it
  if (u.includes('twitter.com') || u.includes('x.com')) {
    await page.locator('button:has-text("Authorize"), input[value="Authorize app"]').first().click().catch(() => {});
  }
}
console.log(`[cdp] final url: ${page.url()}`);
for (let i = 0; i < 3; i++) {
  const t = await page.evaluate(`(() => (document.body?.innerText || '').toLowerCase().slice(0, 500))()`).catch(() => '');
  if (t.includes('authorize') || (t.includes('allow') && t.includes('producthunt'))) {
    await page.locator('button:has-text("Authorize"), input[value*="Authorize"]').first().click().catch(() => {});
    await new Promise(r => setTimeout(r, 4000));
  } else break;
}
await new Promise(r => setTimeout(r, 6000));

console.log(`\n[cdp] total captured ${captured.length} producthunt Set-Cookie responses`);
const sessionResp = captured.find(c => c.setCookie.includes('_producthunt_session_production'));
if (sessionResp) {
  const match = sessionResp.setCookie.match(/_producthunt_session_production=([^;\n]+)/);
  console.log(`\n[cdp] SESSION COOKIE from ${sessionResp.url.slice(0, 60)}`);
  console.log(`       value: ${match?.[1]?.slice(0, 60) || 'not parsed'}...`);
} else {
  console.log('[cdp] NO session cookie captured');
}

await browser.close().catch(() => {});
