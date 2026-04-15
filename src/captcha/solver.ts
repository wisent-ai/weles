/**
 * Unified CaptchaSolver — matches Python weles.captcha.solver API.
 * Wraps AntiCaptcha, 2captcha, CapSolver behind a single interface.
 */

import { solveRecaptchaV2 } from './recaptcha.js';

type Page = any;

interface CaptchaCredentials {
  anticaptcha?: string;
  twocaptcha?: string;
  capsolver?: string;
}

async function apiSolve(apiUrl: string, clientKey: string, task: Record<string, any>): Promise<string | null> {
  const createRes = await (await fetch(apiUrl + '/createTask', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientKey, task }),
  })).json() as any;
  if (createRes.errorId) return null;
  const taskId = createRes.taskId;
  if (!taskId) return null;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const res = await (await fetch(apiUrl + '/getTaskResult', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey, taskId }),
    })).json() as any;
    if (res.status === 'ready') return res.solution?.gRecaptchaResponse ?? res.solution?.token ?? null;
    if (res.errorId) return null;
  }
  return null;
}

export class CaptchaSolver {
  private _creds: CaptchaCredentials;

  constructor(credentials?: CaptchaCredentials) {
    this._creds = {
      anticaptcha: credentials?.anticaptcha ?? process.env.ANTICAPTCHA_API_KEY,
      twocaptcha: credentials?.twocaptcha ?? process.env.TWOCAPTCHA_API_KEY,
      capsolver: credentials?.capsolver ?? process.env.CAPSOLVER_API_KEY,
    };
  }

  get availableServices(): string[] {
    const s: string[] = [];
    if (this._creds.anticaptcha) s.push('anticaptcha');
    if (this._creds.twocaptcha) s.push('twocaptcha');
    if (this._creds.capsolver) s.push('capsolver');
    return s;
  }

  /** Solve reCAPTCHA v2 — token mode or image grid (Enterprise). */
  async solveRecaptchaV2(page: Page, sitekey: string, options?: { enterprise?: boolean }): Promise<string | boolean | null> {
    // Image grid solving for Enterprise (LinkedIn etc)
    if (options?.enterprise) return solveRecaptchaV2(page);
    // Token mode
    if (this._creds.anticaptcha) {
      return apiSolve('https://api.anti-captcha.com', this._creds.anticaptcha, {
        type: 'RecaptchaV2TaskProxyless', websiteURL: page.url?.() ?? '', websiteKey: sitekey,
        isEnterprise: !!options?.enterprise,
      });
    }
    return null;
  }

  /** Solve reCAPTCHA v3 — returns token. */
  async solveRecaptchaV3(sitekey: string, url: string, action?: string): Promise<string | null> {
    if (this._creds.anticaptcha) {
      return apiSolve('https://api.anti-captcha.com', this._creds.anticaptcha, {
        type: 'RecaptchaV3TaskProxyless', websiteURL: url, websiteKey: sitekey,
        minScore: 0.7, pageAction: action ?? 'verify',
      });
    }
    return null;
  }

  /** Solve Cloudflare Turnstile — returns token. */
  async solveTurnstile(sitekey: string, url: string): Promise<string | null> {
    if (this._creds.capsolver) {
      return apiSolve('https://api.capsolver.com', this._creds.capsolver, {
        type: 'AntiTurnstileTaskProxyLess', websiteURL: url, websiteKey: sitekey,
      });
    }
    return null;
  }

  /** Solve hCaptcha — returns token. */
  async solveHcaptcha(sitekey: string, url: string): Promise<string | null> {
    if (this._creds.anticaptcha) {
      return apiSolve('https://api.anti-captcha.com', this._creds.anticaptcha, {
        type: 'HCaptchaTaskProxyless', websiteURL: url, websiteKey: sitekey,
      });
    }
    return null;
  }
}
