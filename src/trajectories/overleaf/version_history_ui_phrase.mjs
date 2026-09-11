// overleaf/version_history_ui_phrase.mjs
//
// UI-only Weles trajectory for Overleaf Version History. It opens the Overleaf
// dashboard/editor and clicks the History UI. It does not call Overleaf project
// JSON/history endpoints directly.
//
// Usage:
//   node src/trajectories/overleaf/version_history_ui_phrase.mjs <project-id-or-title> <phrase-or-query-text>

import { MAIN_TEX, MAX_HISTORY_CLICKS, OUTPUT_PATH, queryText, target } from './version_history_ui_phrase/settings.mjs';
import { dump, ensureDashboard, norm, writeSummary } from './version_history_ui_phrase/page.mjs';
import { loginWithGoogleUi, openHistoryUi, resolveAndOpenProject } from './version_history_ui_phrase/navigate.mjs';
import { summarizeVisible } from './version_history_ui_phrase/summarize.mjs';
import { clickVisibleText, probeHistoryState } from './version_history_ui_phrase/probe.mjs';

// The session modules read the recording switches at import time; the settings module
// above has already set them, so they load here, not statically.
const [{ WSession }, { SessionStore }] = await Promise.all([
  import('../../../dist/session/wsession.js'),
  import('../../../dist/session/store.js'),
]);

const s = await WSession.start({
  label: 'version_history_ui_phrase',
  browser: 'chromium',
  headful: process.env.HEADLESS !== '1',
});

try {
  const store = new SessionStore();
  const injected = await store.injectPlaywright(s.ctx, process.env.OVERLEAF_AUTH_LABEL || 'overleaf').catch(() => false);
  console.log(`[version_history_ui] injectedCookies=${injected}`);

  if (!(await ensureDashboard(s))) {
    console.log('[version_history_ui] not authenticated; using Google SSO UI fallback');
    await loginWithGoogleUi(s);
    await store.capturePlaywright(s.ctx, process.env.OVERLEAF_AUTH_LABEL || 'overleaf').catch(() => {});
    if (!(await ensureDashboard(s))) throw new Error('still not authenticated after Google SSO UI flow');
  }
  await dump(s, 'dashboard');
  const projectId = await resolveAndOpenProject(s);
  const editorDump = await dump(s, `editor_${projectId.slice(0, 8)}`);
  if (/Restricted|permission to load this page/i.test(editorDump.bodyText)) {
    throw new Error(`project opened as restricted: ${s.page.url()}`);
  }

  const method = await openHistoryUi(s);
  await s.page.waitForTimeout(3000);
  await dump(s, `history_open_${method}`);

  const summary = await summarizeVisible(s.page, queryText);
  const probes = [];
  const clicks = [];
  probes.push(await probeHistoryState(s, 'probe_initial_history', queryText));
  if (MAIN_TEX) {
    clicks.push(await clickVisibleText(s.page, MAIN_TEX, 'click_current_main_tex', true));
    probes.push(await probeHistoryState(s, 'probe_current_main_tex', queryText, true));
  }

  const historyTargets = Array.from(new Set(summary.visibleItems || []))
    .map(norm)
    .filter((candidate) => candidate.length >= 3 && candidate.length <= 160)
    .filter((candidate) => MAIN_TEX ? candidate !== MAIN_TEX : true)
    .slice(0, MAX_HISTORY_CLICKS);
  for (let i = 0; i < historyTargets.length; i += 1) {
    const label = `click_history_${String(i + 1).padStart(2, '0')}`;
    clicks.push(await clickVisibleText(s.page, historyTargets[i], label));
    probes.push(await probeHistoryState(s, `probe_history_${String(i + 1).padStart(2, '0')}`, queryText));
    if (MAIN_TEX) {
      clicks.push(await clickVisibleText(s.page, MAIN_TEX, `${label}_main_tex`, true));
      probes.push(await probeHistoryState(s, `probe_history_${String(i + 1).padStart(2, '0')}_main_tex`, queryText, true));
    }
  }

  const output = {
    target,
    projectId,
    queryText: norm(queryText),
    phrase: norm(queryText),
    mainTex: MAIN_TEX,
    method,
    clicks,
    probes,
    summary,
  };
  writeSummary(output);
  console.log(JSON.stringify({ projectId, method, summaryPath: OUTPUT_PATH, summary }, null, 2));

  await s.close();
  process.exit(0);
} catch (err) {
  const message = err && err.message ? err.message : String(err);
  await dump(s, 'exception').catch(() => {});
  console.error(`[version_history_ui] FAIL: ${message}`);
  await s.close();
  process.exit(2);
}
