import { WSession } from '../../dist/session/wsession.js';
import { execute } from '../../dist/agent/loop.js';

const URL = 'https://www.linkedin.com/login';
const GOAL = `Fill "session_key" with $SVC_EMAIL. Fill "session_password" with $SVC_PASSWORD. Click "Sign in". Wait 5 seconds. If captcha, solve_captcha(). done(value="logged in").`;

if (!process.env.LINKEDIN_EMAIL) { console.log('SKIP — set LINKEDIN_EMAIL'); process.exit(0); }
process.env.SVC_EMAIL = process.env.LINKEDIN_EMAIL;
process.env.SVC_PASSWORD = process.env.LINKEDIN_PASSWORD;

const s = await WSession.start({ label: 'linkedin_login', proxy: process.env.PROXY_URL || undefined });
try {
  await s.goto(URL);
  const result = await execute(s, `Open ${URL}. ${GOAL}`, {
    envHints: { SVC_EMAIL: process.env.SVC_EMAIL, SVC_PASSWORD: '***' },
    flowName: 'linkedin_login',
  });
  console.log('PASS:', result.value);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
