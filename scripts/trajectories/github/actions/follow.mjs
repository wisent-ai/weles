import { getSocialAccount, resolveAccountSession } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { detectGitHubBanSignals } from '../../../../dist/platforms/github/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkReachable } from '../../_shared/action-runner.mjs';

const TARGET_USER = (process.env.TARGET_USER || '').replace(/^@/, '');

const acct = await getSocialAccount('github');
if (!acct) { console.log('FAIL: no active github account'); process.exit(1); }
const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'github_follow', proxy: proxyUrl, persona });
const _stored = (acct.metadata?.cookies ?? []).filter(c => /github\.com/.test(c.domain ?? ''));
if (_stored.length) await s.ctx.addCookies(_stored.map(c => ({ ...c, path: c.path || '/' }))).catch(() => {});

let ban = null;
try {
  // If no target, scrape first user card from /explore. Deterministic: explore renders /users/<name> profile cards in articles.
  let target = TARGET_USER;
  if (!target) {
    await s.goto('https://github.com/explore');
    checkReachable(s, 'github');
    await s.page.waitForTimeout(3000);
    target = await s.page.evaluate(() => {
      const link = Array.from(document.querySelectorAll('a[href^="/"]')).find(a => /^\/[\w-]+$/.test(a.getAttribute('href') || '') && a.querySelector('img.avatar') && a.getAttribute('href')?.length < 25);
      return link ? link.getAttribute('href').replace(/^\//, '') : '';
    });
    if (!target) throw new Error('no target user found on /explore');
  }

  await s.goto(`https://github.com/${encodeURIComponent(target)}`);
  checkReachable(s, 'github');
  await s.page.waitForTimeout(2500);

  // GitHub follow form: <form action="/users/follow?target=<name>"> with
  // <button> Follow </button>. After click form swaps to action="/users/
  // unfollow?target=<name>". Action regex matches the path; the visible
  // form is the one we want.
  const followForm = s.page.locator(`form[action*="/users/follow"]`).filter({ visible: true }).first();
  const unfollowForm = s.page.locator(`form[action*="/users/unfollow"]`).filter({ visible: true }).first();
  const alreadyFollowing = await unfollowForm.count().catch(() => 0);
  if (alreadyFollowing > 0) { console.log(`PASS: already following ${target}`); ban = { signal: 'healthy', healthy: true }; }
  else {
    await followForm.waitFor({ state: 'visible' });
    // GitHub's follow form submits via XHR (no navigation); locator.click
    // hangs waiting for navigation. Drive form.requestSubmit instead.
    await s.page.evaluate(() => {
      const f = document.querySelector('form[action*="/users/follow"]');
      if (f && typeof f.requestSubmit === 'function') f.requestSubmit();
      else if (f) f.submit();
    });
    await s.page.waitForTimeout(2500);
    const after = await s.page.locator(`form[action*="/users/unfollow"]`).filter({ visible: true }).count().catch(() => 0);
    if (after === 0) throw new Error('follow did not register — Unfollow form not visible after submit');
    console.log(`PASS: followed ${target}`);
    ban = await detectGitHubBanSignals(s.page, s.capturedResponses).catch(() => null);
  }
  console.log(`[ban-signal] ${ban?.signal}`);
} catch (e) {
  ban = e.banSignal ?? await detectGitHubBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  FAIL: ${e.message?.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  if (ban) { try { const dir = join(process.cwd(), 'recordings', 'github_follow'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'github_follow', target_user: TARGET_USER, ...ban, ts: new Date().toISOString() }, null, 2)); } catch {} }
  await s.close();
}
