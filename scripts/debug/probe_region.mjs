// Probe TikTok's /passport/web/region/ from inside the page context.
// Runs only under the custom Weles browser boundary.

import { WSession } from '../../dist/session/wsession.js';
import { generatePersona } from '../../dist/browser/persona.js';
import { humanIdlePause } from '../../dist/human/mouse.js';

const browser = process.env.PROBE_BROWSER;  // 'chromium' | 'firefox' | undefined (random)
const persona = generatePersona({ country: 'US', browser });
const s = await WSession.start({ label: 'probe_region', proxy: process.env.PROBE_PROXY || undefined, persona });
try {
  if (process.env.PROBE_MODE === 'request-only') {
    const hdrs = { 'Content-Type': 'application/x-www-form-urlencoded', 'Origin': 'https://www.tiktok.com', 'Referer': 'https://www.tiktok.com/signup/phone-or-email/email', 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.6112.40 Safari/537.36' };
    const region = await s.ctx.request.post('https://us.tiktok.com/passport/web/region/?aid=1988&app_language=en-GB&app_name=tiktok_web', { headers: hdrs, data: 'hashed_id=a&type=2&aid=1459' });
    console.log(`region status=${region.status()} body=${(await region.text()).slice(0, 200)}`);

    // Try send_code. mix_mode=1 email= in hex per TikTok's obfuscation (XOR with 5? simple). Let's first try plain.
    const testEmail = 'probe' + Math.floor(Math.random() * 99999) + '@mailwisent.com';
    const send = await s.ctx.request.post('https://us.tiktok.com/passport/web/email/send_code/?multi_login=1&aid=1988&app_language=en-GB&app_name=tiktok_web', {
      headers: hdrs,
      data: `mix_mode=1&email=${encodeURIComponent(testEmail)}&password=&type=34&aid=1459&is_sso=false&account_sdk_source=web&region=US&language=en&locale=en-GB`,
    });
    console.log(`send_code status=${send.status()} body=${(await send.text()).slice(0, 300)}`);
    console.log(`test_email=${testEmail}`);
    await s.close().catch(() => {});
    process.exit(0);
  }
  // Passive capture of the PAGE's natural /passport/web/region/ POSTs
  // (with full signed msToken/X-Bogus/X-Gnarly headers). This is what
  // TikTok's edge actually evaluates — the manual fetch below uses the
  // wrong code path and returns error_code:7 instead of country_code.
  const regionPosts = [];
  s.page.on('response', async (r) => {
    try {
      const u = r.url();
      if (!/\/passport\/web\/region\//.test(u)) return;
      let body = '';
      try { body = await r.text(); } catch {}
      regionPosts.push({ host: u.split('/')[2], status: r.status(), body });
    } catch {}
  });
  // Optional warm-up loop: visit /foryou for WARMUP_SECS to age cookies
  // before the /signup load. WARMUP_SECS=0 reproduces no-warm baseline.
  const WARMUP_SECS = Number(process.env.WARMUP_SECS || 0);
  if (WARMUP_SECS > 0) {
    console.log(`[probe] warming on /foryou for ${WARMUP_SECS}s`);
    await s.page.goto('https://www.tiktok.com/foryou', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await new Promise(r => setTimeout(r, WARMUP_SECS * 1000));  // allow-raw-playwright: review — context-dependent timer
  }
  await s.page.goto('https://www.tiktok.com/signup/phone-or-email/email', { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');
  console.log(`[probe] PASSIVE region/ POSTs captured: ${regionPosts.length}`);
  for (const r of regionPosts) {
    const m = (r.body || '').match(/"country_code":"([^"]*)"/);
    console.log(`  ${r.host} status=${r.status} country_code=${m ? m[1] : '?'} bodyLen=${(r.body||'').length}`);
  }

  if (process.env.CLEAR_COOKIES === '1') {
    const before = await s.ctx.cookies();
    console.log(`COOKIES BEFORE clear: ${before.length} total`);
    await s.ctx.clearCookies();
    const after = await s.ctx.cookies();
    console.log(`COOKIES AFTER clear: ${after.length} total`);
  }
  const allCookies = await s.ctx.cookies();
  const interesting = allCookies.filter(c => /ttwid|odin_tt|msToken|passport_csrf|tt_csrf|tt_chain|store-idc|store-country|tea_id/i.test(c.name));
  console.log('COOKIES set by TikTok after goto:');
  for (const c of interesting) console.log(`  ${c.name} = ${c.value.slice(0, 80)} (httpOnly=${c.httpOnly})`);

  const result = await s.page.evaluate(async () => {
    const res = await fetch('https://us.tiktok.com/passport/web/region/?aid=1988&app_language=en-GB&app_name=tiktok_web', {
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'hashed_id=a&type=2&aid=1459',
    });
    const text = await res.text();
    const headers = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    return { status: res.status, bodyLen: text.length, body: text, headers };
  });

  console.log('ENVIRONMENT: CUSTOM_CHROMIUM');
  console.log('status:', result.status);
  console.log('body length:', result.bodyLen);
  console.log('body:', result.body.slice(0, 800));
  console.log('response headers:', JSON.stringify(result.headers, null, 2));
} catch (e) {
  console.error('ERR:', e.message?.slice(0, 300));
} finally {
  await s.close().catch(() => {});
}
