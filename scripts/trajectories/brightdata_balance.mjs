import { getServiceLogin } from '../../dist/utils/credentials.js';
import { WSession } from '../../dist/session/wsession.js';
import { execute } from '../../dist/agent/loop.js';

const URL = 'https://brightdata.com/cp';
const GOAL = `Click "Sign in with Google". On Google page, fill email with $SVC_EMAIL, click Next. Fill password with $SVC_PASSWORD, click Next. If passkey prompt, click "Try another way" then "Enter your password". Wait 5 seconds after login. Read any balance or credit data. done(value=<data>). Do NOT navigate().`;

const login = await getServiceLogin('Bright Data');
if (!login) { console.log('FAIL: no Bright Data credentials in DB'); process.exit(1); }
process.env.SVC_EMAIL = login.email;
process.env.SVC_PASSWORD = login.password;
console.log(`[trajectory] Using service login: ${login.email}`);

const s = await WSession.start({ label: 'brightdata_balance', proxy: process.env.PROXY_URL || undefined });
try {
  await s.goto(URL);
  const result = await execute(s, `Open ${URL}. ${GOAL}`, {
    envHints: { SVC_EMAIL: process.env.SVC_EMAIL, SVC_PASSWORD: '***' },
    flowName: 'brightdata_balance',
  });
  console.log('PASS:', result.value);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
