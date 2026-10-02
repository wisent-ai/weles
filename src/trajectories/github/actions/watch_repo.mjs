import { getSocialAccount, resolveAccountSession, markCookiesStale } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { detectGitHubBanSignals } from '../../../../dist/platforms/github/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkReachable } from '../../_shared/action-runner.mjs';
import { humanClickLocator } from '../../../../dist/human/mouse.js';
import { assertAuthed, AuthProbeError } from '../../_shared/auth/auth-probe.mjs';
import { runRecordingsDir } from '../../../../dist/session/run-recordings.js';
import { pageCondition, pageSettled } from '../../_shared/page/settled.mjs';

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
let ban = null;
try {
  const stored = (acct.metadata?.cookies ?? []).filter(c => /github\.com/.test(c.domain ?? ''));
  if (stored.length) await s.ctx.addCookies(stored.map(c => ({ ...c, path: c.path || '/' })));
  let url;
  if (repoUrl) url = repoUrl;
  else if (SEARCH_QUERY) url = `https://github.com/search?q=${encodeURIComponent(SEARCH_QUERY)}&type=repositories&s=stars&o=desc`;
  else url = 'https://github.com/trending';
  await s.goto(url);
  checkReachable(s, 'github');
  await pageSettled(s.page);
  try { await assertAuthed('github', s, { label: 'github_watch_repo' }); }
  catch (probeErr) {
    if (probeErr instanceof AuthProbeError) {
      try { await markCookiesStale(acct.id); }
      catch (markError) { throw new AggregateError([probeErr, markError], 'GitHub authentication and stale-cookie recording failed'); }
    }
    throw probeErr;
  }
  // Deterministic Playwright. Trending/search pages don't have a Watch
  // button — first navigate into the first repo. Then click the Watch
  // button (aria-label="Watch: ..."), pick "Participating and @mentions"
  // from the dropdown.
  if (!repoUrl) {
    const firstRepoLink = s.page.locator('a[href^="/"]').filter({ hasText: /\// }).filter({ visible: true }).first();
    await humanClickLocator(s.page, firstRepoLink);
    await s.page.waitForLoadState('domcontentloaded');
    await pageSettled(s.page);
  }
  // GitHub watch button: aria-label starts with "Watch:" when not watching,
  // text includes "(N)" subscriber count. Already-watching shows
  // "Watch: <ActivityLevel> in repo" — short-circuit PASS.
  const watchBtn = s.page.locator('button[aria-label^="Watch"]').filter({ visible: true }).first();
  await watchBtn.waitFor({ state: 'visible' });
  const ariaBefore = await watchBtn.getAttribute('aria-label');
  if (/Watch: (Participating|All Activity|Custom)/.test(ariaBefore || '')) {
    ban = await detectGitHubBanSignals(s.page, s.capturedResponses);
    console.log(`PASS: already watching (${ariaBefore})`);
  } else {
    await humanClickLocator(s.page, watchBtn);
    const participating = s.page.locator('label, button').filter({ hasText: /Participating and @mentions/ }).filter({ visible: true }).first();
    await participating.waitFor({ state: 'visible' });
    await humanClickLocator(s.page, participating);
    const result = await pageCondition(s.page, () => {
      const visible = (node) => node.getClientRects().length > 0 && getComputedStyle(node).visibility === 'visible';
      const button = Array.from(document.querySelectorAll('button[aria-label^="Watch"]')).find(visible);
      const label = button?.getAttribute('aria-label') || '';
      if (/Watch: (Participating|All Activity|Custom)/.test(label)) return { state: 'changed', label };
      const error = Array.from(document.querySelectorAll('.flash-error')).find(visible);
      if (error?.textContent?.trim()) return { state: 'refused', label, message: error.textContent.trim() };
      return null;
    });
    if (result.state === 'refused') throw new Error(`GITHUB_WATCH_REFUSED: ${result.message}; before=${ariaBefore}; after=${result.label}`);
    ban = await detectGitHubBanSignals(s.page, s.capturedResponses);
    console.log(`PASS: watch control shows ${result.label}`);
  }
  console.log(`[ban-signal] ${ban?.signal}`);
} catch (e) {
  console.error('GITHUB_WATCH_FAILED:', e);
  ban = e?.banSignal ?? null;
  if (!ban) {
    try { ban = await detectGitHubBanSignals(s.page, s.capturedResponses); }
    catch (error) { console.error('GITHUB_BAN_OBSERVATION_FAILED:', error); }
  }
  process.exitCode = 1;
} finally {
  if (ban) {
    try {
      const dir = runRecordingsDir('github_watch_repo');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'github_watch_repo', ...ban, ts: new Date().toISOString() }, null, 2));
    } catch (error) {
      console.error('GITHUB_BAN_RECORD_FAILED:', error);
      process.exitCode = 1;
    }
  }
  await s.close();
}
