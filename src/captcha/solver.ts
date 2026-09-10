/**
 * Unified CaptchaSolver — matches Python weles.captcha.solver API.
 * Wraps AntiCaptcha, 2captcha, CapSolver behind a single interface.
 */

import { getCaptchaCredentials } from '../utils/credentials.js';
import { costTracker } from '../utils/runtime/cost.js';
import { markCaptchaChallenge, markAllProvidersFailed } from './events.js';
import { apiSolve, nopechaProxyFields, proxyTaskFields, type CaptchaCredentials, type ProxyCredentials } from './providers/api.js';
import { solveRecaptchaV2Token, solveRecaptchaV3Token } from './providers/recaptcha_tokens.js';

type Page = any;

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
    if (this._creds.capmonster) s.push('capmonster');
    if (this._creds.nopecha) s.push('nopecha');
    if (this._creds.nocaptcha) s.push('nocaptcha');
    return s;
  }

  async solveRecaptchaV2(page: Page, sitekey: string, options?: { enterprise?: boolean; invisible?: boolean; url?: string; proxy?: ProxyCredentials; dataS?: string }): Promise<string | boolean | null> {
    await this._ensureInit();
    return solveRecaptchaV2Token(this._creds, page, sitekey, options);
  }

  async solveRecaptchaV3(sitekey: string, url: string, action?: string, options?: { proxy?: ProxyCredentials; dataS?: string; enterprise?: boolean }): Promise<string | null> {
    await this._ensureInit();
    return solveRecaptchaV3Token(this._creds, sitekey, url, action, options);
  }


  async solveTurnstile(sitekey: string, url: string): Promise<string | null> {
    await this._ensureInit();
    markCaptchaChallenge();  // G8
    if (this._creds.capsolver) {
      const token = await apiSolve('https://api.capsolver.com', this._creds.capsolver, {
        type: 'AntiTurnstileTaskProxyLess', websiteURL: url, websiteKey: sitekey,
      });
      if (token) costTracker.recordCaptcha('capsolver', 'turnstile');
      if (!token) markAllProvidersFailed('turnstile');  // G8
      return token;
    }
    markAllProvidersFailed('turnstile');  // G8: no provider configured / all failed
    return null;
  }

  /**
   * Cloudflare managed/5s challenge (IUAM) via CapSolver AntiCloudflareTask.
   * Returns the cf_clearance cookie value + the userAgent that solved the challenge.
   * Caller MUST reuse the same proxy IP and userAgent when browsing with the cookie,
   * otherwise Cloudflare invalidates the clearance.
   */
  async solveCloudflare(url: string, options?: { proxy?: { server?: string; username?: string; password?: string }; userAgent?: string }): Promise<{ token: string; userAgent: string; cookies: Record<string, string> } | null> {
    await this._ensureInit();
    markCaptchaChallenge();  // G8
    if (!this._creds.capsolver) { markAllProvidersFailed('cloudflare'); return null; }
    const proxy = options?.proxy;
    let proxyStr = '';
    if (proxy?.server) {
      const u = new URL(proxy.server);
      const user = encodeURIComponent(proxy.username ?? '');
      const pass = encodeURIComponent(proxy.password ?? '');
      proxyStr = `${u.hostname}:${u.port || '80'}:${user}:${pass}`;
    }
    const task: Record<string, any> = { type: 'AntiCloudflareTask', websiteURL: url };
    if (proxyStr) task.proxy = proxyStr;
    if (options?.userAgent) task.userAgent = options.userAgent;
    console.log(`[captcha:solver] solveCloudflare url=${url.slice(0, 80)} proxy=${!!proxyStr} ua=${!!options?.userAgent}`);
    const res = await (await fetch('https://api.capsolver.com/createTask', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: this._creds.capsolver, task }),
    })).json() as any;
    if (res.errorId) { console.log(`[captcha:api] capsolver AntiCloudflare createTask err: ${res.errorCode} ${res.errorDescription}`); markAllProvidersFailed('cloudflare'); return null; }
    const taskId = res.taskId;
    if (!taskId) { console.log('[captcha:api] capsolver AntiCloudflare no taskId'); markAllProvidersFailed('cloudflare'); return null; }
    console.log(`[captcha:api] capsolver AntiCloudflare taskId=${taskId}`);
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 5000));  // allow-raw-playwright: polling/rate-limit loop
      const tr = await (await fetch('https://api.capsolver.com/getTaskResult', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: this._creds.capsolver, taskId }),
      })).json() as any;
      if (tr.errorId) { console.log(`[captcha:api] capsolver AntiCloudflare err: ${tr.errorCode} ${tr.errorDescription}`); markAllProvidersFailed('cloudflare'); return null; }
      if (tr.status === 'ready') {
        const sol = tr.solution ?? {};
        const token = sol.token ?? '';
        const userAgent = sol.userAgent ?? '';
        const cookies = (sol.cookies && typeof sol.cookies === 'object') ? sol.cookies : {};
        if (!token) { console.log('[captcha:api] capsolver AntiCloudflare returned no token'); markAllProvidersFailed('cloudflare'); return null; }
        console.log(`[captcha:solver] Cloudflare solved via capsolver token=${token.slice(0, 20)}... ua=${userAgent.slice(0, 60)}`);
        costTracker.recordCaptcha('capsolver', 'cloudflare');
        return { token, userAgent, cookies };
      }
    }
    console.log('[captcha:api] capsolver AntiCloudflare timed out after 60 polls');
    markAllProvidersFailed('cloudflare');
    return null;
  }

  async solveHcaptcha(sitekey: string, url: string, options?: {
    enterprisePayload?: { rqdata: string; rqtoken?: string };
    userAgent?: string;
    proxy?: { server: string; username?: string; password?: string };
  }): Promise<string | null> {
    await this._ensureInit();
    markCaptchaChallenge();  // G8
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
    markAllProvidersFailed('hcaptcha');  // G8
    return null;
  }

  /**
   * PerimeterX (HUMAN Security) — used by LinkedIn checkpointV2 / NewYorkTimes /
   * Zillow. Solved via nocaptcha.io wanda/perimeterx/universal which returns the
   * _px3/_pxde/pxcts cookies that satisfy the challenge. The NoCaptcha key is
   * acquired from its exact Skarbiec item. Returns Playwright-shaped cookies
   * ready for ctx.addCookies(); caller then re-navigates and proceeds.
   */
  async solvePerimeterX(url: string, userAgent: string, cookies?: Array<{ name: string; value: string; domain?: string }>, proxy?: string): Promise<Array<{ name: string; value: string; domain: string; path: string }> | null> {
    await this._ensureInit();
    markCaptchaChallenge();  // G8
    const u = new URL(url);
    const dotDom = u.hostname.startsWith('www.') ? u.hostname.slice(3) : ('.' + u.hostname);
    if (this._creds.capsolver) {
      const cookieMapCs: Record<string, string> = {};
      for (const c of cookies ?? []) if (c?.name && c?.value) cookieMapCs[c.name] = c.value;
      const task: Record<string, any> = { type: proxy ? 'AntiPerimeterxTask' : 'AntiPerimeterxTaskProxyLess', websiteURL: url, userAgent };
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
            await new Promise(r => setTimeout(r, 5000));  // allow-raw-playwright: polling/rate-limit loop
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
    if (!token) { console.log('[captcha:solver] PerimeterX: no NOCAPTCHA_API_KEY (capsolver path returned no cookies)'); markAllProvidersFailed('perimeterx'); return null; }  // G8
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
      if (j?.status !== 1) { console.log(`[captcha:api] nocaptcha PerimeterX err status=${j?.status} msg=${j?.msg ?? j?.message ?? JSON.stringify(j).slice(0, 200)}`); markAllProvidersFailed('perimeterx'); return null; }  // G8
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
    markCaptchaChallenge();  // G8
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
          await new Promise(r => setTimeout(r, 5000));  // allow-raw-playwright: polling/rate-limit loop
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
    markAllProvidersFailed('funcaptcha');  // G8
    return null;
  }
}
