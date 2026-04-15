/**
 * Captcha detection and auto-solving — matches Python weles.captcha.detect API.
 */

import { CaptchaSolver } from './solver.js';

type Page = any;

interface CaptchaInfo { type: string; sitekey: string }

/** Detect captcha type and sitekey on the current page. */
export async function detectCaptcha(page: Page): Promise<CaptchaInfo | null> {
  return page.evaluate(`(() => {
    // reCAPTCHA
    const rc = document.querySelector('iframe[src*="recaptcha"], .g-recaptcha');
    if (rc) {
      const src = rc.getAttribute('src') || '';
      const key = src.match(/[?&]k=([^&]+)/)?.[1] || rc.getAttribute('data-sitekey') || '';
      const enterprise = src.includes('/enterprise/');
      return { type: enterprise ? 'recaptcha-enterprise' : 'recaptcha', sitekey: key };
    }
    // Turnstile
    const cf = document.querySelector('iframe[src*="challenges.cloudflare.com"], .cf-turnstile');
    if (cf) {
      const key = cf.getAttribute('data-sitekey') || '';
      return { type: 'turnstile', sitekey: key };
    }
    // hCaptcha
    const hc = document.querySelector('iframe[src*="hcaptcha.com"], .h-captcha');
    if (hc) {
      const key = hc.getAttribute('data-sitekey') || '';
      return { type: 'hcaptcha', sitekey: key };
    }
    return null;
  })()`).catch(() => null);
}

/** Detect captcha, solve it, and inject the token. All-in-one. */
export async function solvePageCaptcha(page: Page, solver?: CaptchaSolver): Promise<boolean> {
  const info = await detectCaptcha(page);
  if (!info) return true; // No captcha found
  const s = solver ?? new CaptchaSolver();
  switch (info.type) {
    case 'recaptcha-enterprise':
      return !!(await s.solveRecaptchaV2(page, info.sitekey, { enterprise: true }));
    case 'recaptcha': {
      const token = await s.solveRecaptchaV2(page, info.sitekey);
      if (!token) return false;
      if (typeof token === 'string') {
        await page.evaluate(`document.getElementById('g-recaptcha-response').value = ${JSON.stringify(token)}`).catch(() => {});
      }
      return true;
    }
    case 'turnstile': {
      const token = await s.solveTurnstile(info.sitekey, page.url?.() ?? '');
      return !!token;
    }
    case 'hcaptcha': {
      const token = await s.solveHcaptcha(info.sitekey, page.url?.() ?? '');
      return !!token;
    }
  }
  return false;
}
