import { AsyncNewBrowser } from '../dist/async_api.js';
import { execute } from '../dist/agent/loop.js';

const GOAL = `Create a new Reddit account. First, generate_identity(platform="reddit"). Then fill the email field with $REDDIT_NEW_EMAIL. Click Continue. If a captcha appears, solve_captcha(sitekey="6LfirrMoAAAAAHZOipvza4kpp_VtTwLNuXVwURNQ"). check_email(email=$REDDIT_NEW_EMAIL, sender="reddit") for verification code. Fill the verification code. Choose username $REDDIT_NEW_USERNAME and password $REDDIT_NEW_PASSWORD. Complete registration. After account is created, if you see onboarding questions (gender, interests, etc.), immediately done(value=$REDDIT_NEW_USERNAME). Do not waste time on onboarding.`;

async function main() {
  const ctx = await AsyncNewBrowser({ os: 'macos', browser: 'chromium', headless: false });
  const page = ctx.pages()[0] || await ctx.newPage();

  try {
    await page.goto('https://www.reddit.com/register', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    const result = await execute(page, GOAL, { envHints: {} });
    console.log('Result:', result.value);
    process.exit(result.value ? 0 : 1);
  } finally {
    await ctx.close();
  }
}
main().catch(e => { console.error('Error:', e.message); process.exit(1); });
setTimeout(() => { console.log('TIMEOUT 5min'); process.exit(2); }, 300000);
