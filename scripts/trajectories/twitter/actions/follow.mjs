import { getSocialAccount, resolveAccountSession } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { execute } from '../../../../dist/agent/loop.js';
import { detectTwitterBanSignals } from '../../../../dist/platforms/twitter/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkReachable } from '../../_shared/action-runner.mjs';

const TARGET_USER = (process.env.TARGET_USER || '').replace(/^@/, '');

const acct = await getSocialAccount('twitter');
if (!acct) { console.log('FAIL: no active twitter account'); process.exit(1); }
const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'twitter_follow', proxy: proxyUrl, persona });
const _stored = (acct.metadata?.cookies ?? []).filter(c => /x\.com|twitter\.com/.test(c.domain ?? ''));
if (_stored.length) await s.ctx.addCookies(_stored.map(c => ({ ...c, path: c.path || '/' }))).catch(() => {});
let ban = null;
try {
  const url = TARGET_USER ? `https://x.com/${encodeURIComponent(TARGET_USER)}` : 'https://x.com/home';
  await s.goto(url);
  checkReachable(s, 'twitter');
  await s.page.waitForTimeout(3000);
  const goal = TARGET_USER
    ? `You are on X/Twitter profile @${TARGET_USER}. Find the Follow button in the profile header (near the user name, not in the sidebar). Click it. done(value="followed @${TARGET_USER}"). Do NOT navigate(). Do NOT give_up.`
    : `You are on the X/Twitter home timeline. In the "Who to follow" sidebar, find any account's Follow button and click it. done(value="followed"). Do NOT give_up.`;
  const result = await execute(s, goal, { flowName: 'twitter_follow' });
  ban = await detectTwitterBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  PASS: ${result.value}`);
} catch (e) {
  ban = e.banSignal ?? await detectTwitterBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  FAIL: ${e.message?.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  if (ban) { try { const dir = join(process.cwd(), 'recordings', 'twitter_follow'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'twitter_follow', target_user: TARGET_USER, ...ban, ts: new Date().toISOString() }, null, 2)); } catch {} }
  await s.close();
}
