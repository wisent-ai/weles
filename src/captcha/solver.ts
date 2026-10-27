/**
 * Unified CaptchaSolver — matches Python weles.captcha.solver API.
 * Wraps AntiCaptcha, 2captcha, CapSolver behind a single interface.
 */

import { getCaptchaCredentials } from '../utils/credentials.js';
import { costTracker } from '../utils/runtime/cost.js';
import { markCaptchaChallenge, markAllProvidersFailed } from './events.js';
import {
  apiSolve,
  providerJson,
  readUntilSolved,
  type CaptchaCredentials,
  type ProxyCredentials,
} from './providers/api.js';
import { solveFuncaptchaToken } from './providers/funcaptcha.js';
import {
  solveHcaptchaToken,
  type HcaptchaOptions,
} from './providers/hcaptcha.js';
import { solvePerimeterXCookies } from './providers/perimeterx.js';
import { solveRecaptchaV2Token } from './providers/recaptcha/v2.js';
import { solveRecaptchaV3Token } from './providers/recaptcha/v3.js';

type Page = any;

export class CaptchaSolver {
  private _creds: CaptchaCredentials;
  private _initialized = false;

  // Credentials a caller hands in; any service it leaves out is read from Skarbiec in _ensureInit.
  constructor(credentials: CaptchaCredentials = {}) {
    this._creds = credentials;
  }

  private async _ensureInit(): Promise<void> {
    if (this._initialized) return;
    if (
      !this._creds.anticaptcha &&
      !this._creds.twocaptcha &&
      !this._creds.capsolver
    ) {
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
    if (this._creds.solvecha) s.push('solvecha');
    return s;
  }

  /** The solving services whose credentials Weles holds, read from Skarbiec first. */
  async configuredServices(): Promise<string[]> {
    await this._ensureInit();
    return this.availableServices;
  }

  async solveRecaptchaV2(
    page: Page,
    sitekey: string,
    options?: {
      enterprise?: boolean;
      invisible?: boolean;
      url?: string;
      proxy?: ProxyCredentials;
      dataS?: string;
    },
  ): Promise<string | boolean | null> {
    await this._ensureInit();
    return solveRecaptchaV2Token(this._creds, page, sitekey, options);
  }

  async solveRecaptchaV3(
    sitekey: string,
    url: string,
    action?: string,
    options?: {
      proxy?: ProxyCredentials;
      dataS?: string;
      enterprise?: boolean;
    },
  ): Promise<string | null> {
    await this._ensureInit();
    return solveRecaptchaV3Token(this._creds, sitekey, url, action, options);
  }

  async solveTurnstile(sitekey: string, url: string): Promise<string | null> {
    await this._ensureInit();
    markCaptchaChallenge(); // G8
    if (this._creds.capsolver) {
      const token = await apiSolve(
        'https://api.capsolver.com',
        this._creds.capsolver,
        {
          type: 'AntiTurnstileTaskProxyLess',
          websiteURL: url,
          websiteKey: sitekey,
        },
      );
      if (token) costTracker.recordCaptcha('capsolver', 'turnstile');
      if (!token) markAllProvidersFailed('turnstile'); // G8
      return token;
    }
    markAllProvidersFailed('turnstile'); // G8: no provider configured / all failed
    return null;
  }

  /**
   * Cloudflare managed/5s challenge (IUAM) via CapSolver AntiCloudflareTask.
   * Returns the cf_clearance cookie value + the userAgent that solved the challenge.
   * Caller MUST reuse the same proxy IP and userAgent when browsing with the cookie,
   * otherwise Cloudflare invalidates the clearance.
   */
  async solveCloudflare(
    url: string,
    options?: {
      proxy?: { server?: string; username?: string; password?: string };
      userAgent?: string;
    },
  ): Promise<{
    token: string;
    userAgent: string;
    cookies: Record<string, string>;
  } | null> {
    await this._ensureInit();
    markCaptchaChallenge(); // G8
    if (!this._creds.capsolver) {
      markAllProvidersFailed('cloudflare');
      return null;
    }
    const proxy = options?.proxy;
    let proxyStr = '';
    if (proxy?.server) {
      const u = new URL(proxy.server);
      // CapSolver takes host:port:user:pass; the port is the proxy's own, never one assumed for its scheme.
      if (!u.port) {
        console.log(`[captcha:api] capsolver AntiCloudflare: proxy ${u.host} states no port`);
        markAllProvidersFailed('cloudflare');
        return null;
      }
      const user = proxy.username ? encodeURIComponent(proxy.username) : '';
      const pass = proxy.password ? encodeURIComponent(proxy.password) : '';
      proxyStr = `${u.hostname}:${u.port}:${user}:${pass}`;
    }
    const task: Record<string, any> = {
      type: 'AntiCloudflareTask',
      websiteURL: url,
    };
    if (proxyStr) task.proxy = proxyStr;
    if (options?.userAgent) task.userAgent = options.userAgent;
    console.log(
      `[captcha:solver] solveCloudflare url=${url} proxy=${!!proxyStr} ua=${!!options?.userAgent}`,
    );
    const res = await providerJson(
      await fetch('https://api.capsolver.com/createTask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: this._creds.capsolver, task }),
      }),
      'capsolver AntiCloudflare createTask',
    );
    if (res.errorId) {
      console.log(
        `[captcha:api] capsolver AntiCloudflare createTask err: ${res.errorCode} ${res.errorDescription}`,
      );
      markAllProvidersFailed('cloudflare');
      return null;
    }
    const taskId = res.taskId;
    if (!taskId) {
      console.log('[captcha:api] capsolver AntiCloudflare no taskId');
      markAllProvidersFailed('cloudflare');
      return null;
    }
    console.log(`[captcha:api] capsolver AntiCloudflare taskId=${taskId}`);
    const tr = await readUntilSolved(
      async () =>
        providerJson(
          await fetch('https://api.capsolver.com/getTaskResult', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clientKey: this._creds.capsolver, taskId }),
          }),
          `capsolver getTaskResult for AntiCloudflare task ${taskId}`,
        ),
      (answer) => !answer.errorId && answer.status === 'processing',
    );
    if (tr.errorId) {
      console.log(
        `[captcha:api] capsolver AntiCloudflare err: ${tr.errorCode} ${tr.errorDescription}`,
      );
      markAllProvidersFailed('cloudflare');
      return null;
    }
    if (tr.status !== 'ready') {
      console.log(
        `[captcha:api] capsolver AntiCloudflare task ${taskId} answered status ${tr.status}, neither processing nor ready: ${JSON.stringify(tr)}`,
      );
      markAllProvidersFailed('cloudflare');
      return null;
    }
    // The clearance is bound to the browser that earned it: a solution without
    // its token, user agent or cookies is unusable and is named.
    const sol = tr.solution;
    const missing = [
      typeof sol?.token === 'string' && sol.token ? null : 'token',
      typeof sol?.userAgent === 'string' && sol.userAgent ? null : 'user agent',
      sol?.cookies && typeof sol.cookies === 'object' ? null : 'cookies',
    ].filter((part) => part !== null);
    if (missing.length) {
      console.log(
        `[captcha:api] capsolver AntiCloudflare task ${taskId} returned no ${missing.join(', ')}: ${JSON.stringify(tr.solution)}`,
      );
      markAllProvidersFailed('cloudflare');
      return null;
    }
    const { token, userAgent, cookies } = sol;
    console.log(
      `[captcha:solver] Cloudflare solved via capsolver token_chars=${token.length} ua=${userAgent}`,
    );
    costTracker.recordCaptcha('capsolver', 'cloudflare');
    return { token, userAgent, cookies };
  }

  /** An hCaptcha token; see ./providers/hcaptcha.ts. */
  async solveHcaptcha(
    sitekey: string,
    url: string,
    options?: HcaptchaOptions,
  ): Promise<string | null> {
    await this._ensureInit();
    return solveHcaptchaToken(this._creds, sitekey, url, options);
  }

  /** PerimeterX cookies; see ./providers/perimeterx.ts. */
  async solvePerimeterX(
    url: string,
    userAgent: string,
    cookies?: Array<{ name: string; value: string; domain?: string }>,
    proxy?: string,
  ): Promise<Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
  }> | null> {
    await this._ensureInit();
    return solvePerimeterXCookies(this._creds, url, userAgent, cookies, proxy);
  }

  /** A FunCaptcha token; see ./providers/funcaptcha.ts. */
  async solveFuncaptcha(
    publicKey: string,
    url: string,
    subdomain?: string,
    blob?: string,
  ): Promise<string | null> {
    await this._ensureInit();
    return solveFuncaptchaToken(this._creds, publicKey, url, subdomain, blob);
  }
}
