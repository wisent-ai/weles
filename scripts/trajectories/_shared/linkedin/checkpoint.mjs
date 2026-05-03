import { CaptchaSolver } from '../../../../dist/captcha/solver.js';

const RECAPTCHA_SITEKEY = '6LcIy_MqAAAAAMKiupFSbmzW3xjGSlIfRzNWYMjC';
const CHECKPOINT_RE = /\/(checkpoint|uas\/login|login\/recovery)/;
const SUBMIT_CLICK_MS = 3 * 1000;
const POST_SOLVE_NAV_MS = 15 * 1000;

export async function solveLinkedinCheckpoint({ ctx, page }, reason) {
  let cookies = await ctx.cookies();
  let liAt = cookies.find((c) => c.name === 'li_at' && c.value);
  let finalUrl = page.url?.() ?? '';
  if (process.env.WELES_NOPECHA_EXT === '1' && !liAt && CHECKPOINT_RE.test(finalUrl)) {
    console.log(`[linkedin_login] ${reason} waiting for NopeCha extension to solve checkpoint in-page (90s max)`);
    for (let i = 0; i < 18; i++) {
      await page.waitForTimeout(5000);
      cookies = await ctx.cookies();
      liAt = cookies.find((c) => c.name === 'li_at' && c.value);
      finalUrl = page.url?.() ?? '';
      if (liAt) { console.log(`[linkedin_login] NopeCha solved! li_at present after ${(i + 1) * 5}s`); break; }
      if (!CHECKPOINT_RE.test(finalUrl)) { console.log(`[linkedin_login] NopeCha solved! URL left checkpoint after ${(i + 1) * 5}s -> ${finalUrl}`); break; }
    }
    if (liAt) return { liAt, finalUrl };
  }
  for (let attempt = 0; attempt < 3 && !liAt && CHECKPOINT_RE.test(finalUrl); attempt++) {
    console.log(`[linkedin_login] ${reason} solve attempt ${attempt + 1}/3 (reCAPTCHA Enterprise V2 token)`);
    const result = await new CaptchaSolver().solveRecaptchaV2(page, RECAPTCHA_SITEKEY, { enterprise: true });
    // Image-grid path returns true when the captcha frame detaches —
    // LinkedIn accepted the solution and the form auto-submits, so the
    // parent context is mid-navigation. Read state defensively: any of
    // page.url / page.waitForLoadState / ctx.cookies can throw if the
    // navigation has already torn down the previous frame tree.
    if (result === true) {
      console.log(`[linkedin_login] V2 enterprise solved in-page (frame detached)`);
      const navMs = POST_SOLVE_NAV_MS;
      try { await page.waitForLoadState('domcontentloaded', { timeout: navMs }); } catch {}
      try { cookies = await ctx.cookies(); } catch {}
      liAt = cookies.find((c) => c.name === 'li_at' && c.value);
      try { finalUrl = page.url?.() ?? finalUrl; } catch {}
      if (liAt || !CHECKPOINT_RE.test(finalUrl)) break;
      continue;
    }
    const token = result;
    if (typeof token !== 'string' || token.length <= 50) continue;
    console.log(`[linkedin_login] V2 enterprise token solved (${token.length}ch), injecting`);
    await page.evaluate((t) => {
      try {
        document.querySelectorAll('textarea[name="g-recaptcha-response"], textarea[name^="g-recaptcha-response-"], textarea[id="g-recaptcha-response"], textarea[id^="g-recaptcha-response-"]').forEach((el) => { el.value = t; });
        if (window.grecaptcha) {
          window.grecaptcha.getResponse = function () { return t; };
          if (window.grecaptcha.enterprise) window.grecaptcha.enterprise.getResponse = function () { return t; };
        }
        const cfg = window.___grecaptcha_cfg;
        if (cfg && cfg.clients) {
          for (const id of Object.keys(cfg.clients)) {
            const walk = (o) => { if (!o || typeof o !== 'object') return; for (const k of Object.keys(o)) { const v = o[k]; if (typeof v === 'function' && (k === 'callback' || k === 'fn')) { try { v(t); } catch {} } else walk(v); } };
            walk(cfg.clients[id]);
          }
        }
      } catch (e) { console.log('inject err:', e.message); }
    }, token);
    const clickOpts = { timeout: SUBMIT_CLICK_MS };
    await page.locator('button:has-text(/submit|verify|continue|next/i)').filter({ visible: true }).first().click(clickOpts).catch(() => {});
    await page.waitForTimeout(5000);
    cookies = await ctx.cookies();
    liAt = cookies.find((c) => c.name === 'li_at' && c.value);
    finalUrl = page.url?.() ?? '';
    if (liAt || !CHECKPOINT_RE.test(finalUrl)) break;
  }
  return { liAt, finalUrl };
}

// Solve invisible reCAPTCHA Enterprise V3 against the login form's sitekey
// and inject the token. LinkedIn's login fires invisible reCAPTCHA on submit;
// tokens from a flagged session score below 0.9 and trigger /checkpoint.
// CapSolver issues a high-score token (typically 0.9) via its token-mill.
export async function injectV3LoginToken(page) {
  try {
    const token = await new CaptchaSolver().solveRecaptchaV3(RECAPTCHA_SITEKEY, page.url(), 'login');
    if (!token) { console.log('[linkedin_login] reCAPTCHA solver returned no token; submitting anyway'); return; }
    console.log(`[linkedin_login] reCAPTCHA token solved (${token.length}ch), injecting`);
    await page.evaluate((t) => {
      try {
        const ge = window.grecaptcha;
        if (ge && ge.enterprise) {
          ge.enterprise.execute = function () { return Promise.resolve(t); };
          ge.enterprise.getResponse = function () { return t; };
        }
        if (ge) {
          ge.execute = function () { return Promise.resolve(t); };
          ge.getResponse = function () { return t; };
        }
      } catch {}
      document.querySelectorAll('textarea[name="g-recaptcha-response"], textarea[name^="g-recaptcha-response-"]').forEach((el) => { el.value = t; });
    }, token);
  } catch (e) { console.log('[linkedin_login] reCAPTCHA solve err:', e.message?.slice(0, 200)); }
}
