import { getSocialAccount, resolveAccountSession } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { detectTikTokBanSignals } from '../../../../dist/platforms/tiktok/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkReachable } from '../../_shared/action-runner.mjs';

// Watch-through = sit on a single FYP video for its full duration plus one
// replay, then advance. TikTok's recommender uses watch-through ratio as a
// major signal; the ratio must look human.

const acct = await getSocialAccount('tiktok');
if (!acct) { console.log('FAIL: no active tiktok account'); process.exit(1); }
const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'tiktok_watch_through', proxy: proxyUrl, persona });
let ban = null;
try {
  await s.goto('https://www.tiktok.com/foryou');
  checkReachable(s, 'tiktok');
  await s.page.waitForTimeout(4000);
  // Sit on the first video for ~30s (avg TikTok length ~15s, so this is a
  // full watch + about one replay loop). Then advance twice with short dwell.
  await s.page.waitForTimeout(28000 + Math.floor(Math.random() * 6000));
  await s.page.keyboard.press('ArrowDown');
  await s.page.waitForTimeout(12000 + Math.floor(Math.random() * 6000));
  await s.page.keyboard.press('ArrowDown');
  await s.page.waitForTimeout(14000 + Math.floor(Math.random() * 6000));
  ban = await detectTikTokBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  PASS: watched_through_3`);
} catch (e) {
  ban = e.banSignal ?? await detectTikTokBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  FAIL: ${e.message?.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  if (ban) { try { const dir = join(process.cwd(), 'recordings', 'tiktok_watch_through'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'tiktok_watch_through', ...ban, ts: new Date().toISOString() }, null, 2)); } catch {} }
  await s.close();
}
