import { getSocialAccount, resolveAccountSession } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { execute } from '../../../../dist/agent/loop.js';
import { detectInstagramBanSignals } from '../../../../dist/platforms/instagram/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const acct = await getSocialAccount('instagram');
if (!acct) { console.log('FAIL: no active instagram account'); process.exit(1); }
const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'instagram_story_view', proxy: proxyUrl, persona });
let ban = null;
try {
  await s.goto('https://www.instagram.com/');
  await s.page.waitForTimeout(3000);
  const result = await execute(s, `You are on the Instagram home feed. At the top of the feed you should see a row of story circles from people you follow. Click the first story circle to open the stories viewer. Let stories auto-advance for about 15 seconds (at least 3 stories). Then click the X to close. done(value="viewed"). Do NOT navigate() beyond the stories viewer. Do NOT give_up.`, { flowName: 'instagram_story_view' });
  ban = await detectInstagramBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  PASS: ${result.value}`);
} catch (e) {
  ban = await detectInstagramBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  FAIL: ${e.message?.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  if (ban) { try { const dir = join(process.cwd(), 'recordings', 'instagram_story_view'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'instagram_story_view', ...ban, ts: new Date().toISOString() }, null, 2)); } catch {} }
  await s.close();
}
