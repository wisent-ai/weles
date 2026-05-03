import { CaptchaSolver } from '../../../../dist/captcha/solver.js';
import { solveRecaptchaV2 as solveRecaptchaV2InPage } from '../../../../dist/captcha/recaptcha.js';

const RECAPTCHA_SITEKEY = '6LcIy_MqAAAAAMKiupFSbmzW3xjGSlIfRzNWYMjC';
const CHECKPOINT_RE = /\/(checkpoint|uas\/login|login\/recovery)/;

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
  // /checkpoint/challenge serves the VISIBLE V2-enterprise image-grid widget,
  // not the invisible token flow. CapSolver's ReCaptchaV2EnterpriseTaskProxyLess
  // returns a g-recaptcha-response token in seconds, but injecting it via
  // outer-page DOM (textarea fill + grecaptcha.getResponse override) does NOT
  // trigger the captcha widget's internal verify-callback — verified live
  // 2026-05-03: 3 consecutive token-injects all left URL on /checkpoint.
  // Skip the token attempts entirely and call the in-page image-grid solver,
  // which clicks tiles inside the bframe via the trusted-event Playwright
  // pipeline; this path has demonstrated 'Frame detached — SOLVED!' success.
  for (let attempt = 0; attempt < 3 && !liAt && CHECKPOINT_RE.test(finalUrl); attempt++) {
    console.log(`[linkedin_login] ${reason} solve attempt ${attempt + 1}/3 (in-page image-grid)`);
    const solved = await solveRecaptchaV2InPage(page).catch((e) => { console.log(`[linkedin_login] in-page solver err: ${e.message?.slice(0, 80)}`); return false; });
    try { cookies = await ctx.cookies(); } catch {}
    liAt = cookies.find((c) => c.name === 'li_at' && c.value);
    try { finalUrl = page.url?.() ?? finalUrl; } catch {}
    if (liAt || !CHECKPOINT_RE.test(finalUrl)) break;
    if (!solved) {
      // image-grid solver returned without success — wait briefly for
      // any in-flight redirect from a verify that just landed, then check.
      await page.waitForTimeout(3000).catch(() => {});
      try { cookies = await ctx.cookies(); } catch {}
      liAt = cookies.find((c) => c.name === 'li_at' && c.value);
      try { finalUrl = page.url?.() ?? finalUrl; } catch {}
      if (liAt || !CHECKPOINT_RE.test(finalUrl)) break;
    }
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
