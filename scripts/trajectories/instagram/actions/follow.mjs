import { getSocialAccount, resolveAccountSession } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { execute } from '../../../dist/agent/loop.js';
import { detectInstagramBanSignals } from '../../../dist/platforms/instagram/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const TARGET_USER = (process.env.TARGET_USER || '').replace(/^@/, '');

const acct = await getSocialAccount('instagram');
if (!acct) { console.log('FAIL: no active instagram account'); process.exit(1); }
const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'instagram_follow', proxy: proxyUrl, persona });
let ban = null;
try {
  const url = TARGET_USER ? `https://www.instagram.com/${encodeURIComponent(TARGET_USER)}/` : 'https://www.instagram.com/explore/people/';
  await s.goto(url);
  await s.page.waitForTimeout(3500);
  const goal = TARGET_USER
    ? `You are on Instagram profile ${TARGET_USER}. Find the Follow button in the profile header. Click it. done(value="followed ${TARGET_USER}"). Do NOT navigate(). Do NOT give_up.`
    : `You are on Instagram's Suggested for You page. Find any account card and click its Follow button. done(value="followed"). Do NOT give_up.`;
  const result = await execute(s, goal, { flowName: 'instagram_follow' });
  ban = await detectInstagramBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  PASS: ${result.value}`);
} catch (e) {
  ban = await detectInstagramBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  FAIL: ${e.message?.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  if (ban) { try { const dir = join(process.cwd(), 'recordings', 'instagram_follow'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'instagram_follow', target_user: TARGET_USER, ...ban, ts: new Date().toISOString() }, null, 2)); } catch {} }
  await s.close();
}
