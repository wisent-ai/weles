// reCAPTCHA v3 tokens from the remote providers, tried in the order their
// provenance has proven useful: NopeCHA, CapSolver, AntiCaptcha. The first
// token answers; when none does, the error names every service tried and why
// it did not solve. `action` is the one the page passes to
// grecaptcha.execute: a token minted for another action fails the site's
// check, so the caller states it.
import { markCaptchaChallenge } from '../../events.js';
import {
  apiSolve,
  firstSolved,
  nopechaProxyFields,
  providerJson,
  type CaptchaCredentials,
  type ProxyCredentials,
  type ServiceAttempt,
} from '../api.js';
import { nopechaToken } from './services.js';

// AntiCaptcha queues reCAPTCHA v3 workers by the score they earn and takes
// minScore as one of three queues, 0.3, 0.7 or 0.9, each priced by its idle
// workers (https://anti-captcha.com/apidoc/task-types/RecaptchaV3TaskProxyless).
// The middle queue is the one this chain has always asked for.
const ANTICAPTCHA_V3_QUEUE = 0.7;

async function solveRecaptchaV3Nopecha(
  k: string,
  sitekey: string,
  url: string,
  action: string,
  proxy?: ProxyCredentials,
  dataS?: string,
  enterprise?: boolean,
): Promise<string> {
  const body: Record<string, any> = { sitekey, url };
  const data: Record<string, any> = { action, theme: 'light' };
  if (dataS) data.s = dataS;
  body.data = data;
  if (enterprise) body.enterprise = true;
  const np = nopechaProxyFields(proxy);
  if (np) body.proxy = np;
  console.log(
    `[captcha:api] nopecha recaptcha3 create action=${action} enterprise=${!!enterprise} proxy=${!!np}`,
  );
  const post = await providerJson(
    await fetch('https://api.nopecha.com/v1/token/recaptcha3', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${k}`,
      },
      body: JSON.stringify(body),
    }),
    'nopecha recaptcha3 create',
  );
  const jobId = post?.data;
  if (!jobId) {
    throw new Error(`nopecha recaptcha3 answered no job: ${JSON.stringify(post)}`);
  }
  console.log(`[captcha:api] nopecha recaptcha3 jobId=${jobId}`);
  // The job is read until it is solved, as the v2 path reads it, so the
  // token NopeCHA charges for is collected.
  return nopechaToken('recaptcha3', k, jobId);
}

export async function solveRecaptchaV3Token(
  creds: CaptchaCredentials,
  sitekey: string,
  url: string,
  action: string,
  options?: { proxy?: ProxyCredentials; dataS?: string; enterprise?: boolean },
): Promise<string> {
  markCaptchaChallenge(); // G8
  const attempts: ServiceAttempt[] = [];
  const nopecha = creds.nopecha;
  if (nopecha) {
    attempts.push({
      service: 'nopecha',
      solve: () =>
        solveRecaptchaV3Nopecha(
          nopecha,
          sitekey,
          url,
          action,
          options?.proxy,
          options?.dataS,
          options?.enterprise,
        ),
    });
  }
  // CapSolver takes the site's action and no score
  // (https://docs.capsolver.com/guide/captcha/ReCaptchaV3); its enterprise
  // task first, then the standard one.
  const capsolver = creds.capsolver;
  if (capsolver) {
    for (const type of ['ReCaptchaV3EnterpriseTaskProxyLess', 'ReCaptchaV3TaskProxyLess']) {
      attempts.push({
        service: 'capsolver',
        solve: () =>
          apiSolve('https://api.capsolver.com', capsolver, {
            type,
            websiteURL: url,
            websiteKey: sitekey,
            pageAction: action,
          }),
      });
    }
  }
  const anticaptcha = creds.anticaptcha;
  if (anticaptcha) {
    attempts.push({
      service: 'anticaptcha',
      solve: () =>
        apiSolve('https://api.anti-captcha.com', anticaptcha, {
          type: 'RecaptchaV3TaskProxyless',
          websiteURL: url,
          websiteKey: sitekey,
          minScore: ANTICAPTCHA_V3_QUEUE,
          pageAction: action,
        }),
    });
  }
  return firstSolved('recaptcha_v3', attempts);
}
