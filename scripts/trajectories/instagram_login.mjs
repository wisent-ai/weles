import { WSession } from '../../dist/session/wsession.js';
import { execute } from '../../dist/agent/loop.js';

const URL = 'https://www.instagram.com/accounts/login/';
const GOAL = `fill(target="username",value=$SVC_EMAIL). fill(target="password",value=$SVC_PASSWORD). js_click(selector="button[type='submit']",text="Log in"). Wait 5 seconds. If email verification code required, check_email(email=$SVC_EMAIL,sender="instagram") for code, fill the code, click Confirm. If error "incorrect", give_up(reason="invalid credentials"). done(value="logged in").`;

if (!process.env.INSTAGRAM_EMAIL) { console.log('SKIP — set INSTAGRAM_EMAIL'); process.exit(0); }
process.env.SVC_EMAIL = process.env.INSTAGRAM_EMAIL;
process.env.SVC_PASSWORD = process.env.INSTAGRAM_PASSWORD;

const s = await WSession.start({ label: 'instagram_login', proxy: process.env.PROXY_URL || undefined });
try {
  await s.goto(URL);
  const result = await execute(s, `Open ${URL}. ${GOAL}`, {
    envHints: { SVC_EMAIL: process.env.SVC_EMAIL, SVC_PASSWORD: '***' },
    flowName: 'instagram_login',
  });
  console.log('PASS:', result.value);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
