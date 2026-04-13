import { AsyncNewBrowser } from '../dist/async_api.js';
import { execute } from '../dist/agent/loop.js';
import { writeFileSync } from 'node:fs';

const TRAJECTORIES = [
  // Dashboard balance — Google SSO
  { name: 'oxylabs_balance', url: 'https://dashboard.oxylabs.io', goal: `Click "Sign in with Google" to start Google SSO. On the Google login page, fill email with $SVC_EMAIL, click Next. Fill password with $SVC_PASSWORD, click Next. If passkey prompt appears, click "Try another way" then "Enter your password". After login wait 5 seconds. Read any traffic usage or balance data visible. done(value=<data>). Do NOT use navigate().`, emailEnv: 'OXYLABS_EMAIL', passEnv: 'OXYLABS_PASSWORD' },
  { name: 'brightdata_balance', url: 'https://brightdata.com/cp', goal: `Click "Sign in with Google" to start Google SSO. On the Google login page, fill email with $SVC_EMAIL, click Next. Fill password with $SVC_PASSWORD, click Next. If passkey prompt appears, click "Try another way" then "Enter your password". After login wait 5 seconds. Read any balance or credit data visible. done(value=<data>). Do NOT use navigate().`, emailEnv: 'OXYLABS_EMAIL', passEnv: 'OXYLABS_PASSWORD' },
  { name: 'anticaptcha_balance', url: 'https://anti-captcha.com/clients', goal: `Click "Sign in with Google" to start Google SSO. On the Google login page, fill email with $SVC_EMAIL, click Next. Fill password with $SVC_PASSWORD, click Next. If passkey prompt appears, click "Try another way" then "Enter your password". After login wait 5 seconds. Read any balance data visible. done(value=<data>). Do NOT use navigate().`, emailEnv: 'OXYLABS_EMAIL', passEnv: 'OXYLABS_PASSWORD' },
  { name: 'capmonster_balance', url: 'https://dash.capmonster.cloud', goal: `Click "Sign in with Google" to start Google SSO. On the Google login page, fill email with $SVC_EMAIL, click Next. Fill password with $SVC_PASSWORD, click Next. If passkey prompt appears, click "Try another way" then "Enter your password". After login wait 5 seconds. Read any balance data visible. done(value=<data>). Do NOT use navigate().`, emailEnv: 'OXYLABS_EMAIL', passEnv: 'OXYLABS_PASSWORD' },

  // Dashboard balance — email/password login
  { name: 'packetstream_balance', url: 'https://app.packetstream.io', goal: `Fill email/username with $SVC_EMAIL and password with $SVC_PASSWORD in the login form. Click Log In or Sign In. Wait for dashboard to load. Read any balance or credit data visible. done(value=<data>).`, emailEnv: 'PACKETSTREAM_EMAIL', passEnv: 'PACKETSTREAM_PASSWORD' },

  // Reddit login
  { name: 'reddit_login', url: 'https://www.reddit.com/login', goal: `Fill username with $SVC_EMAIL and password with $SVC_PASSWORD. Click Log In. Wait for redirect. Read the page to confirm login succeeded. done(value="logged in as <username>").`, emailEnv: 'REDDIT_EMAIL', passEnv: 'REDDIT_PASSWORD' },

  // Reddit register
  { name: 'reddit_register', url: 'https://www.reddit.com/register', goal: `generate_identity(platform="reddit"). Fill email field with $REDDIT_NEW_EMAIL. Click Continue. If captcha appears, solve_captcha(sitekey="6LfirrMoAAAAAHZOipvza4kpp_VtTwLNuXVwURNQ"). check_email(email=$REDDIT_NEW_EMAIL) for verification code. Fill verification code. Choose username and password. done(value=<new username>).` },

  // Instagram login
  { name: 'instagram_login', url: 'https://www.instagram.com/accounts/login/', goal: `Fill username with $SVC_EMAIL and password with $SVC_PASSWORD. Click Log In. Wait for redirect. done(value="logged in").`, emailEnv: 'INSTAGRAM_EMAIL', passEnv: 'INSTAGRAM_PASSWORD' },

  // Discord login
  { name: 'discord_login', url: 'https://discord.com/login', goal: `Fill email with $SVC_EMAIL and password with $SVC_PASSWORD. Click Log In. Wait for redirect. done(value="logged in").`, emailEnv: 'DISCORD_EMAIL', passEnv: 'DISCORD_PASSWORD' },
];

async function runOne(t) {
  console.log(`\n${'='.repeat(60)}\n[${t.name}] Starting...\n${'='.repeat(60)}`);
  process.env.SVC_EMAIL = process.env[t.emailEnv] || '';
  process.env.SVC_PASSWORD = process.env[t.passEnv] || '';

  if (t.emailEnv && !process.env.SVC_EMAIL) {
    console.log(`[${t.name}] SKIP — no ${t.emailEnv} in env`);
    return { name: t.name, status: 'skip', reason: `missing ${t.emailEnv}` };
  }

  let ctx;
  try {
    ctx = await AsyncNewBrowser({ os: 'macos', browser: 'chromium', headless: false });
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto(t.url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    const fullGoal = `Open ${t.url}. ${t.goal}`;
    const result = await execute(page, fullGoal, {
      envHints: { SVC_EMAIL: process.env.SVC_EMAIL || '(not set)', SVC_PASSWORD: '***' },
    });
    console.log(`[${t.name}] PASS: ${JSON.stringify(result.value).slice(0, 200)}`);
    return { name: t.name, status: 'pass', value: result.value };
  } catch (e) {
    console.log(`[${t.name}] FAIL: ${e.message.slice(0, 200)}`);
    return { name: t.name, status: 'fail', error: e.message.slice(0, 500) };
  } finally {
    try { if (ctx) await ctx.close(); } catch { /* skip */ }
  }
}

async function main() {
  const results = [];
  for (const t of TRAJECTORIES) {
    const r = await runOne(t);
    results.push(r);
  }

  console.log(`\n${'='.repeat(60)}\nSUMMARY\n${'='.repeat(60)}`);
  for (const r of results) {
    const icon = r.status === 'pass' ? 'PASS' : r.status === 'skip' ? 'SKIP' : 'FAIL';
    console.log(`  ${icon} ${r.name}${r.value ? ': ' + JSON.stringify(r.value).slice(0, 100) : ''}${r.error ? ': ' + r.error.slice(0, 100) : ''}${r.reason ? ': ' + r.reason : ''}`);
  }

  writeFileSync('recordings/trajectory_results.json', JSON.stringify(results, null, 2));
  const passed = results.filter(r => r.status === 'pass').length;
  const failed = results.filter(r => r.status === 'fail').length;
  const skipped = results.filter(r => r.status === 'skip').length;
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped out of ${results.length}`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
