import { getSocialAccount, resolveAccountSession } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { execute } from '../../../../dist/agent/loop.js';
import { detectTwitterBanSignals } from '../../../../dist/platforms/twitter/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const TARGET_URL  = process.env.TARGET_URL || '';
const TARGET_USER = (process.env.TARGET_USER || '').replace(/^@/, '');
const SEARCH_QUERY = (process.env.SEARCH_QUERY || '').replace(/^#/, '');

const acct = await getSocialAccount('twitter');
if (!acct) { console.log('FAIL: no active twitter account'); process.exit(1); }
const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'twitter_like', proxy: proxyUrl, persona });
let ban = null;
try {
  let url;
  if (TARGET_URL) url = TARGET_URL;
  else if (TARGET_USER) url = `https://x.com/${encodeURIComponent(TARGET_USER)}`;
  else if (SEARCH_QUERY) url = `https://x.com/hashtag/${encodeURIComponent(SEARCH_QUERY)}`;
  else url = 'https://x.com/home';
  await s.goto(url);
  await s.page.waitForTimeout(3000);
  const goal = TARGET_URL
    ? `You are on a specific X/Twitter tweet. Click the heart icon in the tweet's action row to like it. done(value="liked"). Do NOT navigate(). Do NOT give_up.`
    : `You are on an X/Twitter page showing tweets. Find the first tweet and click its heart icon in the action row to like it. done(value="liked"). Do NOT navigate(). Do NOT give_up.`;
  const result = await execute(s, goal, { flowName: 'twitter_like' });
  ban = await detectTwitterBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  PASS: ${result.value}`);
} catch (e) {
  ban = await detectTwitterBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  FAIL: ${e.message?.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  if (ban) { try { const dir = join(process.cwd(), 'recordings', 'twitter_like'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'twitter_like', target_url: TARGET_URL, target_user: TARGET_USER, search_query: SEARCH_QUERY, ...ban, ts: new Date().toISOString() }, null, 2)); } catch {} }
  await s.close();
}
