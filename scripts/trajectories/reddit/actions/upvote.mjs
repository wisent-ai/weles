import { getSocialAccount, resolveAccountSession } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { execute } from '../../../../dist/agent/loop.js';
import { detectRedditBanSignals } from '../../../../dist/platforms/reddit/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SUBREDDIT = (process.env.SUBREDDIT || 'popular').replace(/^r\//, '');
const TARGET_URL = process.env.TARGET_URL || '';

const acct = await getSocialAccount('reddit');
if (!acct) { console.log('FAIL: no active reddit account'); process.exit(1); }
const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'reddit_upvote', proxy: proxyUrl, persona });
let ban = null;
try {
  const url = TARGET_URL || `https://www.reddit.com/r/${encodeURIComponent(SUBREDDIT)}/`;
  await s.goto(url);
  await s.page.waitForTimeout(3000);
  const goal = TARGET_URL
    ? `You are on a specific reddit post. Find the upvote arrow (top of the vote column). Use js_click(text="upvote") to upvote it. done(value="upvoted"). Do NOT navigate(). Do NOT give_up.`
    : `You are on r/${SUBREDDIT} listing. Use js_click(text="upvote") to upvote the first post in the listing. done(value="upvoted"). Do NOT navigate(). Do NOT give_up.`;
  const result = await execute(s, goal, { flowName: 'reddit_upvote' });
  ban = await detectRedditBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  PASS: ${result.value}`);
} catch (e) {
  ban = await detectRedditBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  FAIL: ${e.message?.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  if (ban) { try { const dir = join(process.cwd(), 'recordings', 'reddit_upvote'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'reddit_upvote', subreddit: SUBREDDIT, target_url: TARGET_URL, ...ban, ts: new Date().toISOString() }, null, 2)); } catch {} }
  await s.close();
}
