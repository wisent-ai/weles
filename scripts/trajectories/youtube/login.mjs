import { getSocialAccount } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { execute } from '../../../dist/agent/loop.js';

const URL = 'https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fwww.youtube.com%2F';
const GOAL = `Fill email with $SVC_EMAIL. Click Next. Fill password with $SVC_PASSWORD. Click Next. Wait for redirect to youtube.com. Verify the avatar button is visible. done(value="logged in").`;

const acct = await getSocialAccount('youtube');
if (!acct) { console.log('FAIL: no active youtube account in DB'); process.exit(1); }
process.env.SVC_EMAIL = acct.metadata.email ?? acct.username;
process.env.SVC_PASSWORD = acct.metadata.password ?? '';
console.log(`[trajectory] Using account: ${acct.username}`);

const s = await WSession.start({ label: 'youtube_login', proxy: process.env.PROXY_URL || undefined });
try {
  await s.goto(URL);
  const result = await execute(s, `Open ${URL}. ${GOAL}`, {
    envHints: { SVC_EMAIL: process.env.SVC_EMAIL, SVC_PASSWORD: '***' },
    flowName: 'youtube_login',
  });
  console.log('PASS:', result.value);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
