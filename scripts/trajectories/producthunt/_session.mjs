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
  clickOAuthProviderButton,
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

// Pick the first product launch URL from the PH homepage. Both upvote and
// comment trajectories need a /products/<slug> URL because that's the only
// page shape that renders both the vote button and the tiptap composer
// (verified 2026-05-02 via .work/ph-probe). Returns null if nothing
// suitable is found — callers should treat that as a soft fail and skip.
export async function pickFirstProductLaunchUrl(s) {
  // Prefer /products/<slug> — verified via .work/ph-probe to be the only
  // page shape with both the upvote button and the tiptap composer.
  // /posts/new is the "submit launch" form (no composer), /posts/<id> is
  // the legacy URL that PH 308-redirects to /products/<slug>.
  const href = await s.page.evaluate(`(() => {
    function pick(prefix) {
      var as = Array.from(document.querySelectorAll('a[href*="' + prefix + '"]'));
      for (var a of as) {
        var h = a.getAttribute('href') || '';
        if (h.includes('?ref=footer')) continue;
        if (h.includes('/reviews')) continue;
        if (h.includes('/alternatives')) continue;
        var slug = (h.match(new RegExp('\\\\' + prefix + '([^/?#]+)')) || [])[1];
        if (!slug) continue;
        if (slug === 'new' || slug === 'launching-soon' || slug === 'all') continue;
        return h;
      }
      return null;
    }
    return pick('/products/') || pick('/posts/');
  })()`).catch(() => null);
  if (!href) return null;
  return href.startsWith('http') ? href : new URL(href, 'https://www.producthunt.com').toString();
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
  // Deterministic accessible-name match — avoids vision misreading the adjacent
  // Google/Apple buttons in the provider list at larger viewports.
  const twitterLabel = /^\s*(Sign in with X|Continue with X|Sign up with Twitter|Continue with Twitter)\s*$/i;
  const clickedTw = await clickOAuthProviderButton(s, twitterLabel);
  if (!clickedTw) {
    await s.click('Sign in with X').catch(() => {});
    await s.click('Continue with Twitter').catch(() => {});
  }
  await sleep(6);

  await handleOAuthConsent(s);
  await waitForNavBackTo(s.page, 'producthunt.com', ['/auth/', 'twitter.com', 'x.com'], 40);

  const cleared = await clearReCaptchaGate(s, new CaptchaSolver(), '/captcha_verification');
  if (!cleared) throw new Error('captcha_gate_not_cleared');
  return true;
}
