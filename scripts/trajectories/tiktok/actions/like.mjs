import { getSocialAccount, resolveAccountSession } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { execute } from '../../../../dist/agent/loop.js';
import { detectTikTokBanSignals } from '../../../../dist/platforms/tiktok/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkReachable } from '../../_shared/action-runner.mjs';

const TARGET_URL  = process.env.TARGET_URL || '';
const TARGET_USER = (process.env.TARGET_USER || '').replace(/^@/, '');
const SEARCH_QUERY = (process.env.SEARCH_QUERY || '').replace(/^#/, '');

const acct = await getSocialAccount('tiktok');
if (!acct) { console.log('FAIL: no active tiktok account'); process.exit(1); }
const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'tiktok_like', proxy: proxyUrl, persona });
let ban = null;
try {
  let url;
  if (TARGET_URL) url = TARGET_URL;
  else if (TARGET_USER) url = `https://www.tiktok.com/@${encodeURIComponent(TARGET_USER)}`;
  else if (SEARCH_QUERY) url = `https://www.tiktok.com/tag/${encodeURIComponent(SEARCH_QUERY)}`;
  else url = 'https://www.tiktok.com/foryou';
  await s.goto(url);
  checkReachable(s, 'tiktok');
  await s.page.waitForTimeout(4000);
  const goal = TARGET_URL
    ? `You are on a specific TikTok video. Click the heart icon on the right-hand action rail to like the video. done(value="liked"). Do NOT navigate(). Do NOT give_up.`
    : (TARGET_USER || SEARCH_QUERY)
      ? `You are on a TikTok page showing a grid of videos (profile or hashtag). Click the first video to open it. Then click the heart icon on the right-hand action rail to like. done(value="liked"). Do NOT navigate(). Do NOT give_up.`
      : `You are on the TikTok For You feed. Find the current video's heart icon on the right-hand action rail. Click it to like. done(value="liked"). Do NOT give_up.`;
  const result = await execute(s, goal, { flowName: 'tiktok_like' });
  ban = await detectTikTokBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  PASS: ${result.value}`);
} catch (e) {
  ban = e.banSignal ?? await detectTikTokBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  FAIL: ${e.message?.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  if (ban) { try { const dir = join(process.cwd(), 'recordings', 'tiktok_like'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'tiktok_like', target_url: TARGET_URL, target_user: TARGET_USER, search_query: SEARCH_QUERY, ...ban, ts: new Date().toISOString() }, null, 2)); } catch {} }
  await s.close();
}
