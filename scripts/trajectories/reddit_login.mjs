import { WSession } from '../../dist/session/wsession.js';
import { execute } from '../../dist/agent/loop.js';

const URL = 'https://www.reddit.com/login';
const GOAL = `Fill username/email with $SVC_EMAIL and password with $SVC_PASSWORD. Click Log In or Sign In. Wait for redirect. done(value="logged in").`;

if (!process.env.REDDIT_EMAIL) { console.log('SKIP — set REDDIT_EMAIL'); process.exit(0); }
process.env.SVC_EMAIL = process.env.REDDIT_EMAIL;
process.env.SVC_PASSWORD = process.env.REDDIT_PASSWORD;

const s = await WSession.start({ label: 'reddit_login', proxy: process.env.PROXY_URL || undefined });
try {
  await s.goto(URL);
  const result = await execute(s, `Open ${URL}. ${GOAL}`, {
    envHints: { SVC_EMAIL: process.env.SVC_EMAIL, SVC_PASSWORD: '***' },
    flowName: 'reddit_login',
  });
  console.log('PASS:', result.value);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
