import { WSession } from '../../dist/session/wsession.js';
import { execute } from '../../dist/agent/loop.js';

const URL = 'https://www.reddit.com/register';
const GOAL = `generate_identity(platform="reddit"). Fill email with $REDDIT_NEW_EMAIL. Click Continue. If captcha, solve_captcha(sitekey="6LfirrMoAAAAAHZOipvza4kpp_VtTwLNuXVwURNQ"). check_email(email=$REDDIT_NEW_EMAIL,sender="reddit") for code. Fill code. Set username $REDDIT_NEW_USERNAME and password $REDDIT_NEW_PASSWORD. After registration if onboarding questions appear, immediately done(value=$REDDIT_NEW_USERNAME).`;

const s = await WSession.start({ label: 'reddit_register', proxy: process.env.PROXY_URL || 'residential' });
try {
  await s.goto(URL);
  const result = await execute(s, `Open ${URL}. ${GOAL}`, { flowName: 'reddit_register' });
  console.log('PASS:', result.value);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
