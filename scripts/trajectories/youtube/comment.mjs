import { getSocialAccount } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { execute } from '../../../dist/agent/loop.js';

const VIDEO = process.env.VIDEO_URL || 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const COMMENT = process.env.COMMENT_TEXT || 'Great video!';
const LOGIN_URL = 'https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fwww.youtube.com%2F';
const GOAL = `Fill email with $SVC_EMAIL. Click Next. Fill password with $SVC_PASSWORD. Click Next. Wait for redirect to youtube.com. navigate(url="${VIDEO}"). Scroll down until the comment box is in view. Click the comment input box. Type: ${COMMENT}. Click the Comment submit button. done(value="commented").`;

const acct = await getSocialAccount('youtube');
if (!acct) { console.log('FAIL: no active youtube account in DB'); process.exit(1); }
process.env.SVC_EMAIL = acct.metadata.email ?? acct.username;
process.env.SVC_PASSWORD = acct.metadata.password ?? '';
console.log(`[trajectory] Using account: ${acct.username} video=${VIDEO}`);

const s = await WSession.start({ label: 'youtube_comment', proxy: process.env.PROXY_URL || undefined });
try {
  await s.goto(LOGIN_URL);
  const result = await execute(s, `Open ${LOGIN_URL}. ${GOAL}`, {
    envHints: { SVC_EMAIL: process.env.SVC_EMAIL, SVC_PASSWORD: '***' },
    flowName: 'youtube_comment',
  });
  console.log('PASS:', result.value);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
