/**
 * hCaptcha, plain or enterprise, through every solving service whose key
 * Weles holds, in order: AntiCaptcha, CapMonster, CapSolver. A proxied task
 * names the proxy by IP address and port, which the services require; a
 * proxy that names no port or does not resolve fails the solve with the host
 * and cause, since no service could take it.
 */

import { lookup } from 'node:dns/promises';
import { markAllProvidersFailed, markCaptchaChallenge } from '../events.js';
import {
  apiSolve,
  firstSolved,
  type CaptchaCredentials,
  type ServiceAttempt,
} from './api.js';

export type HcaptchaOptions = {
  enterprisePayload?: { rqdata: string; rqtoken?: string };
  userAgent?: string;
  proxy?: { server: string; username?: string; password?: string };
};

// The token the first service solves, or an error naming every service tried
// and why it did not solve.
export async function solveHcaptchaToken(
  creds: CaptchaCredentials,
  sitekey: string,
  url: string,
  options?: HcaptchaOptions,
): Promise<string> {
  markCaptchaChallenge(); // G8
  const enterprise = !!options?.enterprisePayload;
  const useProxy = !!options?.proxy?.server;
  const baseTask: Record<string, any> = {
    type: useProxy ? 'HCaptchaTask' : 'HCaptchaTaskProxyless',
    websiteURL: url,
    websiteKey: sitekey,
  };
  if (enterprise) {
    baseTask.isEnterprise = true;
    baseTask.enterprisePayload = {
      rqdata: options!.enterprisePayload!.rqdata,
    };
  }
  if (options?.userAgent) baseTask.userAgent = options.userAgent;
  if (useProxy) {
    const u = new URL(options!.proxy!.server);
    if (!u.port) {
      markAllProvidersFailed('hcaptcha', []);
      throw new Error(
        `hCaptcha proxy ${u.hostname} names no port; the solving services need one`,
      );
    }
    let ip: string;
    try {
      ({ address: ip } = await lookup(u.hostname));
    } catch (error) {
      markAllProvidersFailed('hcaptcha', []);
      throw new Error(
        `hCaptcha proxy ${u.hostname} did not resolve to an address the solving services accept: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    Object.assign(baseTask, {
      proxyType: u.protocol.replace(':', ''),
      proxyAddress: ip,
      proxyPort: Number(u.port),
      proxyLogin: options!.proxy!.username,
      proxyPassword: options!.proxy!.password,
    });
  }
  console.log(
    `[captcha:solver] solveHcaptcha enterprise=${enterprise} proxy=${useProxy ? `${baseTask.proxyAddress}:${baseTask.proxyPort}` : 'none'} sitekey=${sitekey}`,
  );
  // Try all services: anticaptcha → capmonster → capsolver
  const attempts: ServiceAttempt[] = [];
  const anticaptcha = creds.anticaptcha;
  if (anticaptcha) {
    attempts.push({
      service: 'anticaptcha',
      solve: () =>
        apiSolve('https://api.anti-captcha.com', anticaptcha, baseTask),
    });
  }
  const capmonster = creds.capmonster;
  if (capmonster) {
    attempts.push({
      service: 'capmonster',
      solve: () =>
        apiSolve('https://api.capmonster.cloud', capmonster, baseTask),
    });
  }
  const capsolver = creds.capsolver;
  if (capsolver) {
    // CapSolver: HCaptchaEnterpriseTaskProxyLess is its own task type;
    // HCaptchaTaskProxyless + isEnterprise returns ERROR_INVALID_TASK_DATA.
    const t: Record<string, any> = {
      ...baseTask,
      type: enterprise
        ? useProxy
          ? 'HCaptchaEnterpriseTask'
          : 'HCaptchaEnterpriseTaskProxyLess'
        : useProxy
          ? 'HCaptchaTask'
          : 'HCaptchaTaskProxyLess',
    };
    delete t.isEnterprise;
    attempts.push({
      service: 'capsolver',
      solve: () => apiSolve('https://api.capsolver.com', capsolver, t),
    });
  }
  return firstSolved('hcaptcha', attempts);
}
