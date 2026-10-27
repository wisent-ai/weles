// reCAPTCHA v2 tokens from the two services that are not task APIs: 2captcha's
// in.php/res.php pair and NopeCHA's token API. Each is read until the service
// stops solving the task, and answers the token or throws naming the service,
// the job and its refusal.
import { constants } from 'node:http2';

import {
  nopechaProxyFields,
  providerJson,
  readUntilSolved,
  twoCaptchaSolve,
  type ProxyCredentials,
} from '../api.js';

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
  return twoCaptchaSolve(key, params, 'recaptcha v2');
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
    throw new Error(`nopecha recaptcha2 answered no job: ${JSON.stringify(post)}`);
  }
  console.log(`[captcha:api] nopecha recaptcha2 jobId=${jobId}`);
  // NopeCHA answers a job it is still solving with 409 Conflict; the token
  // is read again until it answers anything else.
  const { status, answer: res } = await readUntilSolved(
    async () => {
      const response = await fetch(
        `https://api.nopecha.com/v1/token/recaptcha2?id=${jobId}`,
        { headers: { Authorization: `Basic ${k}` } },
      );
      return {
        status: response.status,
        answer: await providerJson(
          response,
          `nopecha recaptcha2 token read for job ${jobId}`,
        ),
      };
    },
    (read) => read.status === constants.HTTP_STATUS_CONFLICT,
  );
  if (typeof res?.data === 'string' && res.data) {
    console.log(
      `[captcha:api] nopecha recaptcha2 solved token_chars=${res.data.length}`,
    );
    return res.data;
  }
  throw new Error(
    `nopecha recaptcha2 job ${jobId} answered HTTP ${status} without a token: ${JSON.stringify(res)}`,
  );
}
