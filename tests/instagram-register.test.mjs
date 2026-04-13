import { AsyncNewBrowser } from '../dist/async_api.js';
import { execute } from '../dist/agent/loop.js';

const GOAL = `Create a new Instagram account. First, generate_identity(platform="instagram"). Fill "Mobile Number or Email" with $INSTAGRAM_NEW_EMAIL. Fill "Full Name" with "Wisent User". Fill "Username" with $INSTAGRAM_NEW_USERNAME. Fill "Password" with $INSTAGRAM_NEW_PASSWORD. Click "Sign up". If birthday prompt appears, select a date (e.g. January 1, 1995) and click Next. If verification code is needed, check_email(email=$INSTAGRAM_NEW_EMAIL, sender="instagram") and fill the code. After account is created, done(value=$INSTAGRAM_NEW_USERNAME).`;

async function main() {
  const ctx = await AsyncNewBrowser({ os: 'macos', browser: 'chromium', headless: false });
  const page = ctx.pages()[0] || await ctx.newPage();

  try {
    await page.goto('https://www.instagram.com/accounts/emailsignup/', { waitUntil: 'domcontentloaded' });
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
