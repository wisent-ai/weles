// Drive the PH OAuth -> captcha_verification flow using WSession, then on the
// captcha page dump the FULL iframe[src] for all recaptcha-related iframes.
// Goal: figure out why detect.ts's querySelectorAll loop finds zero matches
// while the pre-warm page.evaluate on the SAME session reports iframes=3,
// hasRecaptcha=true.
import { WSession } from '../../../dist/session/wsession.js';
import { getSocialAccount, resolveAccountSession } from '../../../dist/utils/credentials.js';
import { injectPHCookies } from '../../trajectories/producthunt/_session.mjs';
import { injectProviderCookies } from '../../../dist/platforms/_shared/cross_platform_oauth.js';

const sleep = (s) => new Promise(r => setTimeout(r, s * 1000));

const acct = await getSocialAccount('producthunt');
const tw = await getSocialAccount('twitter');
const opts = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'ph_iframe_dump', ...opts });

try {
  if (tw?.metadata?.cookies) await injectProviderCookies(s.ctx, 'twitter', tw.metadata.cookies);
  if (acct?.metadata?.cookies) await injectPHCookies(s, acct.metadata.cookies);
  await s.goto('https://www.producthunt.com/');
  await sleep(3);
  await s.click('Sign in').catch(() => {});
  await sleep(2);
  await s.click('Sign in with X').catch(() => {});
  await s.click('Continue with Twitter').catch(() => {});
  await sleep(8);
  for (let i = 0; i < 15; i++) {
    const u = s.page.url?.() ?? '';
    if (u.includes('/captcha_verification')) break;
    await sleep(2);
  }
  console.log(`[dump] url = ${s.page.url()}`);
  await sleep(5);

  const dump = await s.page.evaluate(`(() => {
    var list = [];
    var all = Array.from(document.querySelectorAll('iframe'));
    for (var f of all) {
      list.push({
        src: (f.getAttribute('src') || '').slice(0, 220),
        name: f.getAttribute('name') || '',
        title: f.getAttribute('title') || '',
        dataSitekey: f.getAttribute('data-sitekey') || '',
        visible: f.offsetWidth > 0 && f.offsetHeight > 0,
      });
    }
    var divs = Array.from(document.querySelectorAll('.g-recaptcha')).map(d => ({
      dataSitekey: d.getAttribute('data-sitekey') || '',
      id: d.id || '',
    }));
    return { iframes: list, gRecaptchaDivs: divs, bodyTextHead: (document.body?.innerText || '').slice(0, 200) };
  })()`).catch(e => ({ error: e.message }));

  console.log('[dump] raw iframe snapshot:');
  console.log(JSON.stringify(dump, null, 2));

  const detectQuery = await s.page.evaluate(`(() => {
    var rcFrames = Array.from(document.querySelectorAll('iframe[src*="recaptcha"]'));
    var results = [];
    for (var f of rcFrames) {
      var src = f.getAttribute('src') || '';
      var km = src.match(/[?&]k=([^&]+)/);
      results.push({ src: src.slice(0, 200), hasK: !!km, kValue: km ? km[1] : null });
    }
    return { rcCount: rcFrames.length, results };
  })()`).catch(e => ({ error: e.message }));
  console.log('[dump] detect.ts-style query result:');
  console.log(JSON.stringify(detectQuery, null, 2));
} finally {
  await s.close().catch(() => {});
}
