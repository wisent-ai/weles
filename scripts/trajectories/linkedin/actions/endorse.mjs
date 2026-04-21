import { getSocialAccount, resolveAccountSession } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { execute } from '../../../../dist/agent/loop.js';
import { detectLinkedInBanSignals } from '../../../../dist/platforms/linkedin/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const acct = await getSocialAccount('linkedin');
if (!acct) { console.log('FAIL: no active linkedin account'); process.exit(1); }
const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'linkedin_endorse', proxy: proxyUrl, persona });
let ban = null;
try {
  await s.goto('https://www.linkedin.com/mynetwork/invite-connect/connections/');
  await s.page.waitForTimeout(2500);
  const result = await execute(s, `You are on LinkedIn's connections list. Click the first connection's profile. On their profile, scroll to the Skills section. Click the "+" icon next to any skill to endorse it. done(value="endorsed"). Do NOT give_up.`, { flowName: 'linkedin_endorse' });
  ban = await detectLinkedInBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  PASS: ${result.value}`);
} catch (e) {
  ban = await detectLinkedInBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  FAIL: ${e.message?.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  if (ban) { try { const dir = join(process.cwd(), 'recordings', 'linkedin_endorse'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'linkedin_endorse', ...ban, ts: new Date().toISOString() }, null, 2)); } catch {} }
  await s.close();
}
