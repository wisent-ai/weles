import { WSession } from '../../dist/session/wsession.js';
import { execute } from '../../dist/agent/loop.js';

const URL = 'https://www.linkedin.com/signup';
const GOAL = `generate_identity(platform="linkedin"). Fill email with $LINKEDIN_NEW_EMAIL. Click "Agree & Join". Fill password with $LINKEDIN_NEW_PASSWORD. Click "Agree & Join". Fill "first-name" with $LINKEDIN_NEW_FIRSTNAME. Fill "last-name" with $LINKEDIN_NEW_LASTNAME. Click "Continue". If captcha, solve_captcha(). If email verification, check_email(email=$LINKEDIN_NEW_EMAIL,sender="linkedin") for code, fill the code, click Submit. save_account(platform="linkedin",username=$LINKEDIN_NEW_USERNAME,email=$LINKEDIN_NEW_EMAIL,password=$LINKEDIN_NEW_PASSWORD,name=$LINKEDIN_NEW_FIRSTNAME+" "+$LINKEDIN_NEW_LASTNAME). done(value=$LINKEDIN_NEW_USERNAME).`;

const s = await WSession.start({ label: 'linkedin_register', proxy: process.env.PROXY_URL || 'residential' });
try {
  await s.goto(URL);
  const result = await execute(s, `Open ${URL}. ${GOAL}`, { flowName: 'linkedin_register' });
  console.log('PASS:', result.value);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
