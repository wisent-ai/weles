import { getSocialAccount, resolveAccountSession, markCookiesStale } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { humanClickLocator } from '../../../../dist/human/mouse.js';
import { detectRedditBanSignals } from '../../../../dist/platforms/reddit/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkReachable } from '../../_shared/action-runner.mjs';
import { assertAuthed, AuthProbeError } from '../../_shared/auth-probe.mjs';

const SUBREDDIT = (process.env.SUBREDDIT || 'popular').replace(/^r\//, '');
const TARGET_URL = process.env.TARGET_URL || '';

const acct = await getSocialAccount('reddit');
if (!acct) { console.log('FAIL: no active reddit account'); process.exit(1); }
const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'reddit_upvote', proxy: proxyUrl, persona });
const _stored = (acct.metadata?.cookies ?? []).filter(c => /reddit\.com/.test(c.domain ?? ''));
if (_stored.length) await s.ctx.addCookies(_stored.map(c => ({ ...c, path: c.path || '/' }))).catch(() => {});
let ban = null;
try {
  // Use old.reddit.com — the vote arrow is a plain DOM element with stable
  // class names (arrow.up / arrow.upmod) rather than the new-reddit shadow
  // DOM that requires custom-element traversal.
  const baseUrl = TARGET_URL || `https://old.reddit.com/r/${encodeURIComponent(SUBREDDIT)}/`;
  const url = baseUrl.replace(/^https?:\/\/(www\.)?reddit\.com/, 'https://old.reddit.com');
  await s.goto(url);
  checkReachable(s, 'reddit');
  await s.page.waitForTimeout(3000);
  try { await assertAuthed('reddit', s, { label: 'reddit_upvote' }); }
  catch (probeErr) { if (probeErr instanceof AuthProbeError) { console.log(`FAIL: ${probeErr.message}`); await markCookiesStale(acct.id); process.exit(1); } throw probeErr; }
  // First not-yet-upvoted post arrow. After a successful upvote the same
  // div's class flips from "arrow up" to "arrow upmod".
  const upArrow = s.page.locator('div.thing div.arrows div.arrow.up').first();
  await upArrow.waitFor({ state: 'visible' });
  await upArrow.scrollIntoViewIfNeeded();
  await humanClickLocator(s.page, upArrow);
  await s.page.locator('div.thing div.arrows div.arrow.upmod').first().waitFor({ state: 'visible' });
  ban = await detectRedditBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  PASS: upvoted`);
} catch (e) {
  ban = e.banSignal ?? await detectRedditBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  FAIL: ${e.message?.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  if (ban) { try { const dir = join(process.cwd(), 'recordings', 'reddit_upvote'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'reddit_upvote', subreddit: SUBREDDIT, target_url: TARGET_URL, ...ban, ts: new Date().toISOString() }, null, 2)); } catch {} }
  await s.close();
}
