import { getSocialAccount, resolveAccountSession } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { humanClickLocator } from '../../../../dist/human/mouse.js';
import { detectGitHubBanSignals } from '../../../../dist/platforms/github/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkReachable } from '../../_shared/action-runner.mjs';

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
  const cookies = (acct.metadata?.cookies ?? []).filter(c => (c.domain ?? '').includes('github.com'));
  if (cookies.length) {
    await s.ctx.addCookies(cookies).catch(e => console.log(`[star] cookie add error: ${e.message?.slice(0, 80)}`));
    console.log(`[star] Injected ${cookies.length} github.com cookies`);
  }
  let url;
  if (repoUrl) url = repoUrl;
  else if (SEARCH_QUERY) url = `https://github.com/search?q=${encodeURIComponent(SEARCH_QUERY)}&type=repositories&s=stars&o=desc`;
  else url = 'https://github.com/trending';
  await s.goto(url);
  checkReachable(s, 'github');
  await s.page.waitForTimeout(2500);

  const loggedOut = await s.page.evaluate(() => {
    const signInLinks = Array.from(document.querySelectorAll('a[href="/login"], a[href^="/login?"]'));
    return signInLinks.some(a => /sign\s*in/i.test(a.textContent || ''));
  });
  if (loggedOut) throw new Error('not_logged_in: github shows Sign-in link; cookies are stale');

  // If we're on trending or search, navigate into the first repo.
  if (!repoUrl) {
    const repoLink = s.page.locator('article h3 a, article h2 a, a[data-hydro-click*="REPOSITORY"]').filter({ visible: true }).first();
    await repoLink.waitFor({ state: 'visible' });
    await humanClickLocator(s.page, repoLink);
    await s.page.waitForLoadState('domcontentloaded');
    await s.page.waitForTimeout(2000);
  }

  // Star form: <form action="/{owner}/{repo}/star"> → <button name="star"> Star</button>.
  // After submit, GitHub re-renders to <form action="/{owner}/{repo}/unstar">.
  const unstarForm = s.page.locator('form[action$="/unstar"]').filter({ visible: true }).first();
  if (await unstarForm.count()) {
    ban = await detectGitHubBanSignals(s.page, s.capturedResponses).catch(() => null);
    console.log(`[ban-signal] ${ban?.signal}  PASS: already starred`);
  } else {
    const starBtn = s.page.locator('form[action$="/star"] button[type="submit"]').filter({ visible: true }).first();
    await starBtn.waitFor({ state: 'visible' });
    await starBtn.scrollIntoViewIfNeeded().catch(() => {});
    await humanClickLocator(s.page, starBtn);
    // Wait for state flip — Unstar form appears, action attribute changes.
    await s.page.locator('form[action$="/unstar"]').first().waitFor({ state: 'visible', timeout: 12000 });
    ban = await detectGitHubBanSignals(s.page, s.capturedResponses).catch(() => null);
    console.log(`[ban-signal] ${ban?.signal}  PASS: starred`);
  }
} catch (e) {
  ban = e.banSignal ?? await detectGitHubBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  FAIL: ${e.message?.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  if (ban) { try { const dir = join(process.cwd(), 'recordings', 'github_star'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'github_star', repo_url: repoUrl, search_query: SEARCH_QUERY, ...ban, ts: new Date().toISOString() }, null, 2)); } catch {} }
  await s.close();
}
