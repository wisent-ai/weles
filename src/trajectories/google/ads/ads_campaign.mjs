// Google Ads: create/fill a campaign draft in the browser.
//
// Env:
//   GOOGLE_ADS_CUSTOMER_ID required unless ADS_URL is set
//   ADS_URL                optional direct Google Ads campaign creation URL
//   CAMPAIGN_NAME          optional, defaults to timestamped name
//   CAMPAIGN_TYPE          optional label, e.g. Search, Display, Performance Max
//   CAMPAIGN_OBJECTIVE     optional objective label, e.g. Website traffic
//   DAILY_BUDGET_USD       optional daily budget
//   FINAL_URL              optional landing page URL
//   APP_ID                 optional mobile app id for app install campaigns
//   PACKAGE_NAME           optional Android package name for app install campaigns
//   APP_NAME               optional app name for app install campaigns
//   APP_PLATFORM           optional Android | iOS
//   HEADLINE               optional ad headline
//   DESCRIPTION            optional ad description
//   KEYWORDS               optional comma-separated search keywords
//   LOCATIONS              optional comma-separated location names
//   SUBMIT                 must be "1" to publish. Default stages only.
//   PROXY_URL              optional proxy override
//
// Requires a logged-in google account cookie jar. Run google login/register
// flow first when the session is stale.

import { getSocialAccount, resolveAccountSession } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { assertGoogleAdsProfileNotAlreadyOpen, closeAllowedByEnv } from './_profile_guard.mjs';
import {
  ADS_URL, APP_ID, APP_NAME, APP_PLATFORM, CAMPAIGN_NAME, CAMPAIGN_OBJECTIVE, CUSTOMER_ID, DAILY_BUDGET_USD, DESCRIPTION,
  EFFECTIVE_CAMPAIGN_TYPE, FINAL_URL, HEADLINE, IS_APP_INSTALL, KEYWORDS, LOCATIONS, LOGIN_WAIT_MS, PACKAGE_NAME, SUBMIT,
  USER_DATA_DIR, WAIT_FOR_LOGIN,
} from './ads_campaign/settings.mjs';
import {
  bringBrowserToFront, clickAny, clickText, ensureCustomer, fillAny, fillTextNearLabel, gotoWithTimeout, isLoginUrl, pageText,
  stableProfilePersona, typeListIntoFirstVisible, waitForPageText,
} from './ads_campaign/page.mjs';

if (!ADS_URL && !CUSTOMER_ID && !WAIT_FOR_LOGIN) {
  console.log('FAIL: GOOGLE_ADS_CUSTOMER_ID or ADS_URL required');
  process.exit(1);
}

const acct = await getSocialAccount('google');
const session = acct ? await resolveAccountSession(acct) : { proxyUrl: undefined, persona: undefined };
const profilePersona = process.env.ADS_PROFILE_PERSONA === 'account' && session.persona ? session.persona : stableProfilePersona();


const baseUrl = ADS_URL || (CUSTOMER_ID
  ? `https://ads.google.com/aw/campaigns/new?ocid=${encodeURIComponent(CUSTOMER_ID)}`
  : 'https://ads.google.com/aw/campaigns');
console.log(`[google-ads] profile=${USER_DATA_DIR} viewport=${process.env.WELES_VIEWPORT}`);
assertGoogleAdsProfileNotAlreadyOpen(USER_DATA_DIR, 'google_ads_campaign');
const s = await WSession.start({ label: 'google_ads_campaign', browser: process.env.BROWSER || 'chromium', proxy: process.env.PROXY_URL || session.proxyUrl || 'direct', persona: profilePersona, userDataDir: USER_DATA_DIR });
try {
  await bringBrowserToFront(s);
  await gotoWithTimeout(s, baseUrl, 'campaign builder');
  await s.wait(10);
  let url = s.page.url?.() ?? '';
  if (isLoginUrl(url)) {
    if (!WAIT_FOR_LOGIN) {
      console.log('FAIL: google session expired / not logged in');
      process.exit(2);
    }
    console.log(`[google-ads] waiting for manual login, deadline=${LOGIN_WAIT_MS}ms`);
    await bringBrowserToFront(s);
    const deadline = Date.now() + LOGIN_WAIT_MS;
    while (Date.now() < deadline) {
      await s.wait(3);
      url = s.page.url?.() ?? '';
      if (!isLoginUrl(url)) break;
    }
    if (isLoginUrl(url)) {
      console.log(`FAIL: manual login did not complete (${url})`);
      process.exit(2);
    }
    await gotoWithTimeout(s, baseUrl, 'campaign builder after login');
    await s.wait(8);
  }

  await ensureCustomer(s);

  const newCampaignClicked = /\/campaigns\/new/i.test(s.page.url?.() ?? '') || await clickAny(s, [
    'button:has-text("New campaign")',
    'material-button:has-text("New campaign")',
    '[aria-label*="New campaign" i]',
  ], 'New campaign', 12000);
  await clickText(s, CAMPAIGN_OBJECTIVE, `objective ${CAMPAIGN_OBJECTIVE}`, 8000);
  await waitForPageText(s, /Select a campaign type|Drive website traffic from Google Search|Performance Max|App installs|App engagement|App promotion/i, 15000);
  if (EFFECTIVE_CAMPAIGN_TYPE && !/app$/i.test(EFFECTIVE_CAMPAIGN_TYPE)) {
    await clickText(s, EFFECTIVE_CAMPAIGN_TYPE, `campaign type ${EFFECTIVE_CAMPAIGN_TYPE}`, 8000);
  }
  if (IS_APP_INSTALL) {
    await clickText(s, process.env.APP_CAMPAIGN_SUBTYPE || 'App installs', `app campaign subtype ${process.env.APP_CAMPAIGN_SUBTYPE || 'App installs'}`, 5000);
    if (APP_PLATFORM) await clickText(s, APP_PLATFORM, `app platform ${APP_PLATFORM}`, 5000);
  }
  await clickAny(s, ['button:has-text("Continue")', 'material-button:has-text("Continue")'], 'Continue', 6000);
  await s.wait(10);

  let filledCount = 0;
  if (IS_APP_INSTALL) {
    if (await fillAny(s, [
      'input[aria-label*="app" i]',
      'input[placeholder*="app" i]',
      'input[aria-label*="package" i]',
      'input[placeholder*="package" i]',
    ], APP_NAME || PACKAGE_NAME || APP_ID, 'app')) filledCount += 1;
    else if (await fillTextNearLabel(s, /app|package|Google Play|iOS|Android/, APP_NAME || PACKAGE_NAME || APP_ID, 'app')) filledCount += 1;
  }
  if (await fillAny(s, [
    'input[aria-label*="Campaign name" i]',
    'input[placeholder*="Campaign name" i]',
    'input[name*="campaign" i]',
    'material-input:has-text("Campaign name") input',
    'div:has-text("Campaign name") input',
    'label:has-text("Campaign name") input',
  ], CAMPAIGN_NAME, 'campaign name')) filledCount += 1;
  if (await fillAny(s, [
    'input[aria-label*="Budget" i]',
    'input[placeholder*="Budget" i]',
    'label:has-text("Budget") input',
  ], DAILY_BUDGET_USD, 'daily budget')) filledCount += 1;
  if (await fillAny(s, [
    'input[aria-label*="Final URL" i]',
    'input[aria-label*="Website URL" i]',
    'input[aria-label*="Website" i]',
    'input[placeholder*="URL" i]',
    'input[type="url"]',
    'material-input:has-text("Final URL") input',
    'material-input:has-text("Website URL") input',
    'div:has-text("Final URL") input',
    'div:has-text("Website URL") input',
  ], FINAL_URL, 'final URL')) filledCount += 1;
  if (await typeListIntoFirstVisible(s, [
    'input[aria-label*="location" i]',
    'input[placeholder*="location" i]',
  ], LOCATIONS, 'locations')) filledCount += 1;
  if (await typeListIntoFirstVisible(s, [
    'textarea[aria-label*="keyword" i]',
    'input[aria-label*="keyword" i]',
    'textarea[placeholder*="keyword" i]',
  ], KEYWORDS, 'keywords')) filledCount += 1;
  if (await fillAny(s, [
    'input[aria-label*="Headline" i]',
    'textarea[aria-label*="Headline" i]',
  ], HEADLINE, 'headline')) filledCount += 1;
  if (await fillAny(s, [
    'textarea[aria-label*="Description" i]',
    'input[aria-label*="Description" i]',
  ], DESCRIPTION, 'description')) filledCount += 1;

  await clickAny(s, ['button:has-text("Save and continue")', 'button:has-text("Next")'], 'Save and continue', 5000);

  if (!newCampaignClicked || filledCount === 0) {
    console.log(`FAIL: Google Ads campaign form was not reached (newCampaignClicked=${newCampaignClicked}, filled=${filledCount}, url=${s.page.url?.() ?? ''})`);
    process.exit(1);
  }

  if (!SUBMIT) {
    console.log(`PASS: staged Google Ads campaign draft "${CAMPAIGN_NAME}" (SUBMIT=0, filled=${filledCount})`);
    process.exit(0);
  }

  const published = await clickAny(s, [
    'button:has-text("Publish campaign")',
    'button:has-text("Publish")',
    'button:has-text("Submit")',
  ], 'Publish campaign', 10000);
  if (!published) {
    console.log('FAIL: Publish campaign button not found');
    process.exit(1);
  }
  await s.wait(8);
  const finalText = await pageText(s);
  const status = /published|eligible|under review|campaign has been created|success/i.test(finalText) ? 'confirmed' : 'clicked';
  console.log(`PASS: Google Ads campaign publish ${status} for "${CAMPAIGN_NAME}"`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  if (closeAllowedByEnv('GOOGLE_ADS_CLOSE_AFTER_HARVEST')) await s.close().catch(() => {});
  else console.log('[google-ads] leaving Google Ads profile open');
}
