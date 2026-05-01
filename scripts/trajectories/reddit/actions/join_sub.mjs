import { getSocialAccount, resolveAccountSession, markCookiesStale } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { humanClickLocator } from '../../../../dist/human/mouse.js';
import { detectRedditBanSignals } from '../../../../dist/platforms/reddit/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkReachable } from '../../_shared/action-runner.mjs';
import { assertAuthed, AuthProbeError } from '../../_shared/auth-probe.mjs';

const SUBREDDIT = (process.env.SUBREDDIT || 'popular').replace(/^r\//, '');

const acct = await getSocialAccount('reddit');
if (!acct) { console.log('FAIL: no active reddit account'); process.exit(1); }
const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'reddit_join_sub', proxy: proxyUrl, persona });
const _stored = (acct.metadata?.cookies ?? []).filter(c => /reddit\.com/.test(c.domain ?? ''));
if (_stored.length) await s.ctx.addCookies(_stored.map(c => ({ ...c, path: c.path || '/' }))).catch(() => {});
let ban = null;
try {
  // Use old.reddit.com — the subscribe toggle is a plain anchor with stable
  // class-based state markers (.fancy-toggle-button.add → .remove on join)
  // rather than the new-reddit Header SDK which is driven through the
  // shadow DOM of <faceplate-tracker> / shreddit web components.
  await s.goto(`https://old.reddit.com/r/${encodeURIComponent(SUBREDDIT)}/`);
  checkReachable(s, 'reddit');
  try { await assertAuthed('reddit', s, { label: 'reddit_join_sub' }); }
  catch (probeErr) { if (probeErr instanceof AuthProbeError) { console.log(`FAIL: ${probeErr.message}`); await markCookiesStale(acct.id); process.exit(1); } throw probeErr; }
  // Already subscribed? .fancy-toggle-button.remove exists when joined.
  if (await s.page.locator('a.fancy-toggle-button.remove, a.toggle-button.active').first().isVisible().catch(() => false)) {
    ban = await detectRedditBanSignals(s.page, s.capturedResponses).catch(() => null);
    console.log(`[ban-signal] ${ban?.signal}  PASS: already joined r/${SUBREDDIT}`);
  } else {
    const joinBtn = s.page.locator('a.fancy-toggle-button.add, a:has-text("subscribe")').filter({ visible: true }).first();
    await joinBtn.waitFor({ state: 'visible' });
    await joinBtn.scrollIntoViewIfNeeded();
    await humanClickLocator(s.page, joinBtn);
    await s.page.locator('a.fancy-toggle-button.remove, a.toggle-button.active').first().waitFor({ state: 'visible' });
    ban = await detectRedditBanSignals(s.page, s.capturedResponses).catch(() => null);
    console.log(`[ban-signal] ${ban?.signal}  PASS: joined r/${SUBREDDIT}`);
  }
} catch (e) {
  ban = e.banSignal ?? await detectRedditBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  FAIL: ${e.message?.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  if (ban) { try { const dir = join(process.cwd(), 'recordings', 'reddit_join_sub'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'reddit_join_sub', subreddit: SUBREDDIT, ...ban, ts: new Date().toISOString() }, null, 2)); } catch {} }
  await s.close();
}
