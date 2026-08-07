/**
 * Captcha detection and auto-solving — matches Python weles.captcha.detect API.
 */

import { CaptchaSolver } from './solver.js';
import { humanIdlePause } from '../human/mouse.js';

type Page = any;

interface CaptchaInfo { type: string; sitekey: string; blob?: string; subdomain?: string }

// Selector-based detection executed in any frame's document. Returns the
// captcha info or null. Same logic as before but runs per-frame so platforms
// that wrap the vendor widget in a same-origin iframe (LinkedIn checkpoint at
// /checkpoint/challenge/captchaInternal, GitHub recover behind /login/two
// /factor) are detected too.
const FRAME_DETECT_SCRIPT = `
  (() => {
    const rcFrames = Array.from(document.querySelectorAll('iframe[src*="recaptcha"]'));
    for (const f of rcFrames) {
      const src = f.getAttribute('src') || '';
      const km = src.match(/[?&]k=([^&]+)/);
      if (km && km[1]) return { type: src.indexOf('/enterprise/') >= 0 ? 'recaptcha-enterprise' : 'recaptcha', sitekey: km[1] };
    }
    const rcDiv = document.querySelector('.g-recaptcha[data-sitekey]');
    if (rcDiv) { const dk = rcDiv.getAttribute('data-sitekey') || ''; if (dk) return { type: 'recaptcha', sitekey: dk }; }
    const cf = document.querySelector('iframe[src*="challenges.cloudflare.com"], .cf-turnstile');
    if (cf) { const csrc = cf.getAttribute('src') || ''; const ck = cf.getAttribute('data-sitekey') || (csrc.match(/[?&](?:sitekey|k)=([^&]+)/) || [])[1] || ''; if (ck) return { type: 'turnstile', sitekey: decodeURIComponent(ck) }; }
    const hc = document.querySelector('iframe[src*="hcaptcha.com"], .h-captcha');
    if (hc) { const hsrc = hc.getAttribute('src') || ''; const hk = hc.getAttribute('data-sitekey') || (hsrc.match(/sitekey=([^&]+)/) || [])[1] || ''; return { type: 'hcaptcha', sitekey: hk }; }
    const fc = document.querySelector('iframe[src*="arkoselabs"], iframe[src*="funcaptcha"]');
    if (fc) {
      const fsrc = fc.getAttribute('src') || '';
      const fp = (fsrc.match(/[?&]pkey=([^&]+)/) || [])[1] || (fsrc.match(/\\/([A-F0-9-]{36})\\//) || [])[1] || '';
      const fb = (fsrc.match(/data%5Bblob%5D=([^&]+)/) || [])[1] || (fsrc.match(/[?&]data=([^&]+)/) || [])[1] || '';
      return { type: 'funcaptcha', sitekey: fp, blob: decodeURIComponent(fb), subdomain: (new URL(fsrc)).origin };
    }
    return null;
  })()
`;

/** Detect captcha type and sitekey on the current page. Waits up to 15s for iframe to load. */
export async function detectCaptcha(page: Page): Promise<CaptchaInfo | null> {
  for (let i = 0; i < 15; i++) {
    // Try main frame, then every child frame. LinkedIn wraps the widget in
    // /checkpoint/challenge/captchaInternal so the challenge iframe lives one
    // level deeper than the main DOM.
    const frames = page.frames?.() ?? [page.mainFrame?.() ?? page];
    for (const f of frames) {
      const info: any = await (f.evaluate ? f.evaluate(FRAME_DETECT_SCRIPT) : page.evaluate(FRAME_DETECT_SCRIPT)).catch(() => null);
      if (info) { console.log(`[captcha] Detected: ${info.type} sitekey=${(info.sitekey || '').slice(0, 20)} frame=${f.url?.().slice(0, 80) ?? 'main'}`); return info; }
    }
    await humanIdlePause('short');
  }
  console.log('[captcha] No captcha iframe detected after 15s');
  return null;
}

async function framesFor(page: Page): Promise<any[]> {
  return page.frames?.() ?? [page.mainFrame?.() ?? page];
}

async function injectCaptchaToken(page: Page, selectors: string[], token: string): Promise<boolean> {
  let injected = false;
  for (const frame of await framesFor(page)) {
    const ok = await frame.evaluate?.(
      ({ selectors, token }: { selectors: string[]; token: string }) => {
        let touched = false;
        for (const selector of selectors) {
          for (const el of Array.from(document.querySelectorAll(selector)) as Array<HTMLInputElement | HTMLTextAreaElement>) {
            el.value = token;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            touched = true;
          }
        }
        return touched;
      },
      { selectors, token },
    ).catch(() => false);
    injected ||= !!ok;
  }
  return injected;
}

async function invokeCaptchaCallbacks(page: Page, token: string): Promise<boolean> {
  let invoked = false;
  for (const frame of await framesFor(page)) {
    const ok = await frame.evaluate?.((token: string) => {
      let touched = false;
      const callbackKey = /(^|[-_])(callback|promise-callback|expired-callback|error-callback)$/i;
      const visit = (value: unknown, depth: number, seen: Set<unknown>) => {
        if (depth > 5 || !value || seen.has(value)) return;
        if (typeof value !== 'object') return;
        seen.add(value);
        for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
          if (typeof entry === 'function') {
            if (!callbackKey.test(key)) continue;
            try { (entry as (token: string) => void)(token); touched = true; } catch { /* ignore non-token callbacks */ }
          } else {
            visit(entry, depth + 1, seen);
          }
        }
      };
      visit((window as any).___grecaptcha_cfg?.clients, 0, new Set<unknown>());
      visit((window as any).___turnstile_cfg?.clients, 0, new Set<unknown>());
      return touched;
    }, token).catch(() => false);
    invoked ||= !!ok;
  }
  return invoked;
}

interface BraveProofOfWorkState {
  present: boolean;
  formValid: boolean;
  buttonDisabled: boolean;
  buttonText: string;
  solutionLength: number;
  errorText: string;
  url: string;
}

async function braveProofOfWorkState(page: Page): Promise<BraveProofOfWorkState | null> {
  return await page.evaluate?.(() => {
    const solution = document.querySelector<HTMLInputElement>('input[name="captchaSolution"]');
    const button = document.querySelector<HTMLButtonElement>('#captcha-button');
    if (!solution || !button) return null;
    const form = button.closest('form');
    const errorText = Array.from(document.querySelectorAll<HTMLElement>('.alert, [role="alert"], .error'))
      .map(element => element.innerText.trim())
      .filter(Boolean)
      .join(' ')
      .slice(0, 500);
    return {
      present: true,
      formValid: form?.checkValidity() ?? false,
      buttonDisabled: button.disabled,
      buttonText: button.innerText.trim(),
      solutionLength: solution.value.length,
      errorText,
      url: location.href,
    };
  }).catch(() => null) ?? null;
}

async function solveBraveProofOfWork(page: Page, initial: BraveProofOfWorkState): Promise<boolean> {
  let ready = initial;
  if (!ready.formValid) {
    console.log('[captcha] Brave proof-of-work blocked: registration form is invalid');
    return false;
  }

  if (ready.buttonDisabled && ready.solutionLength === 0) {
    console.log('[captcha] Brave proof-of-work waiting for registration validation');
    for (let attempt = 0; attempt < 60 && ready.buttonDisabled; attempt++) {
      await humanIdlePause('short');
      const state = await braveProofOfWorkState(page);
      if (!state) return false;
      ready = state;
      if (!ready.formValid) {
        console.log('[captcha] Brave proof-of-work blocked: registration form became invalid');
        return false;
      }
      if (ready.errorText) {
        console.log(`[captcha] Brave proof-of-work validation failed: ${ready.errorText.slice(0, 160)}`);
        return false;
      }
    }
    if (ready.buttonDisabled) {
      console.log('[captcha] Brave proof-of-work button remained disabled after validation');
      return false;
    }
  }

  let started = /verifying/i.test(ready.buttonText);
  if (!started && ready.solutionLength === 0) {
    try {
      await page.locator('#captcha-button').click({ timeout: 10_000 });
      started = true;
      console.log('[captcha] Brave proof-of-work calculation started');
    } catch (error) {
      console.log(`[captcha] Brave proof-of-work click failed: ${error instanceof Error ? error.message.slice(0, 120) : String(error).slice(0, 120)}`);
      return false;
    }
  }

  if (ready.solutionLength > 0 || /verified/i.test(ready.buttonText)) return true;
  const initialURL = ready.url;
  for (let attempt = 0; attempt < 240; attempt++) {
    await humanIdlePause('short');
    const state = await braveProofOfWorkState(page);
    if (!state) {
      const currentURL = page.url?.() ?? '';
      if (currentURL !== initialURL) {
        console.log('[captcha] Brave proof-of-work submitted the registration form');
        return true;
      }
      console.log('[captcha] Brave proof-of-work form disappeared after calculation');
      return true;
    }
    if (state.solutionLength > 0 || /verified/i.test(state.buttonText)) {
      console.log(`[captcha] Brave proof-of-work solved solution_length=${state.solutionLength}`);
      await humanIdlePause('deliberate');
      return true;
    }
    if (state.url !== initialURL) {
      console.log('[captcha] Brave proof-of-work navigated after submission');
      return true;
    }
    if (state.errorText && !/verifying/i.test(state.buttonText)) {
      console.log(`[captcha] Brave proof-of-work failed: ${state.errorText.slice(0, 160)}`);
      return false;
    }
  }
  console.log(`[captcha] Brave proof-of-work timed out started=${started}`);
  return false;
}

/** Detect captcha, solve it, and inject the token. Null means no supported CAPTCHA was present. */
export async function solvePageCaptcha(page: Page, solver?: CaptchaSolver, session?: any): Promise<boolean | null> {
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
  const braveProofOfWork = await braveProofOfWorkState(page);
  if (braveProofOfWork) {
    console.log('[captcha] Detected Brave proof-of-work challenge');
    return solveBraveProofOfWork(page, braveProofOfWork);
  }
  const info = await detectCaptcha(page);
  if (!info) return null;
  const s = solver ?? new CaptchaSolver();
  switch (info.type) {
    case 'recaptcha-enterprise': {
      const token = await s.solveRecaptchaV2(page, info.sitekey, { enterprise: true });
      if (!token) return false;
      if (typeof token !== 'string') return true;
      const injected = await injectCaptchaToken(page, ['#g-recaptcha-response', 'textarea[name="g-recaptcha-response"]'], token);
      const invoked = await invokeCaptchaCallbacks(page, token);
      if (!injected && !invoked) console.log('[captcha] reCAPTCHA token solved but no page field/callback accepted it');
      return injected || invoked;
    }
    case 'recaptcha': {
      const token = await s.solveRecaptchaV2(page, info.sitekey);
      if (!token) return false;
      if (typeof token !== 'string') return true;
      const injected = await injectCaptchaToken(page, ['#g-recaptcha-response', 'textarea[name="g-recaptcha-response"]'], token);
      const invoked = await invokeCaptchaCallbacks(page, token);
      if (!injected && !invoked) console.log('[captcha] reCAPTCHA token solved but no page field/callback accepted it');
      return injected || invoked;
    }
    case 'turnstile': {
      const token = await s.solveTurnstile(info.sitekey, page.url?.() ?? '');
      if (!token) return false;
      const injected = await injectCaptchaToken(page, ['input[name="cf-turnstile-response"]', 'textarea[name="cf-turnstile-response"]', '.cf-turnstile-response'], token);
      const invoked = await invokeCaptchaCallbacks(page, token);
      if (!injected && !invoked) console.log('[captcha] Turnstile token solved but no page field/callback accepted it');
      return injected || invoked;
    }
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
  await humanIdlePause('deliberate');
  return true;
}
