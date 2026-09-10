// Apple Ads report harvester.
//
// Uses a Weles browser session and reads DOM/network only. Authentication is
// delegated exclusively to an explicitly authorized apple_login run.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getSocialAccount, resolveAccountSession } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { DATE_PRESETS, DIAG_DIR, EXACT_RANGES, REPORT_URL, SESSION_LABEL, USER_DATA_DIR, WAIT_AFTER_NAV_MS } from './report_harvest/settings.mjs';
import { ensureReportPage, gotoAndWait, installNetworkCapture, requireAuthenticatedSession, stableProfilePersona } from './report_harvest/session.mjs';
import { clickDatePreset, collectPageState } from './report_harvest/page_state.mjs';
import { getCampaignReportPayload, sanitizeResponses, summarizeGraphqlRequests, summarizeGraphqlResponses, summarizeReport } from './report_harvest/summaries.mjs';
import { fetchExactCampaignReports, keepOpen, summarizeExactReports } from './report_harvest/exact_reports.mjs';

async function main() {
  const acct = await getSocialAccount('apple');
  if (!acct) {
    console.log('FAIL: no active apple account in DB');
    process.exit(1);
  }

  const { proxyUrl } = await resolveAccountSession(acct);
  const persona = stableProfilePersona();
  const s = await WSession.start({
    label: SESSION_LABEL,
    browser: process.env.BROWSER || 'chromium',
    proxy: proxyUrl ?? (process.env.PROXY_URL || 'direct'),
    persona,
    userDataDir: USER_DATA_DIR,
    record: false,
    pageDiagnostics: false,
  });

  let exitCode = 0;
  try {
    const network = installNetworkCapture(s.page);
    const firstNav = await gotoAndWait(s.page, REPORT_URL);
    if (!firstNav && (s.page.url?.() || '') === 'about:blank') {
      console.log('[apple-ads-report-harvest] first navigation stayed blank; retrying');
      await gotoAndWait(s.page, REPORT_URL);
    }
    console.log(`[apple-ads-report-harvest] before login check url=${s.page.url?.() || ''}`);
    const loggedIn = await requireAuthenticatedSession(s);
    console.log(`[apple-ads-report-harvest] login check loggedIn=${loggedIn} url=${s.page.url?.() || ''}`);
    if (!loggedIn) {
      exitCode = 2;
      return;
    }
    await s.saveCookies().catch(() => null);
    if (!/\/report/i.test(s.page.url?.() || '')) {
      await gotoAndWait(s.page, REPORT_URL);
    } else {
      await s.page.waitForTimeout(WAIT_AFTER_NAV_MS).catch(() => {});
    }
    if (!await ensureReportPage(s.page)) {
      const currentUrl = s.page.url?.() || '';
      console.log(`FAIL: Apple Ads report page not loaded (${currentUrl})`);
      exitCode = 4;
      return;
    }
    const protectedUrl = new URL(s.page.url?.() || 'about:blank');
    const protectedText = await s.page.evaluate(() => document.body?.innerText || '').catch(() => '');
    const protectedMarker = protectedText.match(/Manage Your Campaigns|Reporting is not in real time|Create Campaign|Campaign end date reached/i)?.[0];
    const authenticatedProtectedPage = protectedUrl.hostname === 'app-ads.apple.com'
      && !/signin|login/i.test(protectedUrl.pathname)
      && /\/report(?:\/|$)/i.test(protectedUrl.pathname)
      && Boolean(protectedMarker);
    if (!authenticatedProtectedPage) {
      console.log('FAIL_CLOSED: authenticated Apple Ads report page was not confirmed; run an explicitly authorized apple_login before retrying.');
      exitCode = 4;
      return;
    }

    const snapshots = [];
    const current = await collectPageState(s.page);
    snapshots.push({
      label: 'initial',
      click: null,
      page: current,
      summary: summarizeReport(current, sanitizeResponses(s.capturedResponses || [])),
    });

    for (const preset of DATE_PRESETS) {
      const click = await clickDatePreset(s.page, preset);
      await s.page.waitForTimeout(WAIT_AFTER_NAV_MS).catch(() => {});
      const page = await collectPageState(s.page);
      snapshots.push({
        label: preset,
        click,
        page,
        summary: summarizeReport(page, sanitizeResponses(s.capturedResponses || [])),
      });
    }

    await s.page.waitForTimeout(1000).catch(() => {});
    const templatePayload = getCampaignReportPayload(network.requests);
    const exactReports = await fetchExactCampaignReports(s.page, templatePayload, EXACT_RANGES);
    const exactSummary = summarizeExactReports(exactReports);
    const responses = sanitizeResponses(s.capturedResponses || []);
    const observedRequests = network.requests.slice();
    const observedResponses = network.responses.slice();
    const summary = {
      initial: snapshots[0].summary,
      presets: snapshots.slice(1).map((snapshot) => ({
        label: snapshot.label,
        click: snapshot.click,
        summary: snapshot.summary,
      })),
      graphqlRequests: summarizeGraphqlRequests(observedRequests).slice(-40),
      graphqlResponses: summarizeGraphqlResponses(observedResponses).slice(-40),
      exactReports: exactSummary,
    };
    const output = {
      ok: true,
      reportUrl: REPORT_URL,
      capturedAt: new Date().toISOString(),
      snapshots,
      responses,
      observedRequests,
      observedResponses,
      exactReports,
      summary,
    };
    const outPath = join(DIAG_DIR, 'report_harvest.json');
    writeFileSync(outPath, JSON.stringify(output, null, 2));
    await s.saveCookies().catch(() => null);
    console.log(`[apple-ads-report-harvest] json=${outPath}`);
    console.log(JSON.stringify(summary, null, 2).slice(0, 12000));
  } finally {
    process.exitCode = exitCode;
    await keepOpen(s);
  }
}

main().catch((error) => {
  console.log('FAIL:', error.message?.slice(0, 1000) || String(error));
  process.exit(1);
});
