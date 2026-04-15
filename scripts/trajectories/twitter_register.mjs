import { WSession } from '../../dist/session/wsession.js';
import { execute } from '../../dist/agent/loop.js';

const URL = 'https://x.com/i/flow/signup';
const GOAL = `generate_identity(platform="twitter"). Fill name with "Wisent User". Click Next. Fill email with $TWITTER_NEW_EMAIL. Click Next. For birthdate use select_option. Click Next. check_email(email=$TWITTER_NEW_EMAIL,sender="x.com") for code. Fill code. Set password $TWITTER_NEW_PASSWORD. done(value=$TWITTER_NEW_USERNAME).`;

const s = await WSession.start({ label: 'twitter_register', proxy: process.env.PROXY_URL || 'residential' });
try {
  await s.goto(URL);
  const result = await execute(s, `Open ${URL}. ${GOAL}`, { flowName: 'twitter_register' });
  console.log('PASS:', result.value);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
