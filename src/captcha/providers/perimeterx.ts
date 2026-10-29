/**
 * PerimeterX (HUMAN Security) — used by LinkedIn checkpointV2 / NewYorkTimes /
 * Zillow. Solved through CapSolver's AntiPerimeterx task when its key is held,
 * then through nocaptcha.io wanda/perimeterx/universal, either of which returns
 * the _px3/_pxde/pxcts cookies that satisfy the challenge. The keys are
 * acquired from their exact Skarbiec items. Returns Playwright-shaped cookies
 * ready for ctx.addCookies(); the caller then re-navigates and proceeds. When
 * neither service solves it, the error names each and why it did not.
 */

import { markCaptchaChallenge } from '../events.js';
import {
  firstSolved,
  providerJson,
  solvedTask,
  type CaptchaCredentials,
  type ServiceAttempt,
} from './api.js';

type PlaywrightCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
};

// The page's cookies by name, as both services take them.
function cookieMap(
  cookies?: Array<{ name: string; value: string; domain?: string }>,
): Record<string, string> {
  const map: Record<string, string> = {};
  if (cookies)
    for (const c of cookies) if (c?.name && c?.value) map[c.name] = c.value;
  return map;
}

// The cookies a service answered, scoped to the page's registrable domain;
// an answer that holds no cookie object is named by the caller.
function playwrightCookies(
  answered: unknown,
  domain: string,
): PlaywrightCookie[] | null {
  if (!answered || typeof answered !== 'object') return null;
  return Object.entries(answered).map(([name, value]) => ({
    name,
    value: String(value),
    domain,
    path: '/',
  }));
}

// CapSolver's AntiPerimeterx task: the cookies it answers, or an error naming
// the task and CapSolver's refusal.
async function capsolverCookies(
  clientKey: string,
  url: string,
  userAgent: string,
  domain: string,
  cookies?: Array<{ name: string; value: string; domain?: string }>,
  proxy?: string,
): Promise<PlaywrightCookie[]> {
  const task: Record<string, unknown> = {
    type: proxy ? 'AntiPerimeterxTask' : 'AntiPerimeterxTaskProxyLess',
    websiteURL: url,
    userAgent,
  };
  const pageCookies = cookieMap(cookies);
  if (Object.keys(pageCookies).length) task.cookies = pageCookies;
  if (proxy) {
    const pp = new URL(proxy);
    task.proxyType = pp.protocol.replace(':', '');
    task.proxyAddress = pp.hostname;
    task.proxyPort = Number(pp.port);
    if (pp.username) task.proxyLogin = decodeURIComponent(pp.username);
    if (pp.password) task.proxyPassword = decodeURIComponent(pp.password);
  }
  console.log(
    `[captcha:api] capsolver AntiPerimeterx createTask type=${task.type} url=${url}`,
  );
  const tr = await solvedTask('https://api.capsolver.com', clientKey, task);
  const out = playwrightCookies(tr.solution?.cookies, domain);
  if (!out?.length) {
    throw new Error(
      `capsolver AntiPerimeterx task ${tr.taskId} is ready but its solution carries no cookies: ${JSON.stringify(tr.solution)}`,
    );
  }
  return out;
}

// nocaptcha.io's universal PerimeterX solve: the cookies it answers, or an
// error naming its refusal.
async function nocaptchaCookies(
  token: string,
  url: string,
  userAgent: string,
  domain: string,
  cookies?: Array<{ name: string; value: string; domain?: string }>,
  proxy?: string,
): Promise<PlaywrightCookie[]> {
  const body: Record<string, unknown> = {
    href: url,
    user_agent: userAgent,
    cookies: cookieMap(cookies),
  };
  if (proxy) {
    const p = new URL(proxy);
    body.proxy = p.username
      ? `${p.username}:${p.password}@${p.hostname}:${p.port}`
      : `${p.hostname}:${p.port}`;
  }
  console.log(
    `[captcha:api] nocaptcha PerimeterX solve href=${url} proxy=${!!proxy}`,
  );
  const j = await providerJson(
    await fetch('http://api.nocaptcha.io/api/wanda/perimeterx/universal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Token': token },
      body: JSON.stringify(body),
    }),
    'nocaptcha PerimeterX solve',
  );
  // nocaptcha answers a truthy status for a solve and a falsy one for a refusal.
  if (!j?.status) {
    throw new Error(
      `nocaptcha refused the PerimeterX solve: ${JSON.stringify(j)}`,
    );
  }
  const out = playwrightCookies(j.data?.cookies, domain);
  if (!out?.length) {
    throw new Error(
      `nocaptcha solved PerimeterX but its answer carries no cookies: ${JSON.stringify(j.data)}`,
    );
  }
  return out;
}

export async function solvePerimeterXCookies(
  creds: CaptchaCredentials,
  url: string,
  userAgent: string,
  cookies?: Array<{ name: string; value: string; domain?: string }>,
  proxy?: string,
): Promise<PlaywrightCookie[]> {
  markCaptchaChallenge(); // G8
  const u = new URL(url);
  const domain = '.' + u.hostname.replace(/^www\./, '');
  const attempts: ServiceAttempt<PlaywrightCookie[]>[] = [];
  const capsolver = creds.capsolver;
  if (capsolver) {
    attempts.push({
      service: 'capsolver',
      solve: () =>
        capsolverCookies(capsolver, url, userAgent, domain, cookies, proxy),
    });
  }
  const nocaptcha = creds.nocaptcha;
  if (nocaptcha) {
    attempts.push({
      service: 'nocaptcha',
      solve: () =>
        nocaptchaCookies(nocaptcha, url, userAgent, domain, cookies, proxy),
    });
  }
  return firstSolved('perimeterx', attempts);
}
