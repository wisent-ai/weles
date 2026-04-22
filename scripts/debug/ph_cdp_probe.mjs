import { chromium } from 'playwright';

const exe = process.env.HOME + '/Documents/CodingProjects/Wisent/chromium-build/src/out/Weles/Chromium.app/Contents/MacOS/Chromium';
const mode = process.argv[2] || 'plain';

const launchOpts = { headless: false, executablePath: exe };
if (mode === 'args' || mode === 'fp') {
  launchOpts.args = [
    '--disable-blink-features=AutomationControlled',
    '--disable-dev-shm-usage',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-infobars',
    '--window-position=0,0',
  ];
  launchOpts.ignoreDefaultArgs = ['--enable-automation', '--enable-unsafe-swiftshader', '--disable-breakpad'];
}
if (mode === 'fp') {
  const { generate, toConfig, toCppConfig } = await import('../../dist/fingerprint.js');
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const fp = generate('macos');
  const fpConfig = toConfig(fp, 'macos', 'chromium');
  const cppConfig = toCppConfig(fpConfig, 'macos');
  const fpDir = mkdtempSync(join(tmpdir(), 'weles-fp-probe-'));
  const fpFile = join(fpDir, 'config.json');
  writeFileSync(fpFile, JSON.stringify(cppConfig));
  launchOpts.args.push(`--weles-fingerprint=${fpFile}`);
  console.log('[probe] fp config written:', fpFile);
}

console.log(`[probe] mode=${mode} launching weles binary`);
const browser = await chromium.launch(launchOpts);
browser.on('disconnected', () => console.log('[probe] BROWSER disconnected'));
const ctx = await browser.newContext();
const page = await ctx.newPage();
page.on('crash', () => console.log('[probe] PAGE crash'));
page.on('close', () => console.log('[probe] PAGE close'));

// PROBE_GRAPHQL=1 captures the headers PH's Apollo client sends on any
// /frontend/graphql POST (visit homepage, wait for graphql requests to fire).
if (process.env.PROBE_GRAPHQL === '1') {
  let count = 0;
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().includes('/frontend/graphql')) {
      count++;
      const h = req.headers();
      console.log(`\n=== GraphQL POST #${count} ===\nURL: ${req.url()}\nHeaders:`);
      for (const [k, v] of Object.entries(h)) {
        if (!k.startsWith(':')) console.log(`  ${k}: ${String(v).slice(0, 200)}`);
      }
      const body = req.postData() || '';
      try {
        const parsed = JSON.parse(body);
        if (Array.isArray(parsed)) {
          console.log(`Body: BATCH of ${parsed.length} ops`);
          parsed.slice(0, 3).forEach((op, i) => console.log(`  op[${i}]: ${op.operationName}`));
        } else {
          console.log(`Body operationName: ${parsed.operationName}`);
        }
      } catch (e) {}
    }
  });
  await page.goto('https://www.producthunt.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await new Promise(r => setTimeout(r, 10000));
  console.log(`\n[probe] total graphql POSTs: ${count}`);
  await browser.close();
  process.exit(0);
}

if (process.env.PROBE_OAUTH === '1') {
  console.log('[probe] simulating OAuth navigation history before captcha page');
  await page.goto('https://www.producthunt.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await new Promise(r => setTimeout(r, 2000));
  await page.goto('https://www.producthunt.com/auth/twitter?origin=%2F', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await new Promise(r => setTimeout(r, 3000));
}

// PROBE_COOKIES=1 injects PH + Twitter cookies for the most-recent producthunt
// account in the DB. Tests whether cookied (auth-recognized) requests trigger
// PH to render the heavy captcha challenge iframe that idle requests don't.
if (process.env.PROBE_COOKIES === '1') {
  const supaUrl = process.env.SUPABASE_URL ?? '';
  const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (supaUrl && supaKey) {
    for (const platform of ['producthunt', 'twitter']) {
      const r = await fetch(`${supaUrl}/rest/v1/social_accounts?platform=eq.${platform}&is_active=eq.true&select=username,metadata&order=created_at.desc&limit=1`, { headers: { apikey: supaKey, Authorization: `Bearer ${supaKey}` } }).then(r => r.json());
      const cs = r?.[0]?.metadata?.cookies ?? [];
      console.log(`[probe] injecting ${cs.length} ${platform} cookies (acct=${r?.[0]?.username})`);
      const norm = cs.filter(c => c.name && c.value).map(c => ({
        name: c.name, value: c.value,
        domain: c.domain || (platform === 'producthunt' ? '.producthunt.com' : '.x.com'),
        path: c.path || '/', secure: c.secure ?? true,
        httpOnly: c.httpOnly ?? false, sameSite: c.sameSite || 'Lax',
        ...(c.expires && c.expires > 0 ? { expires: c.expires } : {}),
      }));
      await ctx.addCookies(norm).catch(e => console.log(`[probe] cookie inject err: ${e.message?.slice(0, 80)}`));
    }
  }
}

console.log('[probe] navigating to captcha page');
await page.goto('https://www.producthunt.com/my/captcha_verification', { waitUntil: 'domcontentloaded' }).catch(e => console.log('[probe] goto err:', e.message?.slice(0, 100)));

// Optional concurrent fetch — simulates the AntiCaptcha solver poll loop
// happening alongside the captcha page being open
if (process.env.PROBE_FETCH === '1') {
  console.log('[probe] starting concurrent fetch loop to anti-captcha.com');
  (async () => {
    for (let i = 0; i < 12; i++) {
      try {
        await fetch('https://api.anti-captcha.com/', { method: 'GET' });
        console.log(`[probe-fetch] t=${i*5}s fetched`);
      } catch (e) {
        console.log(`[probe-fetch] t=${i*5}s err: ${e.message?.slice(0, 60)}`);
      }
      await new Promise(r => setTimeout(r, 5000));
    }
  })();
}

for (let i = 0; i < 30; i++) {
  await new Promise(r => setTimeout(r, 2000));
  try {
    const url = page.url();
    const isClosed = page.isClosed();
    console.log(`[probe] t=${(i+1)*2}s url=${url.slice(0, 50)} closed=${isClosed}`);
    if (isClosed) break;
  } catch (e) {
    console.log(`[probe] t=${(i+1)*2}s POLL ERR: ${e.message?.slice(0, 100)}`);
    break;
  }
}
console.log('[probe] done');
await browser.close().catch(() => {});
