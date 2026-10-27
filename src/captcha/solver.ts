/**
 * Unified CaptchaSolver — matches Python weles.captcha.solver API.
 * Wraps AntiCaptcha, 2captcha, CapSolver behind a single interface. Every
 * solve answers its solution or throws one error naming each service tried
 * and why it did not solve; nothing answers an unsolved challenge as null.
 */

import { getCaptchaCredentials } from '../utils/credentials.js';
import { markCaptchaChallenge, markAllProvidersFailed } from './events.js';
import {
  apiSolve,
  firstSolved,
  solvedTask,
  type CaptchaCredentials,
  type ProxyCredentials,
  type ServiceAttempt,
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

/** A Cloudflare clearance: bound to the user agent that earned it. */
type CloudflareClearance = {
  token: string;
  userAgent: string;
  cookies: Record<string, string>;
};

// CapSolver's AntiCloudflareTask: the clearance it pushes, or an error naming
// the task and CapSolver's refusal. The clearance is bound to the browser that
// earned it, so a solution without its token, user agent or cookies is named.
async function capsolverClearance(
  clientKey: string,
  task: Record<string, any>,
): Promise<CloudflareClearance> {
  const tr = await solvedTask('https://api.capsolver.com', clientKey, task);
  const taskId = tr.taskId;
  const sol = tr.solution;
  const missing: string[] = [];
  if (!(typeof sol?.token === 'string' && sol.token)) missing.push('token');
  if (!(typeof sol?.userAgent === 'string' && sol.userAgent)) missing.push('user agent');
  if (!(sol?.cookies && typeof sol.cookies === 'object')) missing.push('cookies');
  if (missing.length) {
    throw new Error(
      `capsolver AntiCloudflare task ${taskId} returned no ${missing.join(', ')}: ${JSON.stringify(sol)}`,
    );
  }
  const { token, userAgent, cookies } = sol;
  console.log(
    `[captcha:solver] Cloudflare solved via capsolver token_chars=${token.length} ua=${userAgent}`,
  );
  return { token, userAgent, cookies };
}

export class CaptchaSolver {
  private _creds: CaptchaCredentials;
  private _initialized = false;

  // Credentials a caller hands in; any service it leaves out is read from Skarbiec in _ensureInit.
  constructor(credentials?: CaptchaCredentials) {
    this._creds = { ...credentials };
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
    return s;
  }

  /** The solving services whose credentials Weles holds, read from Skarbiec first. */
  async configuredServices(): Promise<string[]> {
    await this._ensureInit();
    return this.availableServices;
  }

  /** A reCAPTCHA v2 token, or true when the in-page tile solver passed it. */
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
  ): Promise<string | true> {
    await this._ensureInit();
    return solveRecaptchaV2Token(this._creds, page, sitekey, options);
  }

  /** A reCAPTCHA v3 token for the action the page passes to grecaptcha.execute. */
  async solveRecaptchaV3(
    sitekey: string,
    url: string,
    action: string,
    options?: {
      proxy?: ProxyCredentials;
      dataS?: string;
      enterprise?: boolean;
    },
  ): Promise<string> {
    await this._ensureInit();
    return solveRecaptchaV3Token(this._creds, sitekey, url, action, options);
  }

  async solveTurnstile(sitekey: string, url: string): Promise<string> {
    await this._ensureInit();
    markCaptchaChallenge(); // G8
    const attempts: ServiceAttempt[] = [];
    const capsolver = this._creds.capsolver;
    if (capsolver) {
      attempts.push({
        service: 'capsolver',
        solve: () =>
          apiSolve('https://api.capsolver.com', capsolver, {
            type: 'AntiTurnstileTaskProxyLess',
            websiteURL: url,
            websiteKey: sitekey,
          }),
      });
    }
    return firstSolved('turnstile', attempts);
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
  ): Promise<CloudflareClearance> {
    await this._ensureInit();
    markCaptchaChallenge(); // G8
    const task: Record<string, any> = {
      type: 'AntiCloudflareTask',
      websiteURL: url,
    };
    const proxy = options?.proxy;
    if (proxy?.server) {
      const u = new URL(proxy.server);
      // CapSolver takes host:port, or host:port:user:pass for a proxy that
      // logs in; the port is the proxy's own, never one assumed for its scheme.
      if (!u.port) {
        markAllProvidersFailed('cloudflare', []);
        throw new Error(
          `Cloudflare proxy ${u.host} names no port; CapSolver takes the proxy as host:port`,
        );
      }
      const parts = [u.hostname, u.port];
      if (proxy.username) {
        if (proxy.password === undefined) {
          markAllProvidersFailed('cloudflare', []);
          throw new Error(
            `Cloudflare proxy ${u.host} names the user ${proxy.username} but no password; CapSolver takes the login as user and password together`,
          );
        }
        parts.push(encodeURIComponent(proxy.username), encodeURIComponent(proxy.password));
      }
      task.proxy = parts.join(':');
    }
    if (options?.userAgent) task.userAgent = options.userAgent;
    console.log(
      `[captcha:solver] solveCloudflare url=${url} proxy=${!!task.proxy} ua=${!!options?.userAgent}`,
    );
    const attempts: ServiceAttempt<CloudflareClearance>[] = [];
    const capsolver = this._creds.capsolver;
    if (capsolver) {
      attempts.push({
        service: 'capsolver',
        solve: () => capsolverClearance(capsolver, task),
      });
    }
    return firstSolved('cloudflare', attempts);
  }

  /** An hCaptcha token; see ./providers/hcaptcha.ts. */
  async solveHcaptcha(
    sitekey: string,
    url: string,
    options?: HcaptchaOptions,
  ): Promise<string> {
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
  }>> {
    await this._ensureInit();
    return solvePerimeterXCookies(this._creds, url, userAgent, cookies, proxy);
  }

  /** A FunCaptcha token; see ./providers/funcaptcha.ts. */
  async solveFuncaptcha(
    publicKey: string,
    url: string,
    subdomain?: string,
    blob?: string,
  ): Promise<string> {
    await this._ensureInit();
    return solveFuncaptchaToken(this._creds, publicKey, url, subdomain, blob);
  }
}
