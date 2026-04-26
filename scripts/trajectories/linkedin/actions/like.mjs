import { getSocialAccount, resolveAccountSession } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { execute } from '../../../../dist/agent/loop.js';
import { detectLinkedInBanSignals } from '../../../../dist/platforms/linkedin/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkReachable } from '../../_shared/action-runner.mjs';

const TARGET_URL = process.env.TARGET_URL || '';

const acct = await getSocialAccount('linkedin');
if (!acct) { console.log('FAIL: no active linkedin account'); process.exit(1); }
const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'linkedin_like', proxy: proxyUrl, persona });
let ban = null;
try {
  await s.goto(TARGET_URL || 'https://www.linkedin.com/feed/');
  checkReachable(s, 'linkedin');
  await s.page.waitForTimeout(3000);
  const goal = TARGET_URL
    ? `You are on a specific LinkedIn post. Find the Like reaction button (thumbs-up icon) in the social action bar beneath the post. Click it (not Comment, not Share). done(value="liked"). Do NOT give_up.`
    : `You are on the LinkedIn feed. Find the first post. Click its Like reaction button (thumbs-up icon in the social action bar). done(value="liked"). Do NOT navigate away. Do NOT give_up.`;
  const result = await execute(s, goal, { flowName: 'linkedin_like' });
  ban = await detectLinkedInBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  PASS: ${result.value}`);
} catch (e) {
  ban = e.banSignal ?? await detectLinkedInBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  FAIL: ${e.message?.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  if (ban) { try { const dir = join(process.cwd(), 'recordings', 'linkedin_like'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'linkedin_like', target_url: TARGET_URL, ...ban, ts: new Date().toISOString() }, null, 2)); } catch {} }
  await s.close();
}
