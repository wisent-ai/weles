// Read Keyword Planner search volume from the Google Ads interface, for an
// account whose REST keyword-planning service access we do not have.
//
// Env:
//   GOOGLE_ADS_CUSTOMER_ID       required
//   GOOGLE_ADS_KEYWORDS          required, comma/newline separated
//   GOOGLE_ADS_RESULT_FILE       optional JSON output path
//   Login identity/password/MFA are read only from the dedicated Google Ads Skarbiec item.
//
// The file grew past the line limit, so the family under
// `ads_keyword_planner/` holds the request, the account session, the page and
// wire reading, the row parsing and the planner controls. What stays here is
// the run itself: the session, the refusal reports and the result.

import { writeFileSync } from 'node:fs';
import { WSession } from '../../../../dist/session/wsession.js';
import { assertGoogleAdsProfileNotAlreadyOpen } from './_profile_guard.mjs';
import {
  continueFromAccountChooser,
  ensurePreferredGoogleAccount,
  isLoginUrl,
  lastAuthFailure,
} from './ads_keyword_planner/account_session.mjs';
import { installKeywordPlannerCapture } from './ads_keyword_planner/page_reading.mjs';
import { collectKeywordPlanner, openKeywordPlanner } from './ads_keyword_planner/planner_controls.mjs';
import {
  campaignsUrl,
  cid,
  CLOSE_AFTER_HARVEST,
  keywords,
  NAV_TIMEOUT_MS,
  norm,
  prepareRunDirectories,
  RESULT_FILE,
  stableProfilePersona,
  USER_DATA_DIR,
} from './ads_keyword_planner/request.mjs';

if (!cid) throw new Error('GOOGLE_ADS_CUSTOMER_ID required');
if (!keywords.length) throw new Error('GOOGLE_ADS_KEYWORDS required');

prepareRunDirectories();

process.env.WELES_CAPTURE_RESPONSE_BODIES ??= '1';
process.env.WELES_DISABLE_RECORDING ??= '1';
process.env.WELES_NO_INSTRUMENT ??= '1';
process.env.WELES_VIEWPORT ??= '1440x1000';
process.env.GOOGLE_SSO_NO_SCREENSHOTS ??= '1';

function reportAndExit(report, code) {
  writeFileSync(RESULT_FILE, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2).slice(0, 12000));
  process.exit(code);
}

async function main() {
  console.log(`[google-ads-keyword-planner] customer=${cid} keywords=${JSON.stringify(keywords)}`);
  const startUrl = campaignsUrl('cid', cid);
  assertGoogleAdsProfileNotAlreadyOpen(USER_DATA_DIR, 'google_ads_keyword_planner');
  const s = await WSession.start({
    label: 'google_ads_keyword_planner',
    browser: process.env.BROWSER || 'chromium',
    proxy: process.env.PROXY_URL || 'direct',
    persona: stableProfilePersona(),
    userDataDir: USER_DATA_DIR,
    pageDiagnostics: process.env.WELES_PAGE_DIAGNOSTICS === '1',
  });
  const captured = installKeywordPlannerCapture(s.page);
  try {
    await s.page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }).catch((error) => {
      console.log(`[google-ads-keyword-planner] WARN: initial navigation failed ${String(error?.message || error).slice(0, 240)}`);
    });
    await s.wait(8);
    await ensurePreferredGoogleAccount(s, startUrl);
    await continueFromAccountChooser(s);
    await s.wait(5);

    const current = s.page.url?.() || '';
    const text = await s.page.evaluate(() => document.body?.innerText || '');
    if (isLoginUrl(current)) {
      reportAndExit({
        ok: false,
        blocked: lastAuthFailure()?.blocked || 'google_ads_browser_session_not_logged_in',
        customer: cid,
        keywords,
        url: current,
        authFailure: lastAuthFailure(),
        textPreview: norm(text).slice(0, 1200),
      }, 2);
    }
    if (/multifactorauthalert|block=true/i.test(current) || /multi-factor|2-step verification|2-Step Verification/i.test(text)) {
      reportAndExit({
        ok: false,
        blocked: 'google_ads_mfa_required',
        customer: cid,
        keywords,
        url: current,
        textPreview: norm(text).slice(0, 1200),
      }, 3);
    }

    const open = await openKeywordPlanner(s);
    if (!open.ok) {
      reportAndExit({
        ok: false,
        blocked: 'keyword_planner_not_opened',
        customer: cid,
        keywords,
        open,
        url: s.page.url?.() || '',
      }, 4);
    }

    const report = await collectKeywordPlanner(s, captured);
    report.open = open;
    report.ok = report.parsedRows.length > 0 || report.rpc.keywordMentions.length > 0;
    writeFileSync(RESULT_FILE, JSON.stringify(report, null, 2));
    console.log(`GOOGLE_ADS_KEYWORD_PLANNER_REPORT ${JSON.stringify(report)}`);
    console.log(JSON.stringify(report, null, 2).slice(0, 20000));
    console.log('PASS: Google Ads keyword planner read completed (browser)');
  } finally {
    if (CLOSE_AFTER_HARVEST) await s.close();
    else console.log('[google-ads-keyword-planner] leaving Google Ads profile open');
  }
}

main().catch((error) => {
  const report = {
    ok: false,
    blocked: 'google_ads_keyword_planner_error',
    customer: cid,
    keywords,
    error: String(error?.message || error),
  };
  writeFileSync(RESULT_FILE, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(1);
});
