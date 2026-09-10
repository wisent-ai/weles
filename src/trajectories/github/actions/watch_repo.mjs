import { getSocialAccount, resolveAccountSession, markCookiesStale } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { detectGitHubBanSignals } from '../../../../dist/platforms/github/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkReachable } from '../../_shared/action-runner.mjs';
import { humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';
import { assertAuthed, AuthProbeError } from '../../_shared/auth-probe.mjs';
import { runRecordingsDir } from '../../../../dist/session/run-recordings.js';

const REPO_URL_RAW = process.env.REPO_URL || process.env.TARGET_URL || '';
const SEARCH_QUERY = process.env.SEARCH_QUERY || '';

function normalizeRepo(raw) {
  if (!raw) return '';
  if (raw.startsWith('http')) return raw;
  if (/^[\w.-]+\/[\w.-]+$/.test(raw)) return `https://github.com/${raw}`;
  return '';
}
const repoUrl = normalizeRepo(REPO_URL_RAW);

const acct = await getSocialAccount('github');
if (!acct) { console.log('FAIL: no active github account'); process.exit(1); }
const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'github_watch_repo', proxy: proxyUrl, persona });
const _stored = (acct.metadata?.cookies ?? []).filter(c => /github\.com/.test(c.domain ?? ''));
if (_stored.length) await s.ctx.addCookies(_stored.map(c => ({ ...c, path: c.path || '/' }))).catch(() => {});
let ban = null;
try {
  let url;
  if (repoUrl) url = repoUrl;
  else if (SEARCH_QUERY) url = `https://github.com/search?q=${encodeURIComponent(SEARCH_QUERY)}&type=repositories&s=stars&o=desc`;
  else url = 'https://github.com/trending';
  await s.goto(url);
  checkReachable(s, 'github');
  await humanIdlePause('deliberate');
  try { await assertAuthed('github', s, { label: 'github_watch_repo' }); }
  catch (probeErr) { if (probeErr instanceof AuthProbeError) { console.log(`FAIL: ${probeErr.message}`); await markCookiesStale(acct.id); process.exit(1); } throw probeErr; }
  // Deterministic Playwright. Trending/search pages don't have a Watch
  // button — first navigate into the first repo. Then click the Watch
  // button (aria-label="Watch: ..."), pick "Participating and @mentions"
  // from the dropdown.
  if (!repoUrl) {
    const firstRepoLink = s.page.locator('a[href^="/"]').filter({ hasText: /\// }).filter({ visible: true }).first();
    await humanClickLocator(s.page, firstRepoLink);
    await s.page.waitForLoadState('domcontentloaded');
    await humanIdlePause('deliberate');
  }
  // GitHub watch button: aria-label starts with "Watch:" when not watching,
  // text includes "(N)" subscriber count. Already-watching shows
  // "Watch: <ActivityLevel> in repo" — short-circuit PASS.
  const watchBtn = s.page.locator('button[aria-label^="Watch"]').filter({ visible: true }).first();
  await watchBtn.waitFor({ state: 'visible' });
  const ariaBefore = await watchBtn.getAttribute('aria-label');
  if (/Watch: (Participating|All Activity|Custom)/.test(ariaBefore || '')) {
    console.log(`PASS: already watching (${ariaBefore})`);
    ban = await detectGitHubBanSignals(s.page, s.capturedResponses).catch(() => null);
  } else {
    await humanClickLocator(s.page, watchBtn);
    await humanIdlePause('short');
    await humanClickLocator(s.page, s.page.locator('label, button').filter({ hasText: /Participating and @mentions/ }).filter({ visible: true }).first());
    await humanIdlePause('deliberate');
    const ariaAfter = await s.page.locator('button[aria-label^="Watch"]').first().getAttribute('aria-label').catch(() => null);
    ban = await detectGitHubBanSignals(s.page, s.capturedResponses).catch(() => null);
    if (/Watch: (Participating|All Activity|Custom)/.test(ariaAfter || '')) console.log(`PASS: now watching (${ariaAfter})`);
    else { console.log(`FAIL: aria-label did not transition (before=${ariaBefore} after=${ariaAfter})`); throw new Error('watch did not register'); }
  }
  console.log(`[ban-signal] ${ban?.signal}`);
} catch (e) {
  ban = e.banSignal ?? await detectGitHubBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  FAIL: ${e.message?.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  if (ban) { try { const dir = runRecordingsDir('github_watch_repo'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'github_watch_repo', ...ban, ts: new Date().toISOString() }, null, 2)); } catch {} }
  await s.close();
}
