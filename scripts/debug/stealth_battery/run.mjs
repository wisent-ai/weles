// Visit public bot-detection sites and extract each site's verdict so we can
// compare weles-147 scores against real Chrome 147 on the same Mac (and against
// CloakBrowser's published numbers).
//
// Usage:
//   CHROMIUM_PATH=... FORCE_BROWSER=chromium node scripts/debug/stealth_battery/run.mjs > weles_battery.json
//   USE_REAL_CHROME=1 node scripts/debug/stealth_battery/run.mjs > real_chrome_battery.json

import { WSession } from '../../../dist/session/wsession.js';
import { chromium as pwChromium } from 'playwright';
import { humanIdlePause } from '../../../dist/human/mouse.js';

const useReal = process.env.USE_REAL_CHROME === '1';
const results = { capturedAt: new Date().toISOString(), source: useReal ? 'real-chrome-147' : 'weles-147', sites: {} };

let browser, ctx, page, close;
if (useReal) {
  browser = await pwChromium.launch({ channel: 'chrome', headless: false });
  ctx = await browser.newContext();
  page = await ctx.newPage();
  close = async () => { try { await browser.close(); } catch {} };
} else {
  const s = await WSession.start({ label: 'stealth_battery', proxy: 'none' });
  page = s.page;
  close = async () => { try { await s.close(); } catch {} };
}

async function gotoSafe(url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await humanIdlePause('deliberate');
    return true;
  } catch (e) { return { err: e.message?.slice(0, 200) }; }
}

try {
  const t0 = await gotoSafe('https://tls.peet.ws/api/all');
  if (t0 === true) {
    const raw = await page.evaluate('document.body.innerText || document.body.textContent || ""');
    try {
      const j = JSON.parse(raw);
      results.sites.tls_peet = { ja3_hash: j.tls?.ja3_hash, ja4: j.tls?.ja4, peetprint_hash: j.tls?.peetprint_hash, akamai_fingerprint_hash: j.http2?.akamai_fingerprint_hash, userAgent: (j.headers?.['user-agent'] || ''), httpVersion: j.http_version };
    } catch { results.sites.tls_peet = { raw: raw.slice(0, 400) }; }
  } else results.sites.tls_peet = t0;

  const t1 = await gotoSafe('https://bot.incolumitas.com/');
  if (t1 === true) {
    await humanIdlePause('long');
    const inc = await page.evaluate(() => {
      const pick = sel => { const el = document.querySelector(sel); return el ? el.innerText || el.textContent : null; };
      return { intoli: pick('#new-tests'), fpjs: pick('#fp2'), fingerprintDetails: pick('#fingerprint-details'), bodyLen: (document.body.innerText || '').length };
    });
    results.sites.incolumitas = inc;
  } else results.sites.incolumitas = t1;

  const t2 = await gotoSafe('https://www.browserscan.net/bot-detection');
  if (t2 === true) {
    await humanIdlePause('long');
    const bs = await page.evaluate(() => {
      const body = document.body.innerText || '';
      const verdictMatch = body.match(/(NORMAL|BOT|SUSPICIOUS)/i);
      return { verdict: verdictMatch?.[1], bodySnippet: body.replace(/\s+/g, ' ').slice(0, 1500) };
    });
    results.sites.browserscan = bs;
  } else results.sites.browserscan = t2;

  const t3 = await gotoSafe('https://deviceandbrowserinfo.com/info_device');
  if (t3 === true) {
    await humanIdlePause('deliberate');
    const dbi = await page.evaluate(() => {
      const body = document.body.innerText || '';
      const trueFlags = (body.match(/\btrue\b/g) || []).length;
      const isBotMatch = body.match(/isBot[^a-z]*:?[^a-z]*(true|false)/i);
      return { bytes: body.length, trueFlagCount: trueFlags, isBot: isBotMatch?.[1] || null, snippet: body.slice(0, 800) };
    });
    results.sites.deviceandbrowserinfo = dbi;
  } else results.sites.deviceandbrowserinfo = t3;

  const t4 = await gotoSafe('about:blank');
  if (t4 === true) {
    const basic = await page.evaluate(() => ({
      webdriver: navigator.webdriver,
      pluginsLength: navigator.plugins.length,
      chromeObj: typeof window.chrome,
      chromeRuntime: typeof window.chrome?.runtime,
      userAgent: navigator.userAgent,
      ownPropsCount: Object.getOwnPropertyNames(window).length,
      hasSanitizer: 'Sanitizer' in window,
      hasAnimationTrigger: 'AnimationTrigger' in window,
      hasTimelineTrigger: 'TimelineTrigger' in window,
      uaData: navigator.userAgentData ? { brands: navigator.userAgentData.brands, mobile: navigator.userAgentData.mobile, platform: navigator.userAgentData.platform } : null,
    }));
    results.sites.basic = basic;
  }
} finally {
  await close();
}

console.log(JSON.stringify(results, null, 2));
