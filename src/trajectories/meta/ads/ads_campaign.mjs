// Meta Ads Manager: create/fill a campaign draft in the browser.
//
// Env:
//   AD_ACCOUNT_ID        required unless ADS_URL is set; numeric or act_<id>
//   ADS_URL              optional direct Ads Manager creation URL
//   CAMPAIGN_NAME        optional, defaults to timestamped name
//   CAMPAIGN_OBJECTIVE   optional objective label text, e.g. Traffic, Leads
//   CAMPAIGN_DESTINATION optional destination family. Supported: website
//   DAILY_BUDGET_USD     optional daily budget
//   DESTINATION_URL      optional landing page URL
//   DISPLAY_LINK         optional visible display link
//   URL_PARAMS           optional URL tracking params
//   AD_NAME              optional ad name
//   AD_SET_NAME          optional ad set name
//   META_FACEBOOK_PAGE_NAME optional Facebook Page to select
//   META_FACEBOOK_PAGE_ID   optional Facebook Page id to select
//   PRIMARY_TEXT         optional ad primary text
//   HEADLINE             optional ad headline
//   DESCRIPTION          optional ad description
//   META_ADS_CAPABILITIES print supported params and exit
//   ALLOW_UNVERIFIED_META_PARAMS set "1" to warn instead of failing for unsupported params
//   SUBMIT               must be "1" to publish. Default stages only.
//   PROXY_URL            optional proxy override
//
// Requires a logged-in facebook account cookie jar. Run meta/facebook_login.mjs
// first when the session is stale.
//
// The run itself lives here: the admission checks, the session, the walk past
// the login gate, the account proof, the draft and the publish. The steps it is
// made of live in ./ads_campaign/.

import { AD_ACCOUNT_ID, CAMPAIGN_NAME, PRINT_CAPABILITIES, SUBMIT, USER_DATA_DIR, VERIFY_ACCOUNT_ONLY, guardUnsupportedParams, printCapabilitiesAndExit, profilePersona, requireCampaignTarget, session, targetUrl } from './ads_campaign/campaign_request.mjs';
import { WSession } from '../../../../dist/session/wsession.js';
import { clickAny, closeObstructingPanels, pageText } from './ads_campaign/panel_controls.mjs';
import { bringBrowserToFront, ensureAdAccount, passLoginGate, visibleSelectedAdAccount } from './ads_campaign/ad_account_session.mjs';
import { chooseObjectiveAndContinue, openCampaignCreation, reportDraftOutcomeWithoutFields } from './ads_campaign/campaign_draft.mjs';
import { fillCampaignFields, verifyConfiguredDraft } from './ads_campaign/draft_fields.mjs';

if (PRINT_CAPABILITIES) printCapabilitiesAndExit();
guardUnsupportedParams();
requireCampaignTarget();

console.log(`[meta-ads] profile=${USER_DATA_DIR} viewport=${process.env.WELES_VIEWPORT}`);
const s = await WSession.start({ label: 'meta_ads_campaign', browser: process.env.BROWSER || 'chromium', proxy: process.env.PROXY_URL || session.proxyUrl || 'direct', persona: profilePersona, userDataDir: USER_DATA_DIR, pageDiagnostics: process.env.WELES_PAGE_DIAGNOSTICS === '1' });
try {
  await bringBrowserToFront(s);
  await s.goto(targetUrl);
  await s.wait(10);
  await passLoginGate(s);

  await ensureAdAccount(s);
  if (VERIFY_ACCOUNT_ONLY) {
    const visible = await visibleSelectedAdAccount(s);
    console.log(`PASS: Meta Ads account verified (${visible.label || AD_ACCOUNT_ID || 'unknown'})`);
    process.exit(0);
  }
  await closeObstructingPanels(s);

  await clickAny(s, [
    'button:has-text("I Accept")',
    'button:has-text("Accept")',
    'button:has-text("Akceptuję")',
    'button:has-text("Zgadzam się")',
    'div[role="button"]:has-text("I Accept")',
    'div[role="button"]:has-text("Akceptuję")',
  ], 'policy modal accept', 4000);
  await s.wait(2);

  const createClicked = await openCampaignCreation(s);
  await chooseObjectiveAndContinue(s);
  const filledCount = await fillCampaignFields(s);

  // Nothing to verify and nothing to publish: this reports the staged draft or
  // refuses, and never comes back.
  if (!createClicked || filledCount === 0) await reportDraftOutcomeWithoutFields(s, createClicked, filledCount);

  if (!SUBMIT) {
    await verifyConfiguredDraft(s);
    console.log(`PASS: staged Meta ads campaign draft "${CAMPAIGN_NAME}" (SUBMIT=0, filled=${filledCount})`);
    process.exit(0);
  }

  const published = await clickAny(s, [
    'div[role="button"]:has-text("Publish")',
    'button:has-text("Publish")',
    'div[role="button"]:has-text("Confirm")',
  ], 'Publish', 10000);
  if (!published) {
    console.log('FAIL: Publish button not found');
    process.exit(1);
  }
  await s.wait(8);
  const finalText = await pageText(s);
  const status = /published|processing|in review|successfully/i.test(finalText) ? 'confirmed' : 'clicked';
  console.log(`PASS: Meta ads campaign publish ${status} for "${CAMPAIGN_NAME}"`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
