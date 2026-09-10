// Google Ads Keyword Planner through the persistent Weles keeper.
// Do not reimplement this path with REST/developer-credential access;
// keyword-volume collection for reports is intentionally UI-observed via Weles.
// No CUA. No CDP attach. No short-lived WSession/profile launch.
// The keeper owns the browser/profile; this runner drives it through the socket.
//
// Env:
//   GOOGLE_ADS_CUSTOMER_ID       required
//   GOOGLE_ADS_KEYWORDS          required, comma/newline separated
//   GOOGLE_ADS_RESULT_FILE       optional JSON output path
//   SESSION                      optional keeper session, default google_ads
//   Login identity/password/MFA are read only from the dedicated Google Ads Skarbiec item.

import { SESSION, SOCK, cid, keywords, norm, preferredEmail, resolveSsoCreds, socketReady, writeResult } from './keeper/run_brief.mjs';
import { evalState } from './keeper/keeper_browser.mjs';
import { chooseVolumeMode, ensureAdsReady, openKeywordPlanner, submitKeywords } from './keeper/planner_navigation.mjs';
import { parseRows, waitForResults, writeKeywordReport } from './keeper/metrics_report.mjs';

async function main() {
  if (!socketReady()) writeResult({ ok: false, blocked: 'keeper_socket_not_ready', session: SESSION, socket: SOCK }, 3);
  const creds = await resolveSsoCreds();
  if (!creds?.password) writeResult({ ok: false, blocked: 'missing_google_ads_password', session: SESSION, email: preferredEmail() }, Number('4'));
  const steps = [{ step: 'sso_creds_resolved', source: creds.source || 'unknown' }];

  if (!await ensureAdsReady(creds)) {
    const s = await evalState(6000);
    writeResult({ ok: false, blocked: 'google_ads_login_not_ready', session: SESSION, url: s.url, textPreview: norm(s.text).slice(0, 1200) }, 4);
  }
  steps.push({ step: 'ads_ready', url: (await evalState(1000)).url });

  const open = await openKeywordPlanner();
  steps.push({ step: 'planner_open', open });
  if (!open.ok) writeResult({ ok: false, blocked: 'keyword_planner_not_opened', session: SESSION, customer: cid, keywords, open, steps }, 5);

  const already = await evalState(20_000);
  const alreadyRows = parseRows(already.text || '');
  if (alreadyRows.length) {
    steps.push({ step: 'existing_results_ready', keywords });
    writeKeywordReport({ state: already, rows: alreadyRows }, steps);
  }

  if (!await chooseVolumeMode()) {
    const s = await evalState(6000);
    writeResult({ ok: false, blocked: 'keyword_volume_mode_not_opened', session: SESSION, customer: cid, keywords, url: s.url, textPreview: norm(s.text).slice(0, 1200), steps }, 6);
  }
  steps.push({ step: 'volume_mode_ready', url: (await evalState(1000)).url });

  await submitKeywords();
  steps.push({ step: 'keywords_submitted', keywords });

  const result = await waitForResults();
  writeKeywordReport(result, steps);
}

main().catch((error) => {
  writeResult({ ok: false, blocked: 'google_ads_keyword_planner_keeper_error', error: String(error?.message || error), session: SESSION, customer: cid, keywords }, 1);
});
