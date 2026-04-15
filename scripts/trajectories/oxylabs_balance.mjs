import { WSession } from '../../dist/session/wsession.js';
import { execute } from '../../dist/agent/loop.js';

const URL = 'https://dashboard.oxylabs.io';
const GOAL = `Click "Sign in with Google". On Google page, fill email with $SVC_EMAIL, click Next. Fill password with $SVC_PASSWORD, click Next. If passkey prompt, click "Try another way" then "Enter your password". Wait 5 seconds after login. Read any traffic or balance data. done(value=<data>). Do NOT navigate().`;

if (!process.env.OXYLABS_EMAIL) { console.log('SKIP — set OXYLABS_EMAIL'); process.exit(0); }
process.env.SVC_EMAIL = process.env.OXYLABS_EMAIL;
process.env.SVC_PASSWORD = process.env.OXYLABS_PASSWORD;

const s = await WSession.start({ label: 'oxylabs_balance', proxy: process.env.PROXY_URL || undefined });
try {
  await s.goto(URL);
  const result = await execute(s, `Open ${URL}. ${GOAL}`, {
    envHints: { SVC_EMAIL: process.env.SVC_EMAIL, SVC_PASSWORD: '***' },
    flowName: 'oxylabs_balance',
  });
  console.log('PASS:', result.value);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
