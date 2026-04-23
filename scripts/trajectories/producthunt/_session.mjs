// Shared session helpers for ProductHunt trajectories.
//
// Everything here runs inside a WSession. Cross-platform OAuth primitives
// (cookie injection, consent-dialog loop, captcha-gate clear) live in
// src/platforms/_shared/cross_platform_oauth.ts — this file only composes
// them into the PH-specific click sequence.

import { getSocialAccount } from '../../../dist/utils/credentials.js';
import { CaptchaSolver } from '../../../dist/captcha/solver.js';
import {
  injectProviderCookies,
  handleOAuthConsent,
  waitForNavBackTo,
  clearReCaptchaGate,
} from '../../../dist/platforms/_shared/cross_platform_oauth.js';

const sleep = (sec) => new Promise(r => setTimeout(r, sec * 1000));

// PH-specific: PH cookies still need their own injector because the "provider"
// here is the target site, not an OAuth source. The cross_platform_oauth
// helper handles OAuth-provider cookies (.x.com, .instagram.com, etc.).
export async function injectPHCookies(s, cookies) {
  const norm = cookies
    .filter(c => c.name && c.value)
    .map(c => ({
      name: c.name, value: c.value,
      domain: c.domain?.includes('producthunt.com') ? c.domain : '.producthunt.com',
      path: c.path || '/', secure: c.secure ?? true,
      httpOnly: c.httpOnly ?? false, sameSite: c.sameSite || 'Lax',
      ...(c.expires && c.expires > 0 ? { expires: c.expires } : {}),
    }));
  await s.ctx.addCookies(norm);
  return norm.length;
}

// Drive the PH-specific Twitter SSO click sequence. All cross-platform
// primitives (cookies, consent, captcha) come from _shared/.
export async function loginViaTwitter(s) {
  const tw = await getSocialAccount('twitter');
  if (!tw) throw new Error('no_twitter_account');
  const twCookies = tw.metadata?.cookies ?? [];
  if (twCookies.length < 2) throw new Error('twitter_account_missing_cookies');
  console.log(`[ph-session] OAuth via twitter account ${tw.username}`);
  await injectProviderCookies(s.ctx, 'twitter', twCookies);

  await s.goto('https://www.producthunt.com/');
  await sleep(3);
  await s.click('Sign in').catch(() => {});
  await sleep(2);
  await s.click('Sign in with X').catch(() => {});
  await s.click('Continue with Twitter').catch(() => {});
  await sleep(6);

  await handleOAuthConsent(s);
  await waitForNavBackTo(s.page, 'producthunt.com', ['/auth/', 'twitter.com', 'x.com'], 40);

  const cleared = await clearReCaptchaGate(s, new CaptchaSolver(), '/captcha_verification');
  if (!cleared) throw new Error('captcha_gate_not_cleared');
  return true;
}
