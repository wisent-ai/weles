import { WSession } from '../../dist/session/wsession.js';
import { execute } from '../../dist/agent/loop.js';

const URL = 'https://x.com/i/flow/login';
const GOAL = `Fill username/email with $SVC_EMAIL. Click Next. Fill password with $SVC_PASSWORD. Click "Log in". Wait for redirect. Wait 5 seconds. Find any tweet and click the heart/like button. done(value="liked").`;

if (!process.env.TWITTER_EMAIL) { console.log('SKIP — set TWITTER_EMAIL'); process.exit(0); }
process.env.SVC_EMAIL = process.env.TWITTER_EMAIL;
process.env.SVC_PASSWORD = process.env.TWITTER_PASSWORD;

const s = await WSession.start({ label: 'twitter_like', proxy: process.env.PROXY_URL || undefined });
try {
  await s.goto(URL);
  const result = await execute(s, `Open ${URL}. ${GOAL}`, {
    envHints: { SVC_EMAIL: process.env.SVC_EMAIL, SVC_PASSWORD: '***' },
    flowName: 'twitter_like',
  });
  console.log('PASS:', result.value);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
