/**
 * Unified CaptchaSolver — matches Python weles.captcha.solver API.
 * Wraps AntiCaptcha, 2captcha, CapSolver behind a single interface.
 */

import { solveRecaptchaV2 } from './recaptcha.js';
import { getCaptchaCredentials } from '../utils/credentials.js';
import { costTracker } from '../utils/cost.js';

type Page = any;

interface CaptchaCredentials {
  anticaptcha?: string;
  twocaptcha?: string;
  capsolver?: string;
  capmonster?: string;
  nocaptcha?: string;
}

async function apiSolve(apiUrl: string, clientKey: string, task: Record<string, any>): Promise<string | null> {
  const svc = apiUrl.replace('https://api.', '').replace('.com', '');
  console.log(`[captcha:api] ${svc} createTask type=${task.type} enterprise=${task.isEnterprise} proxy=${!!task.proxyAddress}`);
  const createRes = await (await fetch(apiUrl + '/createTask', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientKey, task }),
  })).json() as any;
  if (createRes.errorId) { console.log(`[captcha:api] ${svc} createTask error: ${createRes.errorCode} ${createRes.errorDescription}`); return null; }
  const taskId = createRes.taskId;
  if (!taskId) { console.log(`[captcha:api] ${svc} no taskId in response`); return null; }
  console.log(`[captcha:api] ${svc} taskId=${taskId}`);
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const res = await (await fetch(apiUrl + '/getTaskResult', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey, taskId }),
    })).json() as any;
    if (res.status === 'ready') { const t = res.solution?.gRecaptchaResponse ?? res.solution?.token ?? null; console.log(`[captcha:api] ${svc} solved, token=${t?.slice(0, 20)}...`); return t; }
    if (res.errorId) { console.log(`[captcha:api] ${svc} result error: ${res.errorCode} ${res.errorDescription}`); return null; }
  }
  console.log(`[captcha:api] ${svc} timed out after 60 polls`);
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
    if (!this._creds.nocaptcha && process.env.NOCAPTCHA_API_KEY) this._creds.nocaptcha = process.env.NOCAPTCHA_API_KEY;
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
    // CapSolver API token works for sites that wrap reCAPTCHA in their own
    // iframes (LinkedIn's /checkpoint/challengeIframe/ vs Google's
    // captchaInternal). Token mode bypasses the frame chain entirely.
    if (this._creds.capsolver) {
      const taskType = options?.enterprise ? 'ReCaptchaV2EnterpriseTaskProxyLess' : 'ReCaptchaV2TaskProxyLess';
      const token = await apiSolve('https://api.capsolver.com', this._creds.capsolver, {
        type: taskType, websiteURL: page.url?.() ?? '', websiteKey: sitekey,
      });
      if (token) { console.log(`[captcha:solver] ${taskType} solved via capsolver`); costTracker.recordCaptcha('capsolver', 'recaptcha_v2'); return token; }
    }
    if (this._creds.anticaptcha) {
      const token = await apiSolve('https://api.anti-captcha.com', this._creds.anticaptcha, {
        type: 'RecaptchaV2TaskProxyless', websiteURL: page.url?.() ?? '', websiteKey: sitekey,
        isEnterprise: !!options?.enterprise,
      });
      if (token) { console.log(`[captcha:solver] V2 solved via anticaptcha`); costTracker.recordCaptcha('anticaptcha', 'recaptcha_v2'); return token; }
    }
    // Image-grid path for cases where API solvers fail and Google's
    // standard frame chain IS present (non-LinkedIn enterprise sites).
    if (options?.enterprise) return solveRecaptchaV2(page);
    return null;
  }

  async solveRecaptchaV3(sitekey: string, url: string, action?: string): Promise<string | null> {
    await this._ensureInit();
    // Try CapSolver first — supports both ReCaptchaV3TaskProxyLess and the
    // ReCaptchaV3EnterpriseTaskProxyLess variant that LinkedIn signup uses
    // (sitekey 6LcIy_MqAA... is enterprise). CapSolver returns higher-score
    // tokens (typically 0.9) than anticaptcha (typically 0.7).
    if (this._creds.capsolver) {
      // minScore 0.9 — LinkedIn signup correlates reCAPTCHA score with
      // PerimeterX scoring; lower scores get silently rejected even if
      // technically valid. CapSolver retries internally until threshold met.
      const token = await apiSolve('https://api.capsolver.com', this._creds.capsolver, {
        type: 'ReCaptchaV3EnterpriseTaskProxyLess', websiteURL: url, websiteKey: sitekey,
        minScore: 0.9, pageAction: action ?? 'verify',
      });
      if (token) { console.log('[captcha:solver] ReCaptchaV3Enterprise solved via capsolver'); costTracker.recordCaptcha('capsolver', 'recaptcha_v3'); return token; }
      const tokenV3 = await apiSolve('https://api.capsolver.com', this._creds.capsolver, {
        type: 'ReCaptchaV3TaskProxyLess', websiteURL: url, websiteKey: sitekey,
        minScore: 0.9, pageAction: action ?? 'verify',
      });
      if (tokenV3) { console.log('[captcha:solver] ReCaptchaV3 solved via capsolver'); costTracker.recordCaptcha('capsolver', 'recaptcha_v3'); return tokenV3; }
    }
    if (this._creds.anticaptcha) {
      const token = await apiSolve('https://api.anti-captcha.com', this._creds.anticaptcha, {
        type: 'RecaptchaV3TaskProxyless', websiteURL: url, websiteKey: sitekey,
        minScore: 0.7, pageAction: action ?? 'verify',
      });
      if (token) { console.log('[captcha:solver] ReCaptchaV3 solved via anticaptcha'); costTracker.recordCaptcha('anticaptcha', 'recaptcha_v3'); return token; }
    }
    return null;
  }

  async solveTurnstile(sitekey: string, url: string): Promise<string | null> {
    await this._ensureInit();
    if (this._creds.capsolver) {
      const token = await apiSolve('https://api.capsolver.com', this._creds.capsolver, {
        type: 'AntiTurnstileTaskProxyLess', websiteURL: url, websiteKey: sitekey,
      });
      if (token) costTracker.recordCaptcha('capsolver', 'turnstile');
      return token;
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
      if (token) { console.log('[captcha:solver] Solved via anticaptcha'); costTracker.recordCaptcha('anticaptcha', 'hcaptcha'); return token; }
    }
    if (this._creds.capmonster) {
      const token = await apiSolve('https://api.capmonster.cloud', this._creds.capmonster, baseTask);
      if (token) { console.log('[captcha:solver] Solved via capmonster'); costTracker.recordCaptcha('capmonster', 'hcaptcha'); return token; }
    }
    if (this._creds.capsolver) {
      // CapSolver: HCaptchaEnterpriseTaskProxyLess is its own task type;
      // HCaptchaTaskProxyless + isEnterprise returns ERROR_INVALID_TASK_DATA.
      const t: Record<string, any> = { ...baseTask, type: enterprise ? (useProxy ? 'HCaptchaEnterpriseTask' : 'HCaptchaEnterpriseTaskProxyLess') : (useProxy ? 'HCaptchaTask' : 'HCaptchaTaskProxyLess') };
      delete t.isEnterprise;
      const token = await apiSolve('https://api.capsolver.com', this._creds.capsolver, t);
      if (token) { console.log('[captcha:solver] Solved via capsolver'); costTracker.recordCaptcha('capsolver', 'hcaptcha'); return token; }
    }
    console.log('[captcha:solver] All services failed for hCaptcha');
    return null;
  }

  /**
   * PerimeterX (HUMAN Security) — used by LinkedIn checkpointV2 / NewYorkTimes /
   * Zillow. Solved via nocaptcha.io wanda/perimeterx/universal which returns the
   * _px3/_pxde/pxcts cookies that satisfy the challenge. Set NOCAPTCHA_API_KEY
   * (or service_credentials row 'NoCaptcha'). Returns Playwright-shaped cookies
   * ready for ctx.addCookies(); caller then re-navigates and proceeds.
   */
  async solvePerimeterX(url: string, userAgent: string, cookies?: Array<{ name: string; value: string; domain?: string }>, proxy?: string): Promise<Array<{ name: string; value: string; domain: string; path: string }> | null> {
    await this._ensureInit();
    const u = new URL(url);
    const dotDom = u.hostname.startsWith('www.') ? u.hostname.slice(3) : ('.' + u.hostname);
    if (this._creds.capsolver) {
      const cookieMapCs: Record<string, string> = {};
      for (const c of cookies ?? []) if (c?.name && c?.value) cookieMapCs[c.name] = c.value;
      const task: Record<string, any> = { type: proxy ? 'AntiPerimeterxTask' : 'AntiPerimeterxTaskProxyLess', websiteUrl: url, userAgent };
      if (Object.keys(cookieMapCs).length) task.cookies = cookieMapCs;
      if (proxy) {
        const pp = new URL(proxy);
        task.proxyType = pp.protocol.replace(':', '');
        task.proxyAddress = pp.hostname; task.proxyPort = Number(pp.port);
        if (pp.username) task.proxyLogin = decodeURIComponent(pp.username);
        if (pp.password) task.proxyPassword = decodeURIComponent(pp.password);
      }
      console.log(`[captcha:api] capsolver AntiPerimeterx createTask type=${task.type} url=${url.slice(0, 80)}`);
      try {
        const cr = await (await fetch('https://api.capsolver.com/createTask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientKey: this._creds.capsolver, task }) })).json() as any;
        if (cr.errorId) console.log(`[captcha:api] capsolver AntiPerimeterx createTask err: ${cr.errorCode} ${cr.errorDescription}`);
        else if (cr.taskId) {
          for (let i = 0; i < 60; i++) {
            await new Promise(r => setTimeout(r, 5000));
            const tr = await (await fetch('https://api.capsolver.com/getTaskResult', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientKey: this._creds.capsolver, taskId: cr.taskId }) })).json() as any;
            if (tr.errorId) { console.log(`[captcha:api] capsolver AntiPerimeterx err: ${tr.errorCode} ${tr.errorDescription}`); break; }
            if (tr.status === 'ready') {
              const sol = tr.solution ?? {};
              const cm: Record<string, unknown> = (sol.cookies && typeof sol.cookies === 'object') ? sol.cookies : {};
              const out: Array<{ name: string; value: string; domain: string; path: string }> = [];
              for (const [n, v] of Object.entries(cm)) out.push({ name: n, value: String(v), domain: dotDom, path: '/' });
              if (out.length) { console.log(`[captcha:solver] PerimeterX solved via capsolver (${out.length} cookies)`); costTracker.recordCaptcha('capsolver', 'perimeterx'); return out; }
              console.log('[captcha:api] capsolver AntiPerimeterx returned no cookies in solution'); break;
            }
          }
        }
      } catch (e: any) { console.log(`[captcha:api] capsolver AntiPerimeterx fetch err: ${e.message?.slice(0, 100)}`); }
    }
    const token = this._creds.nocaptcha;
    if (!token) { console.log('[captcha:solver] PerimeterX: no NOCAPTCHA_API_KEY (capsolver path returned no cookies)'); return null; }
    const cookieMap: Record<string, string> = {};
    for (const c of cookies ?? []) if (c?.name && c?.value) cookieMap[c.name] = c.value;
    const body: Record<string, any> = { href: url, user_agent: userAgent, cookies: cookieMap };
    if (proxy) {
      const p = new URL(proxy);
      body.proxy = p.username ? `${p.username}:${p.password}@${p.hostname}:${p.port}` : `${p.hostname}:${p.port}`;
    }
    console.log(`[captcha:api] nocaptcha PerimeterX solve href=${url.slice(0, 80)} proxy=${!!proxy}`);
    try {
      const r = await fetch('http://api.nocaptcha.io/api/wanda/perimeterx/universal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Token': token },
        body: JSON.stringify(body),
      });
      const j = await r.json() as any;
      if (j?.status !== 1) { console.log(`[captcha:api] nocaptcha PerimeterX err status=${j?.status} msg=${j?.msg ?? j?.message ?? JSON.stringify(j).slice(0, 200)}`); return null; }
      const out: Array<{ name: string; value: string; domain: string; path: string }> = [];
      const dot = u.hostname.startsWith('www.') ? u.hostname.slice(3) : ('.' + u.hostname);
      for (const [name, value] of Object.entries(j.data?.cookies ?? {})) out.push({ name, value: String(value), domain: dot, path: '/' });
      console.log(`[captcha:solver] PerimeterX solved via nocaptcha (${out.length} cookies)`);
      if (out.length) costTracker.recordCaptcha('nocaptcha', 'perimeterx');
      return out.length ? out : null;
    } catch (e: any) {
      console.log(`[captcha:api] nocaptcha PerimeterX fetch err: ${e.message?.slice(0, 100)}`);
      return null;
    }
  }

  async solveFuncaptcha(publicKey: string, url: string, subdomain?: string, blob?: string): Promise<string | null> {
    await this._ensureInit();
    console.log(`[captcha:solver] solveFuncaptcha pkey=${publicKey.slice(0, 12)} subdomain=${subdomain?.slice(0, 30)} blob=${blob?.slice(0, 40)}...`);
    if (this._creds.anticaptcha) {
      const task: Record<string, any> = { type: 'FunCaptchaTaskProxyless', websiteURL: url, websitePublicKey: publicKey };
      if (subdomain) task.funcaptchaApiJSSubdomain = subdomain.replace(/^https?:\/\//, '').replace('iframe.arkoselabs.com', 'client-api.arkoselabs.com');
      if (blob) task.data = JSON.stringify({ blob });
      const token = await apiSolve('https://api.anti-captcha.com', this._creds.anticaptcha, task);
      if (token) { console.log('[captcha:solver] FunCaptcha solved via anticaptcha'); costTracker.recordCaptcha('anticaptcha', 'funcaptcha'); return token; }
    }
    if (this._creds.twocaptcha) {
      const sd = subdomain ? subdomain.replace(/^https?:\/\//, '').replace('iframe.arkoselabs.com', 'client-api.arkoselabs.com') : '';
      const surl = sd ? `https://${sd}` : '';
      const params = new URLSearchParams({ key: this._creds.twocaptcha, method: 'funcaptcha', publickey: publicKey, pageurl: url, json: '1' });
      if (surl) params.set('surl', surl);
      if (blob) params.set('data[blob]', blob);
      console.log(`[captcha:api] 2captcha funcaptcha surl=${surl.slice(0, 40)}`);
      const cr = await (await fetch('https://2captcha.com/in.php?' + params.toString())).json().catch(() => ({})) as any;
      if (cr.status === 1 && cr.request) {
        const tid = cr.request;
        console.log(`[captcha:api] 2captcha taskId=${tid}`);
        for (let i = 0; i < 60; i++) {
          await new Promise(r => setTimeout(r, 5000));
          const res = await (await fetch(`https://2captcha.com/res.php?key=${this._creds.twocaptcha}&action=get&id=${tid}&json=1`)).json().catch(() => ({})) as any;
          if (res.status === 1) { console.log(`[captcha:api] 2captcha solved`); costTracker.recordCaptcha('twocaptcha', 'funcaptcha'); return res.request; }
          if (res.request !== 'CAPCHA_NOT_READY') { console.log(`[captcha:api] 2captcha error: ${res.request}`); break; }
        }
      } else { console.log(`[captcha:api] 2captcha create error: ${cr.request ?? cr.error_text ?? JSON.stringify(cr)}`); }
    }
    if (this._creds.capmonster) {
      const task: Record<string, any> = { type: 'FunCaptchaTaskProxyless', websiteURL: url, websitePublicKey: publicKey };
      if (subdomain) task.funcaptchaApiJSSubdomain = subdomain.replace(/^https?:\/\//, '').replace('iframe.arkoselabs.com', 'client-api.arkoselabs.com');
      if (blob) task.data = JSON.stringify({ blob });
      const token = await apiSolve('https://api.capmonster.cloud', this._creds.capmonster, task);
      if (token) { console.log('[captcha:solver] FunCaptcha solved via capmonster'); costTracker.recordCaptcha('capmonster', 'funcaptcha'); return token; }
    }
    if (this._creds.capsolver) {
      const task: Record<string, any> = { type: 'FunCaptchaTaskProxyLess', websiteURL: url, websitePublicKey: publicKey };
      if (subdomain) { let s = subdomain.startsWith('http') ? subdomain : `https://${subdomain}`; s = s.replace('iframe.arkoselabs.com', 'client-api.arkoselabs.com'); task.funcaptchaApiJSSubdomain = s; }
      if (blob) task.data = JSON.stringify({ blob });
      const token = await apiSolve('https://api.capsolver.com', this._creds.capsolver, task);
      if (token) { console.log('[captcha:solver] FunCaptcha solved via capsolver'); costTracker.recordCaptcha('capsolver', 'funcaptcha'); return token; }
    }
    console.log('[captcha:solver] All services failed for FunCaptcha');
    return null;
  }
}
