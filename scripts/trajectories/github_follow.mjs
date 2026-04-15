import { WSession } from '../../dist/session/wsession.js';
import { execute } from '../../dist/agent/loop.js';

const URL = 'https://github.com/login';
const GOAL = `Fill username/email with $SVC_EMAIL and password with $SVC_PASSWORD. Click Log In or Sign In. Wait for redirect. After login, navigate(url="https://github.com/lbartoszcze"). Wait 3 seconds. Click "Follow". done(value="followed lbartoszcze").`;

if (!process.env.GITHUB_EMAIL) { console.log('SKIP — set GITHUB_EMAIL'); process.exit(0); }
process.env.SVC_EMAIL = process.env.GITHUB_EMAIL;
process.env.SVC_PASSWORD = process.env.GITHUB_PASSWORD;

const s = await WSession.start({ label: 'github_follow', proxy: process.env.PROXY_URL || undefined });
try {
  await s.goto(URL);
  const result = await execute(s, `Open ${URL}. ${GOAL}`, {
    envHints: { SVC_EMAIL: process.env.SVC_EMAIL, SVC_PASSWORD: '***' },
    flowName: 'github_follow',
  });
  console.log('PASS:', result.value);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
