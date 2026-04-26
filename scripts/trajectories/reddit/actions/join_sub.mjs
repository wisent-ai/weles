import { getSocialAccount, resolveAccountSession } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { execute } from '../../../../dist/agent/loop.js';
import { detectRedditBanSignals } from '../../../../dist/platforms/reddit/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkReachable } from '../../_shared/action-runner.mjs';

const SUBREDDIT = (process.env.SUBREDDIT || 'popular').replace(/^r\//, '');

const acct = await getSocialAccount('reddit');
if (!acct) { console.log('FAIL: no active reddit account'); process.exit(1); }
const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'reddit_join_sub', proxy: proxyUrl, persona });
let ban = null;
try {
  await s.goto(`https://www.reddit.com/r/${encodeURIComponent(SUBREDDIT)}/`);
  checkReachable(s, 'reddit');
  await s.page.waitForTimeout(2500);
  const result = await execute(s, `You are on r/${SUBREDDIT}. Find the Join button in the subreddit header (may appear as a circular + icon or a button labelled "Join"). js_click(text="Join"). done(value="joined"). Do NOT navigate(). Do NOT give_up.`, { flowName: 'reddit_join_sub' });
  ban = await detectRedditBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  PASS: ${result.value}`);
} catch (e) {
  ban = e.banSignal ?? await detectRedditBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  FAIL: ${e.message?.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  if (ban) { try { const dir = join(process.cwd(), 'recordings', 'reddit_join_sub'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'reddit_join_sub', subreddit: SUBREDDIT, ...ban, ts: new Date().toISOString() }, null, 2)); } catch {} }
  await s.close();
}
