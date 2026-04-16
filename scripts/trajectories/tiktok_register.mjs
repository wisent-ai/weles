import { WSession } from '../../dist/session/wsession.js';
import { execute } from '../../dist/agent/loop.js';

const URL = 'https://www.tiktok.com/signup';
const GOAL = `generate_identity(platform="tiktok"). Click "Use phone or email". Click "Sign up with email". For birthday use select_option(target="month",value=$TIKTOK_NEW_BIRTHMONTH), select_option(target="day",value=$TIKTOK_NEW_BIRTHDAY), select_option(target="year",value=$TIKTOK_NEW_BIRTHYEAR). Fill email with $TIKTOK_NEW_EMAIL. Fill password with $TIKTOK_NEW_PASSWORD. Click "Send code". check_email(email=$TIKTOK_NEW_EMAIL,sender="tiktok") for code. Fill code. Click Next. done(value=$TIKTOK_NEW_USERNAME).`;

const s = await WSession.start({ label: 'tiktok_register', proxy: process.env.PROXY_URL || 'residential' });
try {
  await s.goto(URL);
  const result = await execute(s, `Open ${URL}. ${GOAL}`, { flowName: 'tiktok_register' });
  console.log('PASS:', result.value);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
