/**
 * Unified CaptchaSolver — matches Python weles.captcha.solver API.
 * Wraps AntiCaptcha, 2captcha, CapSolver behind a single interface.
 */

import { solveRecaptchaV2 } from './recaptcha.js';
import { getCaptchaCredentials } from '../utils/credentials.js';

type Page = any;

interface CaptchaCredentials {
  anticaptcha?: string;
  twocaptcha?: string;
  capsolver?: string;
  capmonster?: string;
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
  private _initialized = false;

  constructor(credentials?: CaptchaCredentials) {
    this._creds = credentials ?? {};
  }

  private async _ensureInit(): Promise<void> {
    if (this._initialized) return;
    if (!this._creds.anticaptcha && !this._creds.twocaptcha && !this._creds.capsolver) {
      const db = await getCaptchaCredentials();
      this._creds = { ...db, ...this._creds };
    }
    this._initialized = true;
  }

  get availableServices(): string[] {
    const s: string[] = [];
    if (this._creds.anticaptcha) s.push('anticaptcha');
    if (this._creds.twocaptcha) s.push('twocaptcha');
    if (this._creds.capsolver) s.push('capsolver');
    return s;
  }

  async solveRecaptchaV2(page: Page, sitekey: string, options?: { enterprise?: boolean }): Promise<string | boolean | null> {
    await this._ensureInit();
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

  async solveRecaptchaV3(sitekey: string, url: string, action?: string): Promise<string | null> {
    await this._ensureInit();
    if (this._creds.anticaptcha) {
      return apiSolve('https://api.anti-captcha.com', this._creds.anticaptcha, {
        type: 'RecaptchaV3TaskProxyless', websiteURL: url, websiteKey: sitekey,
        minScore: 0.7, pageAction: action ?? 'verify',
      });
    }
    return null;
  }

  async solveTurnstile(sitekey: string, url: string): Promise<string | null> {
    await this._ensureInit();
    if (this._creds.capsolver) {
      return apiSolve('https://api.capsolver.com', this._creds.capsolver, {
        type: 'AntiTurnstileTaskProxyLess', websiteURL: url, websiteKey: sitekey,
      });
    }
    return null;
  }

  async solveHcaptcha(sitekey: string, url: string, options?: {
    enterprisePayload?: { rqdata: string; rqtoken?: string };
    userAgent?: string;
    proxy?: { server: string; username?: string; password?: string };
  }): Promise<string | null> {
    await this._ensureInit();
    const enterprise = !!options?.enterprisePayload;
    const useProxy = !!options?.proxy?.server;
    const baseTask: Record<string, any> = { type: useProxy ? 'HCaptchaTask' : 'HCaptchaTaskProxyless', websiteURL: url, websiteKey: sitekey };
    if (enterprise) { baseTask.isEnterprise = true; baseTask.enterprisePayload = { rqdata: options!.enterprisePayload!.rqdata }; }
    if (options?.userAgent) baseTask.userAgent = options.userAgent;
    if (useProxy) {
      const u = new URL(options!.proxy!.server);
      // Resolve hostname to IP — captcha services require IP, not hostname
      let ip = u.hostname;
      try { const dns = await import('node:dns'); ip = await new Promise((res, rej) => dns.lookup(u.hostname, (e: any, a: string) => e ? rej(e) : res(a))); } catch {}
      Object.assign(baseTask, { proxyType: u.protocol.replace(':', '') || 'http', proxyAddress: ip, proxyPort: parseInt(u.port, 10), proxyLogin: options!.proxy!.username, proxyPassword: options!.proxy!.password });
    }
    console.log(`[captcha:solver] solveHcaptcha enterprise=${enterprise} proxy=${useProxy} addr=${baseTask.proxyAddress ?? 'none'} sitekey=${sitekey.slice(0, 12)}`);
    // Try all services: anticaptcha → capmonster → capsolver
    if (this._creds.anticaptcha) {
      const token = await apiSolve('https://api.anti-captcha.com', this._creds.anticaptcha, baseTask);
      if (token) { console.log('[captcha:solver] Solved via anticaptcha'); return token; }
    }
    if (this._creds.capmonster) {
      const token = await apiSolve('https://api.capmonster.cloud', this._creds.capmonster, baseTask);
      if (token) { console.log('[captcha:solver] Solved via capmonster'); return token; }
    }
    if (this._creds.capsolver) {
      const t = { ...baseTask, type: useProxy ? 'HCaptchaTask' : 'HCaptchaTaskProxyLess' };
      const token = await apiSolve('https://api.capsolver.com', this._creds.capsolver, t);
      if (token) { console.log('[captcha:solver] Solved via capsolver'); return token; }
    }
    console.log('[captcha:solver] All services failed for hCaptcha');
    return null;
  }

  async solveFuncaptcha(publicKey: string, url: string, subdomain?: string, blob?: string): Promise<string | null> {
    await this._ensureInit();
    console.log(`[captcha:solver] solveFuncaptcha pkey=${publicKey.slice(0, 12)} subdomain=${subdomain?.slice(0, 30)} blob=${!!blob}`);
    if (this._creds.anticaptcha) {
      const task: Record<string, any> = { type: 'FunCaptchaTaskProxyless', websiteURL: url, websitePublicKey: publicKey };
      if (subdomain) task.funcaptchaApiJSSubdomain = subdomain.replace(/^https?:\/\//, '');
      if (blob) task.data = JSON.stringify({ blob });
      const token = await apiSolve('https://api.anti-captcha.com', this._creds.anticaptcha, task);
      if (token) { console.log('[captcha:solver] FunCaptcha solved via anticaptcha'); return token; }
    }
    if (this._creds.capsolver) {
      const task: Record<string, any> = { type: 'FunCaptchaTaskProxyLess', websiteURL: url, websitePublicKey: publicKey };
      if (subdomain) { const s = subdomain.startsWith('http') ? subdomain : `https://${subdomain}`; task.funcaptchaApiJSSubdomain = s; }
      if (blob) task.data = JSON.stringify({ blob });
      const token = await apiSolve('https://api.capsolver.com', this._creds.capsolver, task);
      if (token) { console.log('[captcha:solver] FunCaptcha solved via capsolver'); return token; }
    }
    console.log('[captcha:solver] All services failed for FunCaptcha');
    return null;
  }
}
