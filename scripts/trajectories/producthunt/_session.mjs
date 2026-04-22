// Shared session helpers for ProductHunt trajectories.
// findActiveAccount(platform)              -> account row from social_accounts
// injectCookies(s, cookies, defaultDomain) -> populates BrowserContext cookies
// loginViaTwitter(s)                       -> re-runs Twitter SSO + handles PH captcha gate

import { CaptchaSolver } from '../../../dist/captcha/solver.js';

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

export async function injectCookies(s, cookies, defaultDomain) {
  const norm = cookies
    .filter(c => c.name && c.value)
    .map(c => ({
      name: c.name, value: c.value,
      domain: c.domain?.startsWith('.') || c.domain?.includes('.') ? c.domain : defaultDomain,
      path: c.path || '/', secure: c.secure ?? true,
      httpOnly: c.httpOnly ?? false, sameSite: c.sameSite || 'Lax',
      ...(c.expires && c.expires > 0 ? { expires: c.expires } : {}),
    }));
  await s.ctx.addCookies(norm);
  return norm.length;
}

async function injectTwitterCookies(s, cookies) {
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

async function clearCaptchaGate(s) {
  const MAX_ATTEMPTS = 2;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const u = s.page.url?.() ?? '';
    if (!u.includes('/captcha_verification')) return true;
    console.log(`[ph-session] captcha gate (attempt ${attempt}/${MAX_ATTEMPTS})`);
    const sitekey = await s.page.evaluate(`(() => {
      var ifr = document.querySelector('iframe[src*="recaptcha/api2/anchor"]') || document.querySelector('iframe[src*="recaptcha"]');
      if (!ifr) return null;
      var m = (ifr.getAttribute('src') || '').match(/[?&]k=([^&]+)/);
      return m ? m[1] : null;
    })()`).catch(() => null);
    if (!sitekey) { await sleep(3); continue; }
    const solver = new CaptchaSolver();
    const token = await solver.solveRecaptchaV2(s.page, sitekey).catch(() => null);
    if (!token || typeof token !== 'string') throw new Error('recaptcha_no_token');
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
      var btns = Array.from(document.querySelectorAll('button[type="submit"], button'));
      for (var b of btns) {
        var t = (b.textContent || '').trim().toLowerCase();
        if (t === 'verify me!' || t === 'verify' || t === 'submit') {
          b.disabled = false; b.classList.remove('cursor-not-allowed','opacity-50'); b.click(); return;
        }
      }
    })()`).catch(() => {});
    await sleep(6);
  }
  const u = s.page.url?.() ?? '';
  if (u.includes('/captcha_verification')) throw new Error('captcha_gate_not_cleared');
  return true;
}

export async function loginViaTwitter(s) {
  console.log('[ph-session] performing Twitter SSO login');
  const tw = await findActiveAccount('twitter');
  if (!tw) throw new Error('no_twitter_account_for_relogin');
  const twCookies = tw.metadata?.cookies ?? [];
  if (twCookies.length < 2) throw new Error('twitter_account_missing_cookies');
  console.log(`[ph-session] using twitter account ${tw.username}`);
  await injectTwitterCookies(s, twCookies);

  await s.goto('https://www.producthunt.com/');
  await sleep(3);
  await s.click('Sign in').catch(() => {});
  await sleep(2);
  await s.click('Continue with Twitter').catch(() => {});
  await s.click('Continue with X').catch(() => {});
  await s.click('Sign in with Twitter').catch(() => {});
  await sleep(6);
  for (let i = 0; i < 3; i++) {
    const t = (await s.page.evaluate(`(() => (document.body?.innerText ?? '').toLowerCase().substring(0, 1000))()`).catch(() => '')) || '';
    if (t.includes('authorize') || t.includes('allow')) {
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
  await clearCaptchaGate(s);
  return true;
}
