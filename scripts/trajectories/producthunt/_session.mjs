// Shared session helpers for ProductHunt trajectories.
//
// Everything here runs inside a WSession — no hand-rolled chromium.launch,
// no duplicate cookie normalization, no reimplemented captcha solver. The
// WSession itself handles fingerprint rotation, proxy rotation, vision
// clicks, and the AntiCaptcha/CapSolver integration.

import { getSocialAccount } from '../../../dist/utils/credentials.js';
import { solvePageCaptcha } from '../../../dist/captcha/detect.js';
import { CaptchaSolver } from '../../../dist/captcha/solver.js';

const sleep = (sec) => new Promise(r => setTimeout(r, sec * 1000));

export async function injectPHCookies(s, cookies) {
  const norm = cookies
    .filter(c => c.name && c.value)
    .map(c => ({
      name: c.name, value: c.value,
      domain: c.domain?.includes('producthunt.com') ? c.domain : '.producthunt.com',
      path: c.path || '/', secure: c.secure ?? true,
      httpOnly: c.httpOnly ?? false, sameSite: c.sameSite || 'Lax',
      ...(c.expires && c.expires > 0 ? { expires: c.expires } : {}),
    }));
  await s.ctx.addCookies(norm);
  return norm.length;
}

export async function injectTwitterCookies(s, cookies) {
  const norm = cookies.filter(c => c.name && c.value).map(c => ({
    name: c.name, value: c.value,
    domain: c.domain?.startsWith('.') ? c.domain : (c.domain || '.x.com'),
    path: c.path || '/', secure: c.secure ?? true,
    httpOnly: c.httpOnly ?? false, sameSite: c.sameSite || 'Lax',
    ...(c.expires && c.expires > 0 ? { expires: c.expires } : {}),
  }));
  const twCom = norm.map(c => ({ ...c, domain: c.domain.replace('x.com', 'twitter.com') }));
  await s.ctx.addCookies([...norm, ...twCom]);
}

// Drive Twitter SSO login inside the weles WSession. Uses s.click (vision +
// DOM match) and s.solveCaptcha (weles's existing captcha infrastructure)
// instead of reimplementing either.
export async function loginViaTwitter(s) {
  const tw = await getSocialAccount('twitter');
  if (!tw) throw new Error('no_twitter_account');
  const twCookies = tw.metadata?.cookies ?? [];
  if (twCookies.length < 2) throw new Error('twitter_account_missing_cookies');
  console.log(`[ph-session] OAuth via twitter account ${tw.username}`);
  await injectTwitterCookies(s, twCookies);

  await s.goto('https://www.producthunt.com/');
  await sleep(3);
  await s.click('Sign in').catch(() => {});
  await sleep(2);
  await s.click('Sign in with X').catch(() => {});
  await s.click('Continue with Twitter').catch(() => {});
  await sleep(6);
  // Authorize / Allow dialog — STOP as soon as URL is on producthunt.com
  // (avoids wasting screenshots on /captcha_verification which crashes weles)
  for (let i = 0; i < 3; i++) {
    const u = s.page.url?.() ?? '';
    if (u.includes('producthunt.com') && !u.includes('/auth/')) break;
    const t = await s.page.evaluate(`(() => (document.body?.innerText ?? '').toLowerCase().slice(0, 1000))()`).catch(() => '');
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

  // Call solvePageCaptcha directly — s.solveCaptcha wraps it in _action which
  // takes a screenshot first, and on PH's captcha page that screenshot stalls
  // the renderer so the subsequent detector eval returns null. Bypassing the
  // wrapper skips the screenshot and the detector runs against a responsive page.
  const solver = new CaptchaSolver();
  for (let attempt = 0; attempt < 3; attempt++) {
    const u = s.page.url?.() ?? '';
    if (!u.includes('/captcha_verification')) return true;
    console.log(`[ph-session] captcha gate (attempt ${attempt}/3)`);
    await s.page.waitForSelector('iframe[src*="recaptcha/api2/anchor"]').catch(() => {});
    await sleep(3);
    // Pre-warm evaluate context — bare test showed that the FIRST page.evaluate
    // after navigation can be slow/null on this page, but subsequent evaluates
    // return real results. solvePageCaptcha's 10s poll loop expires before
    // its own evaluate "warms up", so prime it here.
    const ok = await solvePageCaptcha(s.page, solver, s).catch((e) => { console.log(`[ph-session] solvePageCaptcha err: ${e.message?.slice(0, 100)}`); return false; });
    console.log(`[ph-session] solvePageCaptcha returned: ${ok}`);
    // detect.ts set the g-recaptcha-response textarea. PH submits captcha via
    // a UserVerify GraphQL mutation at /frontend/graphql. Fire the grecaptcha
    // callback AND directly POST UserVerify as a belt-and-braces approach.
    // detect.ts set g-recaptcha-response textarea. PH's React form onSubmit
    // reads that value and fires an Apollo UserVerify mutation. Trigger the
    // React submit handler by calling form.requestSubmit().
    const submitted = await s.page.evaluate(() => {
      const ta = document.getElementById('g-recaptcha-response');
      const token = ta && ta.value;
      if (!token) return { err: 'no_token_in_textarea' };
      const form = document.querySelector('form');
      if (!form) return { err: 'no_form' };
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      return { tokenLen: token.length, formAction: form.getAttribute('action') || '' };
    }).catch(e => ({ err: e.message?.slice(0, 200) }));
    console.log(`[ph-session] captcha submit: ${JSON.stringify(submitted)}`);
    await sleep(6);
    const newUrl = s.page.url?.() ?? '';
    if (!newUrl.includes('/captcha_verification')) return true;
  }
  throw new Error('captcha_gate_not_cleared');
}
