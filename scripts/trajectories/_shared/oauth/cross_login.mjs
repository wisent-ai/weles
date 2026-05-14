// High-level cross-login helper.
//
// Each platform's login page exposes one or more OAuth-provider buttons
// ("Continue with Google", "Sign in with Apple", "Log in with Facebook", ...).
// This helper drives that flow end-to-end:
//   1. pull the provider account's cookies from social_accounts
//   2. inject them onto the provider's primary + mirror domains
//   3. navigate to the target login URL, click the provider button
//   4. handle the consent screen (Authorize / Allow / Continue)
//   5. wait for the post-OAuth redirect back to the target domain
//   6. assertAuthed for the target platform
//   7. persist the resulting target cookies via persistFreshCookieJar
//
// Per-(target, provider) trajectory files become thin wrappers that pass
// targetPlatform / targetUrl / provider / provider button regex.

import { getSocialAccount, resolveAccountSession } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import {
  injectProviderCookies,
  clickOAuthProviderButton,
  handleOAuthConsent,
  waitForNavBackTo,
} from '../../../../dist/platforms/_shared/cross_platform_oauth.js';
import { assertAuthed, AuthProbeError } from '../auth-probe.mjs';
import { persistFreshCookieJar } from '../cookie-freshness.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { humanIdlePause } from '../../../../dist/human/mouse.js';

// Provider name on the OAuth button → social_accounts platform key for the
// row that holds the cookies. Identity is the same for every provider here:
// google/register.mjs saves as platform='google', etc. (The 2026-05-04 era
// youtube/register.mjs that saved as 'youtube' has been retired in favor of
// google/register.mjs which is the canonical Gmail signup flow.)
const PROVIDER_TO_ACCOUNT_PLATFORM = {
  google: 'google',
  twitter: 'twitter',
  instagram: 'instagram',
  facebook: 'facebook',
  github: 'github',
  apple: 'apple',
  microsoft: 'microsoft',
};

export async function runCrossLogin(opts) {
  const {
    targetPlatform,
    targetUrl,
    provider,
    providerButtonRegex,
    navTimeoutSeconds = 60,
  } = opts;

  const accountPlatform = PROVIDER_TO_ACCOUNT_PLATFORM[provider] ?? provider;

  const acct = await getSocialAccount(targetPlatform);
  if (!acct) {
    fail(targetPlatform, provider, 'no_target_account', `no active ${targetPlatform} account in DB`);
    return;
  }

  // ACCOUNT_ID is set by the worker to the TARGET row's id. getSocialAccount
  // honors that env and would query id=<target_id> AND platform=<provider>,
  // which never matches → null. Same bug producthunt/_session.mjs:222-228
  // documented for loginViaTwitter. Clear ACCOUNT_ID for the provider lookup,
  // restore it after so downstream code sees the original.
  const savedAccountId = process.env.ACCOUNT_ID;
  delete process.env.ACCOUNT_ID;
  let providerAcct;
  try { providerAcct = await getSocialAccount(accountPlatform); }
  finally { if (savedAccountId !== undefined) process.env.ACCOUNT_ID = savedAccountId; }
  if (!providerAcct) {
    fail(targetPlatform, provider, 'provider_account_missing', `no active ${accountPlatform} (provider=${provider}) account in DB`);
    return;
  }
  const providerCookies = providerAcct.metadata?.cookies ?? [];
  if (providerCookies.length < 2) {
    fail(targetPlatform, provider, 'provider_cookies_missing', `${accountPlatform} ${providerAcct.username} has ${providerCookies.length} cookies — login the provider first`);
    return;
  }

  console.log(`[cross-login] target=${targetPlatform}/${acct.username} provider=${provider} (${accountPlatform}/${providerAcct.username})`);

  const { proxyUrl, persona } = await resolveAccountSession(acct);
  const s = await WSession.start({
    label: `${targetPlatform}_login_via_${provider}`,
    proxy: proxyUrl,
    persona,
  });

  let banSignal = null;
  try {
    const injected = await injectProviderCookies(s.ctx, provider, providerCookies);
    console.log(`[cross-login] injected ${injected} ${provider} cookies`);

    await s.goto(targetUrl);
    await humanIdlePause('deliberate');
    // Some platforms (e.g. ProductHunt) render their homepage on the target URL
    // and require an explicit "Sign in" click to open the SSO modal before the
    // provider buttons are in the DOM. Caller passes openerButtonRegex to drive
    // that pre-click; defaults to no-op when the page already shows the buttons.
    if (opts.openerButtonRegex) {
      const opened = await clickOAuthProviderButton(s, opts.openerButtonRegex);
      if (opened) {
        console.log(`[cross-login] opened auth modal via ${opts.openerButtonRegex}`);
        await humanIdlePause('deliberate');
      }
    }
    const clicked = await clickOAuthProviderButton(s, providerButtonRegex);
    if (!clicked) {
      banSignal = { signal: 'provider_button_not_found', healthy: false, details: { final_url: s.page.url(), button_regex: providerButtonRegex.toString() } };
      throw new Error(`provider_button_not_found: regex=${providerButtonRegex} on ${s.page.url()}`);
    }
    console.log(`[cross-login] clicked ${provider} button — handling consent`);

    await humanIdlePause('deliberate');
    await handleOAuthConsent(s);
    const targetHost = new URL(targetUrl).hostname.replace(/^www\./, '');
    const landed = await waitForNavBackTo(s.page, targetHost, [
      'accounts.google.com',
      'appleid.apple.com',
      'login.microsoftonline.com',
      'login.microsoft.com',
      'live.com',
      'facebook.com/dialog',
      'api.twitter.com/oauth',
      'twitter.com/i/oauth2',
      'x.com/i/oauth2',
      'github.com/login/oauth',
      'instagram.com/oauth',
    ], navTimeoutSeconds);
    if (!landed) {
      banSignal = { signal: 'consent_failed', healthy: false, details: { final_url: s.page.url(), reason: `did not return to ${targetHost} within ${navTimeoutSeconds}s` } };
      throw new Error(`consent_failed: stuck at ${s.page.url()}`);
    }
    console.log(`[cross-login] back on ${targetHost} → asserting authed`);

    try {
      await assertAuthed(targetPlatform, s, { label: `${targetPlatform}_login_via_${provider}` });
    } catch (e) {
      banSignal = e instanceof AuthProbeError ? e.banSignal : { signal: 'assert_authed_failed', healthy: false, details: { reason: e.message?.slice(0, 200), final_url: s.page.url() } };
      throw e;
    }

    const cookies = await s.ctx.cookies();
    const persisted = await persistFreshCookieJar(acct, cookies, { currentProxyUrl: proxyUrl, currentPersona: persona });
    if (persisted?.ok) {
      banSignal = { signal: 'healthy', healthy: true, details: { provider, final_url: s.page.url(), cookies_persisted: cookies.length } };
      console.log(`PASS: ${targetPlatform} logged in via ${provider} (${cookies.length} cookies persisted)`);
    } else {
      banSignal = { signal: 'cookies_persist_failed', healthy: false, details: { reason: persisted?.reason } };
      throw new Error(`cookies_persist_failed: ${persisted?.reason}`);
    }
  } catch (e) {
    if (!banSignal) banSignal = { signal: 'unknown_error', healthy: false, details: { reason: e.message?.slice(0, 200) } };
    console.log('FAIL:', e.message?.slice(0, 200));
    process.exitCode = 1;
  } finally {
    persistBanSignal(targetPlatform, provider, acct, banSignal);
    await Promise.race([s.close(), new Promise(r => setTimeout(r, 5000))]).catch(() => {});  // allow-raw-playwright: Promise.race deadline
  }
}

function fail(targetPlatform, provider, signal, msg) {
  console.log(`FAIL: ${msg}`);
  persistBanSignal(targetPlatform, provider, null, { signal, healthy: false, details: { reason: msg } });
  process.exit(1);
}

function persistBanSignal(targetPlatform, provider, acct, banSignal) {
  if (!banSignal) return;
  try {
    const dir = join(process.cwd(), 'recordings', `${targetPlatform}_login_via_${provider}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({
      action: `${targetPlatform}_login_via_${provider}`,
      account_id: acct?.id ?? null,
      username: acct?.username ?? null,
      provider,
      ts: new Date().toISOString(),
      ...banSignal,
    }, null, 2));
  } catch (e) { console.log('[ban-signal] persist err:', e.message); }
}
