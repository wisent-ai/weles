import { getSocialAccount, resolveAccountSession } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { execute } from '../../../dist/agent/loop.js';
import { detectRedditBanSignals } from '../../../dist/platforms/reddit/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const TARGET_USER = process.env.TARGET_USER || '';
const SUBREDDIT   = process.env.SUBREDDIT   || 'popular';

const acct = await getSocialAccount('reddit');
if (!acct) { console.log('FAIL: no active reddit account'); process.exit(1); }
const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'reddit_follow', proxy: proxyUrl, persona });
let ban = null;
try {
  let author = TARGET_USER.replace(/^u\//, '');
  if (!author) {
    await s.goto(`https://www.reddit.com/r/${SUBREDDIT}/.json?limit=20`);
    const r = s.capturedResponses.find(r => /\/r\/.+\/\.json/.test(r.url));
    try {
      const data = JSON.parse(r?.body ?? '{}');
      const pick = (data?.data?.children ?? []).map(c => c.data).filter(p => p && p.author && p.author !== '[deleted]')[0];
      if (pick) author = pick.author;
    } catch (e) { console.log('[listing-parse]', e.message); }
    if (!author) throw new Error('no author found to follow');
  }
  await s.goto(`https://www.reddit.com/user/${encodeURIComponent(author)}/`);
  await s.page.waitForTimeout(2000);
  const result = await execute(s, `You are on a reddit user profile. Find the Follow button in the profile header. js_click(text="Follow"). done(value="followed"). Do NOT navigate(). Do NOT give_up.`, { flowName: 'reddit_follow' });
  ban = await detectRedditBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  PASS: ${result.value}`);
} catch (e) {
  ban = await detectRedditBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  FAIL: ${e.message?.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  if (ban) { try { const dir = join(process.cwd(), 'recordings', 'reddit_follow'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'reddit_follow', target_user: TARGET_USER, ...ban, ts: new Date().toISOString() }, null, 2)); } catch {} }
  await s.close();
}
