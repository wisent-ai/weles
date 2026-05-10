// Run PH OAuth in weles browser, capture Set-Cookie via raw CDP Network
// events. CDP events fire from the browser process, not the renderer, so
// we get them even when the renderer dies on /my/captcha_verification.

import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { humanIdlePause } from '../../../dist/human/mouse.js';

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
const launchOpts = useStock ? { headless: false } : { headless: false, executablePath: exe };
launchOpts.args = ['--enable-logging=stderr', '--v=1', '--vmodule=*crash*=2,*render_process*=2,*cdp*=2'];

// Use weles's real fingerprint rotation — every run gets a fresh fingerprint
if (!useStock) {
  const { generate, toConfig, toCppConfig } = await import('../../../dist/fingerprint.js');
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const fp = generate('macos');
  const fpConfig = toConfig(fp, 'macos', 'chromium');
  const cppConfig = toCppConfig(fpConfig, 'macos');
  const fpDir = mkdtempSync(join(tmpdir(), 'weles-fp-probe-'));
  const fpFile = join(fpDir, 'config.json');
  writeFileSync(fpFile, JSON.stringify(cppConfig));
  launchOpts.args.push(`--weles-fingerprint=${fpFile}`);
  launchOpts.ignoreDefaultArgs = ['--enable-automation', '--enable-unsafe-swiftshader', '--disable-breakpad'];
  console.log(`[cdp] FRESH fingerprint: ua=${cppConfig.navigator?.userAgent?.slice(0, 60)}... cpu=${cppConfig.navigator?.hardwareConcurrency}`);
}
if (process.env.PROXY_URL && process.env.PROXY_URL !== 'none') {
  const { resolveProxy } = await import('../../../dist/proxy/config.js');
  const p = await resolveProxy(process.env.PROXY_URL);
  if (p) { launchOpts.proxy = p; launchOpts.ignoreHTTPSErrors = true; console.log(`[cdp] using proxy: ${p.server}`); }
}
const browser = await chromium.launch(launchOpts);
console.log(`[cdp] launched ${useStock ? 'STOCK' : 'WELES'} chromium`);
const proc = (browser)?.process?.();
if (proc) {
  proc.stderr?.on('data', c => {
    const s = c.toString().trim();
    if (s && (s.includes('Render') || s.includes('CRASH') || s.includes('GPU') || s.includes('SIG') || s.includes('abort') || s.includes('Check failed') || s.includes('DCHECK'))) {
      console.log(`[STDERR] ${s.slice(0, 300)}`);
    }
  });
  proc.on('exit', (code, sig) => console.log(`[PROC] exit code=${code} sig=${sig}`));
}
const ctx = await browser.newContext();


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

// Capture console + page errors so we can see what CF's challenge JS reports
page.on('console', msg => {
  const type = msg.type();
  if (type === 'error' || type === 'warning') console.log(`[console:${type}] ${msg.text().slice(0, 300)}`);
});
page.on('pageerror', err => console.log(`[pageerror] ${err.message?.slice(0, 300)}`));
cdp.on('Log.entryAdded', (e) => {
  if (e.entry.level === 'error' || e.entry.level === 'warning') console.log(`[log:${e.entry.level}] ${e.entry.text?.slice(0, 300)}`);
});
await cdp.send('Log.enable');

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
await humanIdlePause('long');

const c1 = await page.locator('button:has-text("Sign in"), a:has-text("Sign in")').first().click().then(() => 'clicked').catch(e => `err: ${e.message?.slice(0, 80)}`);
console.log(`[cdp] Sign in click: ${c1}`);
await humanIdlePause('long');
const modalText = await page.evaluate(`(() => (document.body?.innerText || '').slice(0, 400))()`).catch(() => '');
console.log(`[cdp] after Sign in: ${modalText.replace(/\n/g, ' | ').slice(0, 300)}`);

// Find the modal + try multiple text variants; retry if first pass fails
let c2 = 'not-yet';
for (let attempt = 0; attempt < 3; attempt++) {
  c2 = await page.evaluate(`(() => {
    var els = Array.from(document.querySelectorAll('button, a'));
    for (var el of els) {
      var t = (el.textContent || '').trim();
      if (/^Sign in with X$|^Continue with Twitter$|^Sign in with Twitter$/i.test(t)) {
        el.scrollIntoView({ block: 'center' });
        el.click();
        return 'clicked-js: ' + t;
      }
    }
    return 'button-not-found';
  })()`).catch((e) => `err: ${e.message?.slice(0, 80)}`);
  console.log(`[cdp] Sign in with X click (attempt ${attempt}): ${c2}`);
  if (c2.startsWith('clicked')) break;
  await new Promise(r => setTimeout(r, 3000));  // allow-raw-playwright: polling/rate-limit loop
}
// Wait up to 60s for OAuth round-trip (CF challenge + Twitter redirect + callback)
for (let i = 0; i < 30; i++) {
  await new Promise(r => setTimeout(r, 2000));  // allow-raw-playwright: polling/rate-limit loop
  const u = page.url();
  if (i % 4 === 0) {
    const body = await page.evaluate(`(() => (document.body?.innerText || '').slice(0, 300))()`).catch(() => '');
    console.log(`[cdp] oauth t=${i*2}s url=${u.slice(0, 80)} body="${body.replace(/\n/g, ' | ').slice(0, 200)}"`);
  }
  if (u.includes('producthunt.com') && !u.includes('/auth/') && !u.includes('twitter.com') && !u.includes('x.com')) break;
  if (u.includes('twitter.com') || u.includes('x.com')) {
    const clicked = await page.locator('button:has-text("Authorize"), input[value="Authorize app"], [data-testid="OAuth_Consent_Button"]').first().click().then(() => 'CLICKED-AUTHORIZE').catch(() => null);
    if (clicked) console.log(`[cdp] ${clicked}`);
  }
}
console.log(`[cdp] final url: ${page.url()}`);
for (let i = 0; i < 3; i++) {
  const t = await page.evaluate(`(() => (document.body?.innerText || '').toLowerCase().slice(0, 500))()`).catch(() => '');
  if (t.includes('authorize') || (t.includes('allow') && t.includes('producthunt'))) {
    await page.locator('button:has-text("Authorize"), input[value*="Authorize"]').first().click().catch(() => {});
    await new Promise(r => setTimeout(r, 4000));  // allow-raw-playwright: polling/rate-limit loop
  } else break;
}
await humanIdlePause('long');

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
