// Reaching the requested Google account: the persisted chooser first, then the
// identifier page and the automated sign-in.
//
// Moved verbatim during a split by responsibility, with the swallowed reads
// repaired: a cookie jar that cannot be read and an input count that cannot be
// taken were answered as "no cookies" and "no inputs", which is the same
// answer this code gives for a signed-out page. They now fail with their own
// error instead of routing the run into a second sign-in for no reason.

import { humanClickLocator, humanIdlePause } from '../../../../../dist/human/mouse.js';
import { googleSso } from '../../../_shared/services/google_sso.mjs';
import {
  NAV_TIMEOUT_MS,
  preferredGoogleAdsEmail,
  resolveSsoCreds,
} from './request.mjs';

let authFailure = null;

/// What stopped the sign-in, for the report the run writes.
export function lastAuthFailure() {
  return authFailure;
}

export function hasGoogleAuthCookie(cookies) {
  const names = new Set(cookies.filter((c) => /google\.com$|\.google\.com$/.test(c.domain || '')).map((c) => c.name));
  return names.has('SID') || names.has('__Secure-1PSID') || names.has('__Secure-3PSID');
}

export function isLoginUrl(url) {
  return /accounts\.google\.com|ServiceLogin|signin/i.test(url);
}

async function visibleEmailInputCount(page) {
  return await page.locator('input[type="email"], input[name="identifier"], input#identifierId')
    .filter({ visible: true })
    .count();
}

async function clickUseAnotherGoogleAccount(page) {
  const useAnother = page.getByText(/^Use another account$/i)
    .or(page.getByText(/^Add another account$/i))
    .or(page.getByText(/^Use another Google Account$/i))
    .first();
  if (await useAnother.isVisible().catch(() => false)) {
    console.log('[google-ads-keyword-planner] choosing "Use another account"');
    await humanClickLocator(page, useAnother);
    await humanIdlePause('deliberate');
    return true;
  }
  return false;
}

export async function continueFromAccountChooser(s) {
  const current = s.page.url?.() ?? '';
  if (!/accounts\.google\.com/.test(current)) return false;
  const cookies = await s.ctx.cookies();
  if (!hasGoogleAuthCookie(cookies)) return false;
  const email = preferredGoogleAdsEmail();
  const preferred = s.page.getByText(email, { exact: false }).filter({ visible: true }).first();
  if (await preferred.isVisible().catch(() => false)) {
    console.log(`[google-ads-keyword-planner] selecting persisted account ${email}`);
    await humanClickLocator(s.page, preferred);
    await humanIdlePause('deliberate');
    return true;
  }
  return false;
}

async function navigateGoogleIdentifier(page, email, returnUrl) {
  const login = new URL('https://accounts.google.com/signin/v2/identifier');
  login.searchParams.set('service', 'adwords');
  login.searchParams.set('continue', returnUrl);
  login.searchParams.set('flowName', 'GlifWebSignIn');
  login.searchParams.set('flowEntry', 'ServiceLogin');
  login.searchParams.set('Email', email);
  await page.goto(login.toString(), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }).catch((error) => {
    console.log(`[google-ads-keyword-planner] WARN: identifier navigation failed ${String(error?.message || error).slice(0, 240)}`);
  });
  await humanIdlePause('deliberate');
}

async function runPreferredGoogleSso(s, returnUrl) {
  const email = preferredGoogleAdsEmail();
  const creds = await resolveSsoCreds();
  if (!creds?.password) {
    console.log(`[google-ads-keyword-planner] FAIL: no SSO credentials available for ${email}`);
    authFailure = {
      blocked: 'missing_google_ads_credentials',
      email,
      detail: 'The dedicated Google Ads Skarbiec item is unavailable or incomplete.',
    };
    return false;
  }

  if (/accounts\.google\.com/.test(s.page.url?.() || '')) {
    if (!await visibleEmailInputCount(s.page)) {
      await clickUseAnotherGoogleAccount(s.page);
      await humanIdlePause('deliberate');
    }
  }

  const emailInputCount = await visibleEmailInputCount(s.page);
  if (!/accounts\.google\.com/.test(s.page.url?.() || '') || !emailInputCount) {
    await navigateGoogleIdentifier(s.page, email, returnUrl);
  }

  console.log(`[google-ads-keyword-planner] running automated Google SSO for ${creds.email} source=${creds.source || 'unknown'}`);
  const ok = await googleSso(s, creds, { originHost: 'ads.google.com' });
  if (!ok) {
    authFailure = {
      blocked: 'google_sso_failed',
      email: creds.email,
      source: creds.source || 'unknown',
      detail: 'Google SSO helper did not complete login.',
    };
    return false;
  }
  if (!/ads\.google\.com/.test(s.page.url?.() || '')) {
    await s.page.goto(returnUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }).catch((error) => {
      console.log(`[google-ads-keyword-planner] WARN: post-SSO return navigation failed ${String(error?.message || error).slice(0, 240)}`);
    });
  }
  await s.wait(8);
  return true;
}

export async function ensurePreferredGoogleAccount(s, returnUrl) {
  const email = preferredGoogleAdsEmail();
  if (/accounts\.google\.com/.test(s.page.url?.() || '')) {
    const selectedPersisted = await continueFromAccountChooser(s);
    if (selectedPersisted) {
      await s.wait(8);
      if (!/accounts\.google\.com/.test(s.page.url?.() || '')) return true;
    }
    return await runPreferredGoogleSso(s, returnUrl);
  }
  const text = await s.page.evaluate(() => document.body?.innerText || '');
  if (text.includes(email)) return true;
  const chooser = new URL('https://accounts.google.com/AccountChooser');
  chooser.searchParams.set('Email', email);
  chooser.searchParams.set('continue', returnUrl);
  chooser.searchParams.set('service', 'adwords');
  await s.page.goto(chooser.toString(), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }).catch((error) => {
    console.log(`[google-ads-keyword-planner] WARN: account chooser navigation failed ${String(error?.message || error).slice(0, 240)}`);
  });
  await s.wait(5);
  const selectedPersisted = await continueFromAccountChooser(s);
  if (!selectedPersisted) return await runPreferredGoogleSso(s, returnUrl);
  await s.wait(8);
  return true;
}
