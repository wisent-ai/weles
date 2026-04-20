import { getSocialAccount } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { execute } from '../../../dist/agent/loop.js';

const TARGET = process.env.TARGET_USERNAME || 'team.snapchat';
const LOGIN_URL = 'https://accounts.snapchat.com/accounts/login';
const GOAL = `Fill username/email with $SVC_USER. Click Next. Fill password with $SVC_PASSWORD. Click Log In. Wait for redirect to accounts.snapchat.com. navigate(url="https://web.snapchat.com/"). Click the Add Friends / search icon. Type: ${TARGET}. Click the Add button next to the matching result. Verify the Add button turns into Added or Pending. done(value="added ${TARGET}").`;

const acct = await getSocialAccount('snapchat');
if (!acct) { console.log('FAIL: no active snapchat account in DB'); process.exit(1); }
process.env.SVC_USER = acct.metadata.email ?? acct.username;
process.env.SVC_PASSWORD = acct.metadata.password ?? '';
console.log(`[trajectory] Using account: ${acct.username} target=${TARGET}`);

const s = await WSession.start({ label: 'snapchat_add_friend', proxy: process.env.PROXY_URL || undefined });
try {
  await s.goto(LOGIN_URL);
  const result = await execute(s, `Open ${LOGIN_URL}. ${GOAL}`, {
    envHints: { SVC_USER: process.env.SVC_USER, SVC_PASSWORD: '***' },
    flowName: 'snapchat_add_friend',
  });
  console.log('PASS:', result.value);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
