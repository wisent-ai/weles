import { getSocialAccount, resolveAccountSession } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { execute } from '../../../../dist/agent/loop.js';
import { detectGitHubBanSignals } from '../../../../dist/platforms/github/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const REPO_URL_RAW = process.env.REPO_URL || '';
const TARGET_URL = process.env.TARGET_URL || '';
const SEARCH_QUERY = process.env.SEARCH_QUERY || '';

function normalize(raw) {
  if (!raw) return '';
  if (raw.startsWith('http')) return raw;
  if (/^[\w.-]+\/[\w.-]+$/.test(raw)) return `https://github.com/${raw}`;
  return '';
}
const repoUrl = normalize(REPO_URL_RAW) || TARGET_URL;

const acct = await getSocialAccount('github');
if (!acct) { console.log('FAIL: no active github account'); process.exit(1); }
const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'github_star', proxy: proxyUrl, persona });
let ban = null;
try {
  let url;
  if (repoUrl) url = repoUrl;
  else if (SEARCH_QUERY) url = `https://github.com/search?q=${encodeURIComponent(SEARCH_QUERY)}&type=repositories&s=stars&o=desc`;
  else url = 'https://github.com/trending';
  await s.goto(url);
  await s.page.waitForTimeout(2500);

  // Login precondition. GitHub shows the Sign-in header button when logged out;
  // clicking Star on a logged-out session opens a modal and the star never
  // registers. Bail early with a clear signal so the caller can re-auth.
  const loggedOut = await s.page.evaluate(() => {
    const signInLinks = Array.from(document.querySelectorAll('a[href="/login"], a[href^="/login?"]'));
    return signInLinks.some(a => /sign\s*in/i.test(a.textContent || ''));
  });
  if (loggedOut) throw new Error('not_logged_in: github shows Sign-in link; cookies are stale');

  const goal = repoUrl
    ? `You are on a specific GitHub repo page. Find the Star button in the top-right of the repo header (next to Watch and Fork). Click it. Then VERIFY: read the page and confirm the button now says "Starred" (not "Star") AND/OR the count has incremented. If the button still says "Star", click it once more then re-verify. Only done(value="starred") after the button reads "Starred". If after two click attempts the button still reads "Star", give_up(reason="star_did_not_persist"). Do NOT navigate().`
    : `You are on a GitHub search results or trending page listing repos. Click the first repo title to open it. Then find the Star button in the top-right and click it. VERIFY: the button should now read "Starred". If still "Star", retry once. Only done(value="starred") after the button reads "Starred". Otherwise give_up(reason="star_did_not_persist").`;
  const result = await execute(s, goal, { flowName: 'github_star' });

  // Independent DOM verification in case the agent lied. GitHub renders the
  // Star form as <form><button name="star"> when unstarred and
  // <form><button name="unstar"> when starred. The latter also has
  // aria-label="Unstar <owner>/<repo>".
  const domVerified = await s.page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const unstar = btns.some(b => /^unstar\s/i.test(b.getAttribute('aria-label') || '') || /^unstar$/i.test((b.getAttribute('name') || '').trim()));
    return unstar;
  });
  if (!domVerified) throw new Error('star_did_not_persist: DOM still shows unstarred state after done');

  ban = await detectGitHubBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  PASS: ${result.value}`);
} catch (e) {
  ban = await detectGitHubBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  FAIL: ${e.message?.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  if (ban) { try { const dir = join(process.cwd(), 'recordings', 'github_star'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'github_star', repo_url: repoUrl, search_query: SEARCH_QUERY, ...ban, ts: new Date().toISOString() }, null, 2)); } catch {} }
  await s.close();
}
