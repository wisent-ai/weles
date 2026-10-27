/**
 * FunCaptcha (Arkose Labs) through every solving service whose key Weles
 * holds, in order: AntiCaptcha, 2captcha, CapMonster, CapSolver. The first
 * token any of them returns answers the challenge; when none does, the error
 * names every service tried and why it did not solve.
 */

import { markCaptchaChallenge } from '../events.js';
import {
  apiSolve,
  firstSolved,
  twoCaptchaSolve,
  type CaptchaCredentials,
  type ServiceAttempt,
} from './api.js';

export async function solveFuncaptchaToken(
  creds: CaptchaCredentials,
  publicKey: string,
  url: string,
  subdomain?: string,
  blob?: string,
): Promise<string> {
  markCaptchaChallenge(); // G8
  console.log(
    `[captcha:solver] solveFuncaptcha pkey=${publicKey} subdomain=${subdomain} blob=${blob}...`,
  );
  const attempts: ServiceAttempt[] = [];
  const anticaptcha = creds.anticaptcha;
  if (anticaptcha) {
    const task: Record<string, any> = {
      type: 'FunCaptchaTaskProxyless',
      websiteURL: url,
      websitePublicKey: publicKey,
    };
    if (subdomain)
      task.funcaptchaApiJSSubdomain = subdomain
        .replace(/^https?:\/\//, '')
        .replace('iframe.arkoselabs.com', 'client-api.arkoselabs.com');
    if (blob) task.data = JSON.stringify({ blob });
    attempts.push({
      service: 'anticaptcha',
      solve: () => apiSolve('https://api.anti-captcha.com', anticaptcha, task),
    });
  }
  const twocaptcha = creds.twocaptcha;
  if (twocaptcha) {
    const sd = subdomain
      ? subdomain
          .replace(/^https?:\/\//, '')
          .replace('iframe.arkoselabs.com', 'client-api.arkoselabs.com')
      : '';
    const surl = sd ? `https://${sd}` : '';
    const params = new URLSearchParams({
      key: twocaptcha,
      method: 'funcaptcha',
      publickey: publicKey,
      pageurl: url,
      json: '1',
    });
    if (surl) params.set('surl', surl);
    if (blob) params.set('data[blob]', blob);
    console.log(`[captcha:api] 2captcha funcaptcha surl=${surl}`);
    attempts.push({
      service: 'twocaptcha',
      solve: () => twoCaptchaSolve(params, 'funcaptcha'),
    });
  }
  const capmonster = creds.capmonster;
  if (capmonster) {
    const task: Record<string, any> = {
      type: 'FunCaptchaTaskProxyless',
      websiteURL: url,
      websitePublicKey: publicKey,
    };
    if (subdomain)
      task.funcaptchaApiJSSubdomain = subdomain
        .replace(/^https?:\/\//, '')
        .replace('iframe.arkoselabs.com', 'client-api.arkoselabs.com');
    if (blob) task.data = JSON.stringify({ blob });
    attempts.push({
      service: 'capmonster',
      solve: () => apiSolve('https://api.capmonster.cloud', capmonster, task),
    });
  }
  const capsolver = creds.capsolver;
  if (capsolver) {
    const task: Record<string, any> = {
      type: 'FunCaptchaTaskProxyLess',
      websiteURL: url,
      websitePublicKey: publicKey,
    };
    if (subdomain) {
      let s = subdomain.startsWith('http') ? subdomain : `https://${subdomain}`;
      s = s.replace('iframe.arkoselabs.com', 'client-api.arkoselabs.com');
      task.funcaptchaApiJSSubdomain = s;
    }
    if (blob) task.data = JSON.stringify({ blob });
    attempts.push({
      service: 'capsolver',
      solve: () => apiSolve('https://api.capsolver.com', capsolver, task),
    });
  }
  return firstSolved('funcaptcha', attempts);
}
