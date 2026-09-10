// Apple Ads API client setup probe.
//
// Opens Apple Ads Account Settings/API only through an already authenticated session.
// Authentication is delegated exclusively to an explicitly authorized apple_login run.

import { existsSync } from 'node:fs';
import { getSocialAccount, resolveAccountSession } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { PRIVATE_KEY_PATH, PUBLIC_KEY_PATH, USER_DATA_DIR } from './api_client_setup_probe/settings.mjs';
import { clickText, keepOpen, pageDiag, requireAuthenticatedSession, stableProfilePersona } from './api_client_setup_probe/page.mjs';
import { inspectExistingAppleAdsApi } from './api_client_setup_probe/artifacts.mjs';

async function main() {
  const acct = await getSocialAccount('apple');
  if (!acct) {
    console.log('FAIL: no active apple account in DB');
    process.exit(1);
  }
  const { proxyUrl, persona } = await resolveAccountSession(acct);
  const s = await WSession.start({
    label: 'apple_ads_api_setup',
    browser: 'chromium',
    proxy: proxyUrl ?? (process.env.PROXY_URL || 'direct'),
    persona: persona || stableProfilePersona(),
    userDataDir: USER_DATA_DIR,
  });

  let loggedIn = false;
  let exitCode = 0;
  try {
    console.log(JSON.stringify({
      publicKeyPath: PUBLIC_KEY_PATH,
      hasPublicKey: existsSync(PUBLIC_KEY_PATH),
      privateKeyPath: PRIVATE_KEY_PATH,
      hasPrivateKey: existsSync(PRIVATE_KEY_PATH),
    }, null, 2));

    await s.goto('https://app-ads.apple.com/cm/app/');
    await s.wait(8);
    loggedIn = await requireAuthenticatedSession(s);
    if (!loggedIn) {
      exitCode = 2;
      return;
    }
    await s.wait(5);
    await pageDiag(s.page, 'home');

    for (const url of [
      'https://app-ads.apple.com/cm/app/account/settings/api',
      'https://app-ads.apple.com/cm/app/settings/api',
      'https://app-ads.apple.com/cm/app/account/settings',
      'https://app-ads.apple.com/cm/app/',
    ]) {
      await s.goto(url);
      await s.wait(8);
      await pageDiag(s.page, `url_${Buffer.from(url).toString('hex').slice(0, 16)}`);
      const text = await s.page.evaluate(() => document.body?.innerText || '').catch(() => '');
      if (/API|Public Key|Generate API client|Client ID|Team ID|Key ID/i.test(text)) break;
    }

    await clickText(s.page, /Account Settings|Settings/i, 'settings', 6000).catch(() => false);
    await clickText(s.page, /^API$|API Access|Campaign Management API|Public Key/i, 'api', 6000).catch(() => false);
    const finalState = await pageDiag(s.page, 'final');
    const existing = await inspectExistingAppleAdsApi(s.page, finalState);

    if (existing.hasExistingAppleAdsApiClient) {
      console.log('PASS: Apple Ads API credential page reached');
    } else if (existing.canGenerateApiClient || existing.hasAppleAdsApiSurface) {
      console.log('PASS: Apple Ads API setup form reached');
    } else {
      console.log('FAIL: Apple Ads API setup page not reached');
      exitCode = 3;
      return;
    }

    const protectedUrl = new URL(s.page.url?.() ?? 'about:blank');
    const authenticatedProtectedPage = protectedUrl.hostname === 'app-ads.apple.com'
      && !/signin|login/i.test(protectedUrl.pathname)
      && (existing.hasExistingAppleAdsApiClient || existing.canGenerateApiClient || existing.hasAppleAdsApiSurface);
    if (!authenticatedProtectedPage) {
      console.log('FAIL_CLOSED: authenticated Apple Ads API page was not confirmed; run an explicitly authorized apple_login before retrying.');
      exitCode = 3;
    }
  } finally {
    process.exitCode = exitCode;
    await keepOpen(s, loggedIn);
  }
}

main().catch((e) => {
  console.log('FAIL:', e.message?.slice(0, 300));
  process.exit(1);
});
