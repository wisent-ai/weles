// Google Ads UI fallback: collect Keyword Planner keyword volume without
// REST keyword-planning service access.
//
// Env:
//   GOOGLE_ADS_CUSTOMER_ID       required
//   GOOGLE_ADS_KEYWORDS          required, comma/newline separated
//   GOOGLE_ADS_RESULT_FILE       optional JSON output path
//   Login identity/password/MFA are read only from the dedicated Google Ads Skarbiec item.

import { writeFileSync } from 'node:fs';
import { WSession } from '../../../../../dist/session/wsession.js';
import { assertGoogleAdsProfileNotAlreadyOpen } from '../_profile_guard.mjs';
import { CLOSE_AFTER_HARVEST, NAV_TIMEOUT_MS, RESULT_FILE, USER_DATA_DIR, cid, keywords, norm } from './planner/settings.mjs';
import { continueFromAccountChooser, ensurePreferredGoogleAccount, isLoginUrl, lastAuthFailure, stableProfilePersona } from './planner/sign_in.mjs';
import { campaignsUrl, installKeywordPlannerCapture } from './planner/capture.mjs';
import { collectKeywordPlanner, openKeywordPlanner } from './planner/page.mjs';

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
    const text = await s.page.evaluate(() => document.body?.innerText || '').catch(() => '');
    if (isLoginUrl(current)) {
      const report = {
        ok: false,
        blocked: lastAuthFailure()?.blocked || 'google_ads_browser_session_not_logged_in',
        customer: cid,
        keywords,
        url: current,
        authFailure: lastAuthFailure(),
        textPreview: norm(text).slice(0, 1200),
      };
      writeFileSync(RESULT_FILE, JSON.stringify(report, null, 2));
      console.log(JSON.stringify(report, null, 2));
      process.exit(2);
    }
    if (/multifactorauthalert|block=true/i.test(current) || /multi-factor|2-step verification|2-Step Verification/i.test(text)) {
      const report = {
        ok: false,
        blocked: 'google_ads_mfa_required',
        customer: cid,
        keywords,
        url: current,
        textPreview: norm(text).slice(0, 1200),
      };
      writeFileSync(RESULT_FILE, JSON.stringify(report, null, 2));
      console.log(JSON.stringify(report, null, 2));
      process.exit(3);
    }

    const open = await openKeywordPlanner(s);
    if (!open.ok) {
      const report = {
        ok: false,
        blocked: 'keyword_planner_not_opened',
        customer: cid,
        keywords,
        open,
        url: s.page.url?.() || '',
      };
      writeFileSync(RESULT_FILE, JSON.stringify(report, null, 2));
      console.log(JSON.stringify(report, null, 2).slice(0, 12000));
      process.exit(4);
    }

    const report = await collectKeywordPlanner(s, captured);
    report.open = open;
    report.ok = report.parsedRows.length > 0 || report.rpc.keywordMentions.length > 0;
    writeFileSync(RESULT_FILE, JSON.stringify(report, null, 2));
    console.log(`GOOGLE_ADS_KEYWORD_PLANNER_REPORT ${JSON.stringify(report)}`);
    console.log(JSON.stringify(report, null, 2).slice(0, 20000));
    console.log('PASS: Google Ads keyword planner read completed (browser)');
  } finally {
    if (CLOSE_AFTER_HARVEST) await s.close().catch(() => {});
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
