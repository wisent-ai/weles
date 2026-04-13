import { AsyncNewBrowser } from './dist/async_api.js';
import { execute } from './dist/agent/loop.js';

const GOAL = `Open https://dashboard.oxylabs.io. Click "Sign in with Google" to start Google SSO. On the Google login page, fill email with $OXYLABS_DASH_EMAIL, click Next. Fill password with $OXYLABS_DASH_PASSWORD, click Next. If passkey prompt appears, click "Try another way" then "Enter your password". After submitting password, wait 5 seconds for redirect. Once on the Oxylabs dashboard, read any traffic usage, balance, or spending data visible on the page. done(value=<whatever balance or usage data you see>). Do NOT use navigate(). If the first page after login shows traffic available, use that.`;

async function main() {
  process.env.OXYLABS_DASH_EMAIL = process.env.OXYLABS_EMAIL;
  process.env.OXYLABS_DASH_PASSWORD = process.env.OXYLABS_PASSWORD;

  const ctx = await AsyncNewBrowser({ os: 'macos', browser: 'chromium', headless: false });
  const page = ctx.pages()[0] || await ctx.newPage();

  try {
    await page.goto('https://dashboard.oxylabs.io', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    const result = await execute(page, GOAL, {
      envHints: { OXYLABS_DASH_EMAIL: process.env.OXYLABS_DASH_EMAIL, OXYLABS_DASH_PASSWORD: '***' },
    });
    console.log('Result:', result.value);
    process.exit(result.value ? 0 : 1);
  } finally {
    await ctx.close();
  }
}
main().catch(e => { console.error('Error:', e.message); process.exit(1); });
setTimeout(() => { console.log('TIMEOUT 5min'); process.exit(2); }, 300000);
