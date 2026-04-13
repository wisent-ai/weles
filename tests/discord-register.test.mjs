import { AsyncNewBrowser } from '../dist/async_api.js';
import { execute } from '../dist/agent/loop.js';

const GOAL = `Create a new Discord account. First, generate_identity(platform="discord"). Fill "Email" with $DISCORD_NEW_EMAIL. Fill "Display name" with $DISCORD_NEW_USERNAME. Fill "Username" with $DISCORD_NEW_USERNAME. Fill "Password" with $DISCORD_NEW_PASSWORD. For Date of Birth, use select_option(target="month", value="January"), select_option(target="day", value="1"), select_option(target="year", value="1995"). Click "Create Account". If email verification is needed, check_email(email=$DISCORD_NEW_EMAIL, sender="discord") and fill or click the verification link. After account is created, done(value=$DISCORD_NEW_USERNAME).`;

async function main() {
  const ctx = await AsyncNewBrowser({ os: 'macos', browser: 'chromium', headless: false });
  const page = ctx.pages()[0] || await ctx.newPage();

  try {
    await page.goto('https://discord.com/register', { waitUntil: 'load' });
    await page.waitForTimeout(5000);

    const result = await execute(page, GOAL, { envHints: {} });
    console.log('Result:', result.value);
    process.exit(result.value ? 0 : 1);
  } finally {
    await ctx.close();
  }
}
main().catch(e => { console.error('Error:', e.message); process.exit(1); });
setTimeout(() => { console.log('TIMEOUT 5min'); process.exit(2); }, 300000);
