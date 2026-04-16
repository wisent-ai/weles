/**
 * Captcha detection and auto-solving — matches Python weles.captcha.detect API.
 */

import { CaptchaSolver } from './solver.js';

type Page = any;

interface CaptchaInfo { type: string; sitekey: string; blob?: string; subdomain?: string }

/** Detect captcha type and sitekey on the current page. Waits up to 10s for iframe to load. */
export async function detectCaptcha(page: Page): Promise<CaptchaInfo | null> {
  for (let i = 0; i < 10; i++) {
    const info = await page.evaluate(`(() => {
      var rc = document.querySelector('iframe[src*="recaptcha"], .g-recaptcha');
      if (rc) {
        var src = rc.getAttribute('src') || '';
        var key = src.match(/[?&]k=([^&]+)/)?.[1] || rc.getAttribute('data-sitekey') || '';
        if (key) return { type: src.includes('/enterprise/') ? 'recaptcha-enterprise' : 'recaptcha', sitekey: key };
      }
      var cf = document.querySelector('iframe[src*="challenges.cloudflare.com"], .cf-turnstile');
      if (cf) { var ck = cf.getAttribute('data-sitekey') || ''; if (ck) return { type: 'turnstile', sitekey: ck }; }
      var hc = document.querySelector('iframe[src*="hcaptcha.com"], .h-captcha');
      if (hc) { var hsrc = hc.getAttribute('src') || ''; var hk = hc.getAttribute('data-sitekey') || (hsrc.match(/sitekey=([^&]+)/)||[])[1] || ''; return { type: 'hcaptcha', sitekey: hk }; }
      var fc = document.querySelector('iframe[src*="arkoselabs"], iframe[src*="funcaptcha"]');
      if (fc) { var fsrc = fc.getAttribute('src') || ''; var fp = (fsrc.match(/[?&]pkey=([^&]+)/)||[])[1] || (fsrc.match(/\/([A-F0-9-]{36})\//)||[])[1] || ''; var fb = (fsrc.match(/data%5Bblob%5D=([^&]+)/)||[])[1] || (fsrc.match(/[?&]data=([^&]+)/)||[])[1] || ''; return { type: 'funcaptcha', sitekey: fp, blob: decodeURIComponent(fb), subdomain: (new URL(fsrc)).origin }; }
      return null;
    })()`).catch(() => null);
    if (info) { console.log(`[captcha] Detected: ${info.type} sitekey=${(info.sitekey || '').slice(0, 20)}`); return info; }
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log('[captcha] No captcha iframe detected after 10s');
  return null;
}

/** Detect captcha, solve it, and inject the token. Session is optional — provides intercepted API data. */
export async function solvePageCaptcha(page: Page, solver?: CaptchaSolver, session?: any): Promise<boolean> {
  // Check MutationObserver-captured Arkose data first (Twitter pattern: iframe appears and disappears quickly)
  const arkose = await page.evaluate?.('window.__arkoseData')?.catch(() => null);
  if (arkose?.publicKey) {
    console.log(`[captcha] MutationObserver captured Arkose: pkey=${arkose.publicKey.slice(0, 12)} blob=${!!arkose.blob}`);
    const s = solver ?? new CaptchaSolver();
    return solveFuncaptchaOnPage(page, arkose.publicKey, arkose.blob, arkose.subdomain, s);
  }
  // Check intercepted API captcha data (Discord pattern: API returns 400 with captcha before iframe loads)
  if (session?.captchaResponse?.captcha_sitekey && session?.captchaFormData) {
    console.log(`[captcha] Found intercepted captcha data, using enterprise solver`);
    const s = solver ?? new CaptchaSolver();
    return solveHcaptchaEnterprise(page, session.captchaResponse.captcha_sitekey, s, session);
  }
  const info = await detectCaptcha(page);
  if (!info) return true;
  const s = solver ?? new CaptchaSolver();
  switch (info.type) {
    case 'recaptcha-enterprise':
      return !!(await s.solveRecaptchaV2(page, info.sitekey, { enterprise: true }));
    case 'recaptcha': {
      const token = await s.solveRecaptchaV2(page, info.sitekey);
      if (!token) return false;
      if (typeof token === 'string') await page.evaluate(`document.getElementById('g-recaptcha-response').value = ${JSON.stringify(token)}`).catch(() => {});
      return true;
    }
    case 'turnstile': return !!(await s.solveTurnstile(info.sitekey, page.url?.() ?? ''));
    case 'hcaptcha': return solveHcaptchaEnterprise(page, info.sitekey, s, session);
    case 'funcaptcha': return solveFuncaptchaOnPage(page, info.sitekey, info.blob, info.subdomain, s);
  }
  return false;
}

async function solveHcaptchaEnterprise(page: Page, sitekey: string, solver: CaptchaSolver, session?: any): Promise<boolean> {
  const url = page.url?.() ?? '';
  const captchaData = session?.captchaResponse;
  const formData = session?.captchaFormData;
  const extraHeaders = session?.captchaHeaders ?? {};
  if (!captchaData || !formData) {
    console.log(`[captcha] No intercepted API data (captchaResponse=${!!captchaData} formData=${!!formData}), trying basic solve`);
    return !!(await solver.solveHcaptcha(sitekey, url));
  }
  const ua = await page.evaluate?.('navigator.userAgent')?.catch(() => '') ?? '';
  console.log(`[captcha] Enterprise hCaptcha: sitekey=${captchaData.captcha_sitekey?.slice(0, 12)} rqdata=${!!captchaData.captcha_rqdata} ua=${ua.slice(0, 30)}`);
  for (let attempt = 0; attempt < 5; attempt++) {
    const sk = captchaData.captcha_sitekey || sitekey;
    const proxy = session?.proxyConfig;
    const token = await solver.solveHcaptcha(sk, url, {
      enterprisePayload: { rqdata: captchaData.captcha_rqdata ?? '', rqtoken: captchaData.captcha_rqtoken },
      userAgent: ua, proxy,
    });
    if (!token) { console.log(`[captcha] Enterprise attempt ${attempt + 1} failed`); continue; }
    console.log(`[captcha] Enterprise attempt ${attempt + 1} solved, resubmitting`);
    formData.captcha_key = token;
    if (captchaData.captcha_rqtoken) formData.captcha_rqtoken = captchaData.captcha_rqtoken;
    const hdrs = JSON.stringify({ 'Content-Type': 'application/json', ...extraHeaders });
    const body = JSON.stringify(formData);
    const endpoint = session?.captchaEndpoint || '/api/v9/auth/register';
    const result = await page.evaluate(`(async()=>{var r=await fetch(${JSON.stringify(endpoint)},{method:'POST',headers:${hdrs},body:${JSON.stringify(body)}});var d=await r.json().catch(()=>({}));return{status:r.status,data:d}})()`).catch((e: any) => ({ error: e.message }));
    console.log(`[captcha] Resubmit: ${JSON.stringify(result).slice(0, 200)}`);
    if (result?.status >= 200 && result?.status < 300) return true;
    if (result?.data?.captcha_key) {
      captchaData.captcha_sitekey = result.data.captcha_sitekey ?? captchaData.captcha_sitekey;
      captchaData.captcha_rqdata = result.data.captcha_rqdata ?? captchaData.captcha_rqdata;
      captchaData.captcha_rqtoken = result.data.captcha_rqtoken ?? captchaData.captcha_rqtoken;
      continue;
    }
    break;
  }
  return false;
}

async function solveFuncaptchaOnPage(page: Page, publicKey: string, blob?: string, subdomain?: string, solver?: CaptchaSolver): Promise<boolean> {
  const s = solver ?? new CaptchaSolver();
  const url = page.url?.() ?? '';
  console.log(`[captcha] FunCaptcha: pkey=${publicKey.slice(0, 12)} blob=${!!blob} subdomain=${subdomain?.slice(0, 30)}`);
  const token = await s.solveFuncaptcha(publicKey, url, subdomain, blob);
  if (!token) { console.log('[captcha] FunCaptcha solve failed'); return false; }
  console.log(`[captcha] FunCaptcha solved, injecting token`);
  await page.evaluate(`window.postMessage({eventId:"challenge-complete",payload:{sessionToken:${JSON.stringify(token)}}},"*")`).catch(() => {});
  await new Promise(r => setTimeout(r, 3000));
  return true;
}
