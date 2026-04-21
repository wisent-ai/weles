import { getSocialAccount, resolveAccountSession } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { execute } from '../../../dist/agent/loop.js';
import { detectInstagramBanSignals } from '../../../dist/platforms/instagram/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const TARGET_URL  = process.env.TARGET_URL || '';
const TARGET_USER = (process.env.TARGET_USER || '').replace(/^@/, '');
const SEARCH_QUERY = (process.env.SEARCH_QUERY || '').replace(/^#/, '');

const acct = await getSocialAccount('instagram');
if (!acct) { console.log('FAIL: no active instagram account'); process.exit(1); }
const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'instagram_like', proxy: proxyUrl, persona });
let ban = null;
try {
  let url;
  if (TARGET_URL) url = TARGET_URL;
  else if (TARGET_USER) url = `https://www.instagram.com/${encodeURIComponent(TARGET_USER)}/`;
  else if (SEARCH_QUERY) url = `https://www.instagram.com/explore/tags/${encodeURIComponent(SEARCH_QUERY)}/`;
  else url = 'https://www.instagram.com/explore/';
  await s.goto(url);
  await s.page.waitForTimeout(3500);
  const goal = TARGET_URL
    ? `You are on a specific Instagram post. Click the heart icon under the image to like it. done(value="liked"). Do NOT navigate(). Do NOT give_up.`
    : `You are on an Instagram grid page. Click the first post to open its modal. Find the heart icon in the action row and click it to like. done(value="liked"). Do NOT navigate beyond the post modal. Do NOT give_up.`;
  const result = await execute(s, goal, { flowName: 'instagram_like' });
  ban = await detectInstagramBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  PASS: ${result.value}`);
} catch (e) {
  ban = await detectInstagramBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  FAIL: ${e.message?.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  if (ban) { try { const dir = join(process.cwd(), 'recordings', 'instagram_like'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'instagram_like', target_url: TARGET_URL, target_user: TARGET_USER, search_query: SEARCH_QUERY, ...ban, ts: new Date().toISOString() }, null, 2)); } catch {} }
  await s.close();
}
