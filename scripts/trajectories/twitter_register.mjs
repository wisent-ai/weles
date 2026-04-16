import { WSession } from '../../dist/session/wsession.js';
import { execute } from '../../dist/agent/loop.js';

const URL = 'https://x.com/i/flow/signup';
const GOAL = `generate_identity(platform="twitter"). Click "Create account". If cookie consent banner appears, click "Refuse non-essential cookies". Fill Name with "$TWITTER_NEW_FIRSTNAME $TWITTER_NEW_LASTNAME". Try clicking "Use email instead". If email field is visible, fill Email with $TWITTER_NEW_EMAIL. If phone field is shown instead, check_sms(service="twitter",country="UK") then fill Phone with $TWITTER_NEW_PHONE. For date of birth use select_option(target="Month",value=$TWITTER_NEW_BIRTHMONTH), select_option(target="Day",value=$TWITTER_NEW_BIRTHDAY), select_option(target="Year",value=$TWITTER_NEW_BIRTHYEAR). Click "Next" up to 3 times. If "Authenticate" button or captcha appears, click "Authenticate" then solve_captcha(sitekey="auto") to solve the Arkose/FunCaptcha. If email verification page appears, check_email(email=$TWITTER_NEW_EMAIL,sender="x.com") for code, fill the code, click Next. If phone verification page appears, poll_sms_code() to get code, fill the code, click Next. Fill Password with $TWITTER_NEW_PASSWORD. Click "Next". Skip onboarding by clicking "Skip for now" or "Not now" repeatedly. save_account(platform="twitter",username=$TWITTER_NEW_USERNAME,email=$TWITTER_NEW_EMAIL,password=$TWITTER_NEW_PASSWORD). done(value=$TWITTER_NEW_USERNAME).`;

const MAX_RETRIES = 5;
const proxy = process.env.PROXY_URL || 'residential';

for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
  console.log(`\n=== Twitter signup attempt ${attempt}/${MAX_RETRIES} ===`);
  const s = await WSession.start({ label: `twitter_register_${attempt}`, proxy });
  try {
    await s.goto(URL);
    await s.wait(5);
    const result = await execute(s, `Open ${URL}. ${GOAL}`, { maxSteps: 40 });
    console.log('PASS:', result.value);
    await s.close();
    process.exit(0);
  } catch (e) {
    console.log(`FAIL (attempt ${attempt}): ${e.message?.slice(0, 200)}`);
    await s.close().catch(() => {});
    if (attempt === MAX_RETRIES) { console.log('All attempts exhausted'); process.exit(1); }
    console.log('Retrying with fresh proxy IP...');
    await new Promise(r => setTimeout(r, 3000));
  }
}
