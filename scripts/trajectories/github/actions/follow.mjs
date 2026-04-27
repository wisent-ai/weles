import { getSocialAccount, resolveAccountSession } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { execute } from '../../../../dist/agent/loop.js';
import { detectGitHubBanSignals } from '../../../../dist/platforms/github/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkReachable } from '../../_shared/action-runner.mjs';

const TARGET_USER = (process.env.TARGET_USER || '').replace(/^@/, '');

const acct = await getSocialAccount('github');
if (!acct) { console.log('FAIL: no active github account'); process.exit(1); }
const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'github_follow', proxy: proxyUrl, persona });
const _stored = (acct.metadata?.cookies ?? []).filter(c => /github\.com/.test(c.domain ?? ''));
if (_stored.length) await s.ctx.addCookies(_stored.map(c => ({ ...c, path: c.path || '/' }))).catch(() => {});
let ban = null;
try {
  const url = TARGET_USER ? `https://github.com/${encodeURIComponent(TARGET_USER)}` : 'https://github.com/explore';
  await s.goto(url);
  checkReachable(s, 'github');
  await s.page.waitForTimeout(3000);
  const goal = TARGET_USER
    ? `You are on GitHub user profile ${TARGET_USER}. Find the Follow button near the top of the profile (below the avatar or in the header). Click it. done(value="followed ${TARGET_USER}"). Do NOT navigate(). Do NOT give_up.`
    : `You are on GitHub Explore. Find a user card in the Explore People section and click its Follow button. done(value="followed"). Do NOT give_up.`;
  const result = await execute(s, goal, { flowName: 'github_follow' });
  ban = await detectGitHubBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  PASS: ${result.value}`);
} catch (e) {
  ban = e.banSignal ?? await detectGitHubBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  FAIL: ${e.message?.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  if (ban) { try { const dir = join(process.cwd(), 'recordings', 'github_follow'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'github_follow', target_user: TARGET_USER, ...ban, ts: new Date().toISOString() }, null, 2)); } catch {} }
  await s.close();
}
