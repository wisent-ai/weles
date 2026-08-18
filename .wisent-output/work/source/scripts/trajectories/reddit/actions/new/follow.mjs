import { getSocialAccount, resolveAccountSession, markCookiesStale } from '../../../../../dist/utils/credentials.js';
import { WSession } from '../../../../../dist/session/wsession.js';
import { humanClickLocator, humanIdlePause } from '../../../../../dist/human/mouse.js';
import { detectRedditBanSignals } from '../../../../../dist/platforms/reddit/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkReachable } from '../../../_shared/action-runner.mjs';
import { assertAuthed, AuthProbeError } from '../../../_shared/auth-probe.mjs';
import { runRecordingsDir } from '../../../../../dist/session/run-recordings.js';

const TARGET_USER = (process.env.TARGET_USER || '').replace(/^u\//, '').replace(/^\/u\//, '');
const SUBREDDIT   = (process.env.SUBREDDIT   || 'popular').replace(/^r\//, '');

const acct = await getSocialAccount('reddit');
if (!acct) { console.log('FAIL: no active reddit account'); process.exit(1); }
const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'reddit_follow_new', proxy: proxyUrl, persona, targetHost: 'www.reddit.com' });
const _stored = (acct.metadata?.cookies ?? []).filter(c => /reddit\.com/.test(c.domain ?? ''));
if (_stored.length) await s.ctx.addCookies(_stored.map(c => ({ ...c, path: c.path || '/' }))).catch(() => {});
let ban = null;
try {
  let author = TARGET_USER;
  if (!author) {
    // Pick a random author from the subreddit's recent posts via JSON.
    await s.goto(`https://www.reddit.com/r/${encodeURIComponent(SUBREDDIT)}/`);
    checkReachable(s, 'reddit');
    const data = await s.page.evaluate(async (u) => {
      try { const r = await fetch(u, { credentials: 'include', headers: { 'Accept': 'application/json' } }); if (!r.ok) return null; return await r.json(); } catch { return null; }
    }, `https://www.reddit.com/r/${encodeURIComponent(SUBREDDIT)}/new/.json?limit=50&raw_json=1`).catch(() => null);
    const pick = (data?.data?.children ?? []).map(c => c.data).filter(p => p && p.author && p.author !== '[deleted]' && !/^AutoModerator$/i.test(p.author))[0];
    if (pick) author = pick.author;
    if (!author) throw new Error('no author found to follow');
  }
  // Modern shreddit follow flow lives at /user/<author>/. The page renders a
  // <follow-button redditor-id="t2_..." is-desktop is-logged-in> custom
  // element with two slots: button-follow (visible when not following) and
  // button-unfollow (visible after follow). The visible state is the active
  // button — Playwright's `:visible` filter resolves to the right one.
  // Verified against /user/OpenAI/ in SSR HTML 2026-05-02 (offsets 554435,
  // 556554): outer <follow-button>, inner button.follow-button has child
  // <span class="button-text">Follow</span>.
  await s.goto(`https://www.reddit.com/user/${encodeURIComponent(author)}/`);
  checkReachable(s, 'reddit');
  await humanIdlePause('deliberate');
  try { await assertAuthed('reddit', s, { label: 'reddit_follow_new' }); }
  catch (probeErr) { if (probeErr instanceof AuthProbeError) { console.log(`FAIL: ${probeErr.message}`); await markCookiesStale(acct.id); process.exit(1); } throw probeErr; }
  const followComp = s.page.locator('follow-button').first();
  await followComp.waitFor({ state: 'attached' });
  // Already following? unfollow-button child is visible.
  const alreadyFollowing = await followComp.locator('button.unfollow-button').first().isVisible().catch(() => false);
  if (alreadyFollowing) {
    ban = await detectRedditBanSignals(s.page, s.capturedResponses).catch(() => null);
    console.log(`[ban-signal] ${ban?.signal}  PASS: already following u/${author}`);
  } else {
    const followBtn = followComp.locator('button.follow-button').filter({ visible: true }).first();
    await followBtn.waitFor({ state: 'visible' });
    await followBtn.scrollIntoViewIfNeeded();
    await humanIdlePause('short');
    await humanClickLocator(s.page, followBtn);
    // After click, the slot swaps and unfollow-button becomes the visible one.
    await followComp.locator('button.unfollow-button').first().waitFor({ state: 'visible' });
    ban = await detectRedditBanSignals(s.page, s.capturedResponses).catch(() => null);
    console.log(`[ban-signal] ${ban?.signal}  PASS: now following u/${author}`);
  }
} catch (e) {
  ban = e.banSignal ?? await detectRedditBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  FAIL: ${e.message?.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  if (ban) { try { const dir = runRecordingsDir('reddit_follow_new'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'reddit_follow_new', target_user: TARGET_USER, ...ban, ts: new Date().toISOString() }, null, 2)); } catch {} }
  await s.close();
}
