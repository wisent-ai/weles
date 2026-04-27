import { getSocialAccount, resolveAccountSession } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { execute } from '../../../../dist/agent/loop.js';
import { detectInstagramBanSignals } from '../../../../dist/platforms/instagram/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkReachable } from '../../_shared/action-runner.mjs';

const acct = await getSocialAccount('instagram');
if (!acct) { console.log('FAIL: no active instagram account'); process.exit(1); }
const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'instagram_story_view', proxy: proxyUrl, persona });
const _stored = (acct.metadata?.cookies ?? []).filter(c => /instagram\.com/.test(c.domain ?? ''));
if (_stored.length) await s.ctx.addCookies(_stored.map(c => ({ ...c, path: c.path || '/' }))).catch(() => {});
let ban = null;
try {
  await s.goto('https://www.instagram.com/');
  checkReachable(s, 'instagram');
  await s.page.waitForTimeout(3000);
  const result = await execute(s, `You are on the Instagram home feed. At the top of the feed you should see a row of story circles from people you follow. Click the first story circle to open the stories viewer. Let stories auto-advance for about 15 seconds (at least 3 stories). Then click the X to close. done(value="viewed"). Do NOT navigate() beyond the stories viewer. Do NOT give_up.`, { flowName: 'instagram_story_view' });
  ban = await detectInstagramBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  PASS: ${result.value}`);
} catch (e) {
  ban = e.banSignal ?? await detectInstagramBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  FAIL: ${e.message?.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  if (ban) { try { const dir = join(process.cwd(), 'recordings', 'instagram_story_view'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'instagram_story_view', ...ban, ts: new Date().toISOString() }, null, 2)); } catch {} }
  await s.close();
}
