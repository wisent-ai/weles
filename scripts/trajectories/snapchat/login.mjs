import { getSocialAccount } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { execute } from '../../../dist/agent/loop.js';

const URL = 'https://accounts.snapchat.com/accounts/login';
const GOAL = `Fill username/email with $SVC_USER. Click Next. Fill password with $SVC_PASSWORD. Click the Log In button. Wait for redirect to accounts.snapchat.com dashboard. Verify the My Account heading is visible. done(value="logged in").`;

const acct = await getSocialAccount('snapchat');
if (!acct) { console.log('FAIL: no active snapchat account in DB'); process.exit(1); }
process.env.SVC_USER = acct.metadata.email ?? acct.username;
process.env.SVC_PASSWORD = acct.metadata.password ?? '';
console.log(`[trajectory] Using account: ${acct.username}`);

const s = await WSession.start({ label: 'snapchat_login', proxy: process.env.PROXY_URL || undefined });
try {
  await s.goto(URL);
  const result = await execute(s, `Open ${URL}. ${GOAL}`, {
    envHints: { SVC_USER: process.env.SVC_USER, SVC_PASSWORD: '***' },
    flowName: 'snapchat_login',
  });
  console.log('PASS:', result.value);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
