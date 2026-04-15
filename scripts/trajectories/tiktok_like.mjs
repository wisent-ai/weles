import { WSession } from '../../dist/session/wsession.js';
import { execute } from '../../dist/agent/loop.js';

const URL = 'https://www.tiktok.com/login/phone-or-email/email';
const GOAL = `Fill email with $SVC_EMAIL. Fill password with $SVC_PASSWORD. Click "Log in". Wait for redirect. Wait 5 seconds. Find any video and click the heart/like button. done(value="liked").`;

if (!process.env.TIKTOK_EMAIL) { console.log('SKIP — set TIKTOK_EMAIL'); process.exit(0); }
process.env.SVC_EMAIL = process.env.TIKTOK_EMAIL;
process.env.SVC_PASSWORD = process.env.TIKTOK_PASSWORD;

const s = await WSession.start({ label: 'tiktok_like', proxy: process.env.PROXY_URL || undefined });
try {
  await s.goto(URL);
  const result = await execute(s, `Open ${URL}. ${GOAL}`, {
    envHints: { SVC_EMAIL: process.env.SVC_EMAIL, SVC_PASSWORD: '***' },
    flowName: 'tiktok_like',
  });
  console.log('PASS:', result.value);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
