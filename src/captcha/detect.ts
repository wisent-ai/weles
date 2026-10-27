/**
 * Captcha detection and solving on a page: find the widget in any frame,
 * solve it with the configured services, and hand the token to the page.
 */

import type { Page } from 'playwright';
import { CaptchaSolver } from './solver.js';
import { pageSettled } from '../browser/settled.js';
import {
  braveProofOfWorkState,
  solveBraveProofOfWork,
} from './brave_proof_of_work.js';
import { deliverCaptchaToken } from './page/token.js';
import {
  solveHcaptchaEnterprise,
  type CaptchaSession,
} from './page/hcaptcha-enterprise.js';

interface CaptchaInfo {
  type: string;
  /** Absent when the widget is present but names no key in the page. */
  sitekey?: string;
  blob?: string;
  subdomain?: string;
}

/**
 * Runs in each frame's document, so a vendor widget wrapped in a same-origin
 * iframe one level below the page is found. A widget's key is read from its
 * data attribute or from its frame address's query or fragment.
 */
function detectInDocument(): CaptchaInfo | null {
  const param = (element: Element, name: string): string | null => {
    const src = element.getAttribute('src');
    if (!src) return null;
    const address = new URL(src, location.href);
    return (
      address.searchParams.get(name) ||
      new URLSearchParams(address.hash.replace(/^#/, '')).get(name)
    );
  };
  for (const frame of Array.from(
    document.querySelectorAll('iframe[src*="recaptcha"]'),
  )) {
    const key = param(frame, 'k');
    if (!key) continue;
    const enterprise = frame.getAttribute('src')?.includes('/enterprise/');
    return {
      type: enterprise ? 'recaptcha-enterprise' : 'recaptcha',
      sitekey: key,
    };
  }
  const recaptchaKey = document
    .querySelector('.g-recaptcha[data-sitekey]')
    ?.getAttribute('data-sitekey');
  if (recaptchaKey) return { type: 'recaptcha', sitekey: recaptchaKey };
  const turnstile = document.querySelector(
    'iframe[src*="challenges.cloudflare.com"], .cf-turnstile',
  );
  if (turnstile) {
    const key =
      turnstile.getAttribute('data-sitekey') ||
      param(turnstile, 'sitekey') ||
      param(turnstile, 'k');
    if (key) return { type: 'turnstile', sitekey: key };
  }
  const hcaptcha = document.querySelector(
    'iframe[src*="hcaptcha.com"], .h-captcha',
  );
  if (hcaptcha) {
    const key =
      hcaptcha.getAttribute('data-sitekey') || param(hcaptcha, 'sitekey');
    return key ? { type: 'hcaptcha', sitekey: key } : { type: 'hcaptcha' };
  }
  const arkose = document.querySelector(
    'iframe[src*="arkoselabs"], iframe[src*="funcaptcha"]',
  );
  const arkoseSrc = arkose?.getAttribute('src');
  if (!arkose || !arkoseSrc) return null;
  const address = new URL(arkoseSrc, location.href);
  const pathKey = address.pathname.match(
    /\/(?<key>[A-F\d]+(?:-[A-F\d]+)+)\//i,
  )?.groups?.key;
  const info: CaptchaInfo = { type: 'funcaptcha', subdomain: address.origin };
  const key = param(arkose, 'pkey') || pathKey;
  if (key) info.sitekey = key;
  const blob = param(arkose, 'data[blob]') || param(arkose, 'data');
  if (blob) info.blob = blob;
  return info;
}

/** Detect captcha type and sitekey on the current page, once the page and its frames have loaded. */
export async function detectCaptcha(page: Page): Promise<CaptchaInfo | null> {
  // The load event fires only after every iframe present has loaded, so the
  // widget frames are readable after it without a polling window.
  await page.waitForLoadState('load');
  const frames = page.frames();
  for (const frame of frames) {
    let info: CaptchaInfo | null = null;
    try {
      info = await frame.evaluate(detectInDocument);
    } catch (error) {
      console.log(
        `[captcha] frame ${frame.url()} could not be searched: ${String(error)}`,
      );
    }
    if (info) {
      // A sitekey is public page data; it is logged whole.
      console.log(
        `[captcha] Detected: ${info.type} sitekey=${info.sitekey} frame=${frame.url()}`,
      );
      return info;
    }
  }
  console.log(
    `[captcha] No captcha iframe on the loaded page (${frames.length} frames)`,
  );
  return null;
}

type ArkoseData = { publicKey?: string; blob?: string; subdomain?: string };

/**
 * Detect captcha, solve it, and inject the token. Null means no supported
 * CAPTCHA was present; a challenge no service solved throws the error naming
 * every service tried and why.
 */
export async function solvePageCaptcha(
  page: Page,
  solver?: CaptchaSolver,
  session?: CaptchaSession,
): Promise<boolean | null> {
  // Arkose data a MutationObserver captured: the challenge iframe can appear
  // and disappear before detection runs.
  const arkose = (await page.evaluate('window.__arkoseData')) as
    | ArkoseData
    | undefined;
  if (arkose?.publicKey) {
    console.log(
      `[captcha] MutationObserver captured Arkose: pkey=${arkose.publicKey} blob=${!!arkose.blob}`,
    );
    return solveFuncaptchaOnPage(
      page,
      { type: 'funcaptcha', ...arkose, sitekey: arkose.publicKey },
      solver ?? new CaptchaSolver(),
    );
  }
  // A captcha demand the sign-in API answered with, kept before any iframe
  // loaded.
  const demandedKey = session?.captchaResponse?.captcha_sitekey;
  if (demandedKey && session?.captchaFormData) {
    console.log(
      `[captcha] Found intercepted captcha data, using enterprise solver`,
    );
    return solveHcaptchaEnterprise(
      page,
      demandedKey,
      solver ?? new CaptchaSolver(),
      session,
    );
  }
  const braveProofOfWork = await braveProofOfWorkState(page);
  if (braveProofOfWork) {
    console.log('[captcha] Detected Brave proof-of-work challenge');
    return solveBraveProofOfWork(page, braveProofOfWork);
  }
  const info = await detectCaptcha(page);
  if (!info) return null;
  const { sitekey } = info;
  if (!sitekey) {
    console.log(`[captcha] ${info.type} is present but names no sitekey`);
    return false;
  }
  const s = solver ?? new CaptchaSolver();
  switch (info.type) {
    case 'recaptcha-enterprise':
    case 'recaptcha': {
      const token = await s.solveRecaptchaV2(page, sitekey, {
        enterprise: info.type === 'recaptcha-enterprise',
      });
      // A solver that clicked the widget itself answers true, not a token.
      if (token === true) return true;
      return deliverCaptchaToken(page, 'recaptcha', token);
    }
    case 'turnstile': {
      const token = await s.solveTurnstile(sitekey, page.url());
      return deliverCaptchaToken(page, 'turnstile', token);
    }
    case 'hcaptcha':
      return solveHcaptchaEnterprise(page, sitekey, s, session);
    case 'funcaptcha':
      return solveFuncaptchaOnPage(page, { ...info, sitekey }, s);
  }
  console.log(`[captcha] ${info.type} has no solver`);
  return false;
}

async function solveFuncaptchaOnPage(
  page: Page,
  info: CaptchaInfo & { sitekey: string },
  solver: CaptchaSolver,
): Promise<boolean> {
  const { sitekey, blob, subdomain } = info;
  console.log(
    `[captcha] FunCaptcha: pkey=${sitekey} blob=${!!blob} subdomain=${subdomain}`,
  );
  const token = await solver.solveFuncaptcha(
    sitekey,
    page.url(),
    subdomain,
    blob,
  );
  console.log(`[captcha] FunCaptcha solved, injecting token`);
  await page.evaluate(
    `window.postMessage({eventId:"challenge-complete",payload:{sessionToken:${JSON.stringify(token)}}},"*")`,
  );
  await pageSettled(page);
  return true;
}
