// reCAPTCHA v2 tokens from the two services that are not task APIs: 2captcha's
// in.php, which pushes its answer to this run's pingback, and NopeCHA's token
// API, which pushes nothing and is read until it stops solving the job (the
// one reader both the v2 and the v3 NopeCHA paths use). Each answers the
// token or throws naming the service, the job and its refusal.
import { constants } from 'node:http2';
import { setTimeout as waitFor } from 'node:timers/promises';

import {
  nopechaProxyFields,
  providerJson,
  twoCaptchaSolve,
  type ProxyCredentials,
} from '../api.js';

// NopeCHA answers a token job it is still solving with HTTP 409 and states
// the wait before the next read: "Job is incomplete. Recommended wait time
// before retrying the request is 500ms."
// (https://nopecha.com/api-reference#409_IncompleteJob)
const NOPECHA_INCOMPLETE_JOB_WAIT_MS = 500;

/**
 * The token of NopeCHA job `jobId` on its `endpoint` (recaptcha2 or
 * recaptcha3). NopeCHA takes no callback and states no time by which a job
 * is solved, so, like a provider that pushes its answer (../callback.ts),
 * the job is read until it is no longer incomplete, NopeCHA's own wait
 * apart, and the wait is said once, naming the job, so a run that waits
 * shows what it waits on until it is cancelled (`weles runs cancel
 * <run-id>`). A job that ends without a token is refused naming the job,
 * NopeCHA's answer and the time waited.
 */
export async function nopechaToken(
  endpoint: 'recaptcha2' | 'recaptcha3',
  key: string,
  jobId: string,
): Promise<string> {
  const startedAt = Date.now();
  let announced = false;
  for (;;) {
    const response = await fetch(
      `https://api.nopecha.com/v1/token/${endpoint}?id=${encodeURIComponent(jobId)}`,
      { headers: { Authorization: `Basic ${key}` } },
    );
    const answer = await providerJson(
      response,
      `nopecha ${endpoint} token read for job ${jobId}`,
    );
    if (response.status !== constants.HTTP_STATUS_CONFLICT) {
      const waited = Date.now() - startedAt;
      if (typeof answer?.data === 'string' && answer.data) {
        console.log(
          `[captcha:api] nopecha ${endpoint} solved token_chars=${answer.data.length} after ${waited}ms`,
        );
        return answer.data;
      }
      throw new Error(
        `nopecha ${endpoint} job ${jobId} answered HTTP ${response.status} without a token after ${waited}ms: ${JSON.stringify(answer)}`,
      );
    }
    if (!announced) {
      console.log(
        `[captcha:api] nopecha ${endpoint} job ${jobId} is still being solved; reading it again every ${NOPECHA_INCOMPLETE_JOB_WAIT_MS}ms, as NopeCHA asks, until it answers or the run is cancelled`,
      );
      announced = true;
    }
    await waitFor(NOPECHA_INCOMPLETE_JOB_WAIT_MS);
  }
}

export async function solveRecaptchaV2TwoCaptcha(
  key: string,
  sitekey: string,
  url: string,
  invisible: boolean,
  enterprise: boolean,
  proxy?: ProxyCredentials,
  dataS?: string,
): Promise<string> {
  const params = new URLSearchParams({
    key,
    method: 'userrecaptcha',
    googlekey: sitekey,
    pageurl: url,
    json: '1',
  });
  if (invisible) params.set('invisible', '1');
  if (enterprise) params.set('enterprise', '1');
  if (dataS) params.set('data-s', dataS);
  if (proxy?.server) {
    const u = new URL(proxy.server);
    const proxyAddr = `${u.hostname}:${u.port}`;
    const proxyType = u.protocol.replace(':', '');
    if (proxy.username && proxy.password === undefined)
      throw new Error(
        `captcha proxy ${u.hostname} names the user ${proxy.username} but no password; 2captcha takes the proxy login as user and password together`,
      );
    params.set(
      'proxy',
      proxy.username
        ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password!)}@${proxyAddr}`
        : proxyAddr,
    );
    params.set('proxytype', proxyType);
  }
  return twoCaptchaSolve(params, 'recaptcha v2');
}

export async function solveRecaptchaV2Nopecha(
  k: string,
  sitekey: string,
  url: string,
  invisible: boolean,
  enterprise: boolean,
  proxy?: ProxyCredentials,
  dataS?: string,
): Promise<string> {
  const body: Record<string, any> = { sitekey, url };
  const data: Record<string, any> = { theme: 'light' };
  if (dataS) data.s = dataS;
  if (invisible) data.invisible = true;
  if (Object.keys(data).length) body.data = data;
  if (enterprise) body.enterprise = true;
  const np = nopechaProxyFields(proxy);
  if (np) body.proxy = np;
  console.log(
    `[captcha:api] nopecha recaptcha2 create enterprise=${enterprise} invisible=${invisible} proxy=${!!np}`,
  );
  const post = await providerJson(
    await fetch('https://api.nopecha.com/v1/token/recaptcha2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${k}`,
      },
      body: JSON.stringify(body),
    }),
    'nopecha recaptcha2 create',
  );
  const jobId = post?.data;
  if (!jobId) {
    throw new Error(
      `nopecha recaptcha2 answered no job: ${JSON.stringify(post)}`,
    );
  }
  console.log(`[captcha:api] nopecha recaptcha2 jobId=${jobId}`);
  return nopechaToken('recaptcha2', k, jobId);
}
