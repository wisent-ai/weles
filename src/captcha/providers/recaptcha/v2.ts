// reCAPTCHA v2 tokens from the remote providers, tried in the order their
// provenance has proven useful, with the in-page tile solver as the last
// resort for an enterprise challenge. The CaptchaSolver class keeps the
// credential loading and calls this with its credentials. The answer is the
// token, or true when the tile solver passed the challenge in the page; when
// nothing solves it the error names every service tried and why it did not.
import { solveRecaptchaV2 as solveRecaptchaV2InPage } from '../../recaptcha.js';
import { markCaptchaChallenge, markAllProvidersFailed } from '../../events.js';
import {
  apiSolve,
  proxyTaskFields,
  trySolved,
  unsolved,
  type CaptchaCredentials,
  type ProxyCredentials,
  type ServiceAttempt,
} from '../api.js';
import {
  solveRecaptchaV2Nopecha,
  solveRecaptchaV2TwoCaptcha,
} from './services.js';

/** One task a service is asked to solve, and whether it is its enterprise task. */
type V2Task = { type: string; enterprise: boolean };

type Page = any;

export async function solveRecaptchaV2Token(
  creds: CaptchaCredentials,
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
  markCaptchaChallenge(); // G8: a challenge was faced (flips challenge_faced even if every provider fails)
  // The services solve for a page address; one that names none is refused
  // here rather than sent as an empty websiteURL.
  const url =
    options?.url ?? (typeof page?.url === 'function' ? page.url() : page?.url);
  if (!url) {
    markAllProvidersFailed('recaptcha_v2', []);
    throw new Error(
      'reCAPTCHA v2 solve names no page URL: neither options.url nor the page states one',
    );
  }
  const isInv = !!options?.invisible;
  const isEnt = !!options?.enterprise;
  // A proxy the run states is the exit the token must be solved from; one the
  // services cannot use fails the solve with its cause instead of the token
  // being solved proxyless from another address.
  let proxy: Record<string, any> | null;
  try {
    proxy = await proxyTaskFields(options?.proxy);
  } catch (error) {
    markAllProvidersFailed('recaptcha_v2', []);
    throw error;
  }
  const attempts: ServiceAttempt[] = [];

  // NopeCHA Token API first — different token provenance may bypass LinkedIn rejection.
  const nopecha = creds.nopecha;
  if (nopecha) {
    attempts.push({
      service: 'nopecha',
      solve: () =>
        solveRecaptchaV2Nopecha(
          nopecha,
          sitekey,
          url,
          isInv,
          isEnt,
          options?.proxy,
          options?.dataS,
        ),
    });
  }

  // CapMonster: try enterprise first, then standard (with invisible flag when applicable).
  const capmonster = creds.capmonster;
  if (capmonster) {
    const types: V2Task[] = [];
    if (isEnt)
      types.push({
        type: proxy
          ? 'RecaptchaV2EnterpriseTask'
          : 'RecaptchaV2EnterpriseTaskProxyless',
        enterprise: true,
      });
    types.push({
      type: proxy ? 'NoCaptchaTask' : 'NoCaptchaTaskProxyless',
      enterprise: false,
    });
    for (const { type: tType, enterprise } of types) {
      const task: Record<string, any> = {
        type: tType,
        websiteURL: url,
        websiteKey: sitekey,
      };
      if (!enterprise && isInv) task.isInvisible = true;
      if (options?.dataS) {
        if (enterprise) {
          task.enterprisePayload = { s: options.dataS };
        } else {
          task.recaptchaDataSValue = options.dataS;
        }
      }
      if (proxy) Object.assign(task, proxy);
      attempts.push({
        service: 'capmonster',
        solve: () => apiSolve('https://api.capmonster.cloud', capmonster, task),
      });
    }
  }
  // CapSolver: try enterprise first, then standard (with invisible flag when applicable).
  const capsolver = creds.capsolver;
  if (capsolver) {
    const types: V2Task[] = [];
    if (isEnt)
      types.push({
        type: proxy
          ? 'ReCaptchaV2EnterpriseTask'
          : 'ReCaptchaV2EnterpriseTaskProxyLess',
        enterprise: true,
      });
    types.push({
      type: proxy ? 'ReCaptchaV2Task' : 'ReCaptchaV2TaskProxyLess',
      enterprise: false,
    });
    for (const { type: taskType, enterprise } of types) {
      const task: Record<string, any> = {
        type: taskType,
        websiteURL: url,
        websiteKey: sitekey,
      };
      if (isInv) task.isInvisible = true;
      if (options?.dataS && enterprise) {
        task.enterprisePayload = { s: options.dataS };
      }
      if (proxy) Object.assign(task, proxy);
      attempts.push({
        service: 'capsolver',
        solve: () => apiSolve('https://api.capsolver.com', capsolver, task),
      });
    }
  }
  // AntiCaptcha.
  const anticaptcha = creds.anticaptcha;
  if (anticaptcha) {
    const task: Record<string, any> = {
      type: proxy ? 'RecaptchaV2Task' : 'RecaptchaV2TaskProxyless',
      websiteURL: url,
      websiteKey: sitekey,
      isEnterprise: isEnt,
    };
    if (isInv) task.isInvisible = true;
    if (options?.dataS) task.recaptchaDataSValue = options.dataS;
    if (proxy) Object.assign(task, proxy);
    attempts.push({
      service: 'anticaptcha',
      solve: () => apiSolve('https://api.anti-captcha.com', anticaptcha, task),
    });
  }
  // 2captcha last of the services.
  const twocaptcha = creds.twocaptcha;
  if (twocaptcha) {
    attempts.push({
      service: 'twocaptcha',
      solve: () =>
        solveRecaptchaV2TwoCaptcha(
          twocaptcha,
          sitekey,
          url,
          isInv,
          isEnt,
          options?.proxy,
          options?.dataS,
        ),
    });
  }
  const outcome = await trySolved('recaptcha_v2', attempts);
  if ('token' in outcome) return outcome.token;
  // Image-grid path for cases where API solvers fail and Google's
  // standard frame chain IS present (non-LinkedIn enterprise sites).
  if (isEnt) {
    if (await solveRecaptchaV2InPage(page)) return true;
    throw unsolved('recaptcha_v2', [
      ...outcome.causes,
      'in-page tile solver: the challenge was not passed in the page',
    ]);
  }
  throw unsolved('recaptcha_v2', outcome.causes);
}
