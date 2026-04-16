import { WSession } from '../../dist/session/wsession.js';
import { execute } from '../../dist/agent/loop.js';

const URL = 'https://www.instagram.com/accounts/emailsignup/';
const GOAL = `generate_identity(platform="instagram"). Fill "Mobile Number or Email" with $INSTAGRAM_NEW_EMAIL. Fill "Full Name" with $INSTAGRAM_NEW_FIRSTNAME. Fill Username with $INSTAGRAM_NEW_USERNAME. Fill Password with $INSTAGRAM_NEW_PASSWORD. Click "Sign up". If birthday, select $INSTAGRAM_NEW_BIRTHMONTH $INSTAGRAM_NEW_BIRTHDAY $INSTAGRAM_NEW_BIRTHYEAR. done(value=$INSTAGRAM_NEW_USERNAME).`;

const s = await WSession.start({ label: 'instagram_register', proxy: process.env.PROXY_URL || 'residential' });
try {
  await s.goto(URL);
  const result = await execute(s, `Open ${URL}. ${GOAL}`, { flowName: 'instagram_register' });
  console.log('PASS:', result.value);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
