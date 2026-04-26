import { getSocialAccount, resolveAccountSession } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { execute } from '../../../../dist/agent/loop.js';
import { detectInstagramBanSignals } from '../../../../dist/platforms/instagram/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkReachable } from '../../_shared/action-runner.mjs';

const TARGET_URL = process.env.TARGET_URL || '';

const acct = await getSocialAccount('instagram');
if (!acct) { console.log('FAIL: no active instagram account'); process.exit(1); }
const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'instagram_save', proxy: proxyUrl, persona });
let ban = null;
try {
  await s.goto(TARGET_URL || 'https://www.instagram.com/explore/');
  checkReachable(s, 'instagram');
  await s.page.waitForTimeout(3500);
  const goal = TARGET_URL
    ? `You are on a specific Instagram post. Find the bookmark icon (ribbon shape) in the action row beneath the image. Click it. done(value="saved"). Do NOT navigate(). Do NOT give_up.`
    : `You are on Instagram explore. Click the first post in the grid to open its modal. Find the bookmark icon (ribbon shape) in the action row. Click it. done(value="saved"). Do NOT navigate beyond the post modal. Do NOT give_up.`;
  const result = await execute(s, goal, { flowName: 'instagram_save' });
  ban = await detectInstagramBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  PASS: ${result.value}`);
} catch (e) {
  ban = e.banSignal ?? await detectInstagramBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  FAIL: ${e.message?.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  if (ban) { try { const dir = join(process.cwd(), 'recordings', 'instagram_save'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'instagram_save', target_url: TARGET_URL, ...ban, ts: new Date().toISOString() }, null, 2)); } catch {} }
  await s.close();
}
