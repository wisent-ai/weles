import { AsyncNewBrowser } from '../dist/async_api.js';
import { execute } from '../dist/agent/loop.js';
import { writeFileSync } from 'node:fs';

const SSO = `Click "Sign in with Google". On Google page, fill email with $SVC_EMAIL, click Next. Fill password with $SVC_PASSWORD, click Next. If passkey prompt, click "Try another way" then "Enter your password". Wait 5 seconds after login.`;
const LOGIN = `Fill username/email with $SVC_EMAIL and password with $SVC_PASSWORD. Click Log In or Sign In. Wait for redirect.`;
const REG_DISCORD = `generate_identity(platform="discord"). Fill Email with $DISCORD_NEW_EMAIL. Fill "Display Name" with $DISCORD_NEW_USERNAME. Fill Username with $DISCORD_NEW_USERNAME. Fill Password with $DISCORD_NEW_PASSWORD. For Date of Birth use select_option(target="month",value="January"), select_option(target="day",value="1"), select_option(target="year",value="1995"). Click "Create Account". If captcha, solve_captcha(sitekey="auto"). If email verification, check_email(email=$DISCORD_NEW_EMAIL,sender="discord"). done(value=$DISCORD_NEW_USERNAME).`;
const REG_REDDIT = `generate_identity(platform="reddit"). Fill email with $REDDIT_NEW_EMAIL. Click Continue. If captcha, solve_captcha(sitekey="6LfirrMoAAAAAHZOipvza4kpp_VtTwLNuXVwURNQ"). check_email(email=$REDDIT_NEW_EMAIL,sender="reddit") for code. Fill code. Set username $REDDIT_NEW_USERNAME and password $REDDIT_NEW_PASSWORD. After registration if onboarding questions appear, immediately done(value=$REDDIT_NEW_USERNAME).`;
const REG_TWITTER = `generate_identity(platform="twitter"). Fill name with "Wisent User". Click Next. Fill email with $TWITTER_NEW_EMAIL. Click Next. For birthdate use select_option. Click Next. check_email(email=$TWITTER_NEW_EMAIL,sender="x.com") for code. Fill code. Set password $TWITTER_NEW_PASSWORD. done(value=$TWITTER_NEW_USERNAME).`;
const REG_TIKTOK = `generate_identity(platform="tiktok"). Click "Use phone or email". Click "Sign up with email". For birthday use select_option(target="month",value="January"), select_option(target="day",value="1"), select_option(target="year",value="1995"). Fill email with $TIKTOK_NEW_EMAIL. Fill password with $TIKTOK_NEW_PASSWORD. Click Next or Sign up. check_email(email=$TIKTOK_NEW_EMAIL,sender="tiktok") for code. Fill code. done(value=$TIKTOK_NEW_USERNAME).`;
const REG_INSTAGRAM = `generate_identity(platform="instagram"). Fill "Mobile Number or Email" with $INSTAGRAM_NEW_EMAIL. Fill "Full Name" with "Wisent User". Fill Username with $INSTAGRAM_NEW_USERNAME. Fill Password with $INSTAGRAM_NEW_PASSWORD. Click "Sign up". If birthday, select January 1 1995. done(value=$INSTAGRAM_NEW_USERNAME).`;

const TRAJECTORIES = [
  // --- REGISTRATION ---
  { name: 'reddit_register', url: 'https://www.reddit.com/register', goal: REG_REDDIT },
  { name: 'discord_register', url: 'https://discord.com/register', goal: REG_DISCORD, waitLoad: true },
  { name: 'twitter_register', url: 'https://x.com/i/flow/signup', goal: REG_TWITTER },
  { name: 'tiktok_register', url: 'https://www.tiktok.com/signup', goal: REG_TIKTOK },
  { name: 'instagram_register', url: 'https://www.instagram.com/accounts/emailsignup/', goal: REG_INSTAGRAM },

  // --- LOGIN ---
  { name: 'reddit_login', url: 'https://www.reddit.com/login', goal: `${LOGIN} done(value="logged in as "+read("what is my username")).`, emailEnv: 'REDDIT_EMAIL', passEnv: 'REDDIT_PASSWORD' },
  { name: 'discord_login', url: 'https://discord.com/login', goal: `${LOGIN} done(value="logged in").`, emailEnv: 'DISCORD_EMAIL', passEnv: 'DISCORD_PASSWORD', waitLoad: true },
  { name: 'twitter_login', url: 'https://x.com/login', goal: `${LOGIN} done(value="logged in").`, emailEnv: 'TWITTER_EMAIL', passEnv: 'TWITTER_PASSWORD' },
  { name: 'instagram_login', url: 'https://www.instagram.com/accounts/login/', goal: `${LOGIN} done(value="logged in").`, emailEnv: 'INSTAGRAM_EMAIL', passEnv: 'INSTAGRAM_PASSWORD' },
  { name: 'tiktok_login', url: 'https://www.tiktok.com/login', goal: `${LOGIN} done(value="logged in").`, emailEnv: 'TIKTOK_EMAIL', passEnv: 'TIKTOK_PASSWORD' },
  { name: 'github_login', url: 'https://github.com/login', goal: `${LOGIN} done(value="logged in").`, emailEnv: 'GITHUB_EMAIL', passEnv: 'GITHUB_PASSWORD' },

  // --- DASHBOARD BALANCE (Google SSO) ---
  { name: 'oxylabs_balance', url: 'https://dashboard.oxylabs.io', goal: `${SSO} Read any traffic or balance data. done(value=<data>). Do NOT navigate().`, emailEnv: 'OXYLABS_EMAIL', passEnv: 'OXYLABS_PASSWORD' },
  { name: 'brightdata_balance', url: 'https://brightdata.com/cp', goal: `${SSO} Read any balance or credit data. done(value=<data>). Do NOT navigate().`, emailEnv: 'OXYLABS_EMAIL', passEnv: 'OXYLABS_PASSWORD' },
  { name: 'anticaptcha_balance', url: 'https://anti-captcha.com/clients', goal: `${SSO} Read any balance data. done(value=<data>). Do NOT navigate().`, emailEnv: 'OXYLABS_EMAIL', passEnv: 'OXYLABS_PASSWORD' },
  { name: 'capmonster_balance', url: 'https://dash.capmonster.cloud', goal: `${SSO} Read any balance data. done(value=<data>). Do NOT navigate().`, emailEnv: 'OXYLABS_EMAIL', passEnv: 'OXYLABS_PASSWORD' },

  // --- SOCIAL ACTIONS ---
  { name: 'reddit_upvote', url: 'https://www.reddit.com/r/test/comments/1a2b3c/', goal: `${LOGIN} Navigate to https://www.reddit.com/r/test/. Find any post and click the upvote button. done(value="upvoted").`, emailEnv: 'REDDIT_EMAIL', passEnv: 'REDDIT_PASSWORD' },
  { name: 'instagram_follow', url: 'https://www.instagram.com/accounts/login/', goal: `${LOGIN} Navigate to https://www.instagram.com/wisent.ai/. Click "Follow". done(value="followed wisent.ai").`, emailEnv: 'INSTAGRAM_EMAIL', passEnv: 'INSTAGRAM_PASSWORD' },
  { name: 'twitter_follow', url: 'https://x.com/login', goal: `${LOGIN} Navigate to https://x.com/elonmusk. Click "Follow". done(value="followed @elonmusk").`, emailEnv: 'TWITTER_EMAIL', passEnv: 'TWITTER_PASSWORD' },
  { name: 'github_star', url: 'https://github.com/login', goal: `${LOGIN} Navigate to https://github.com/anthropics/claude-code. Click "Star". done(value="starred anthropics/claude-code").`, emailEnv: 'GITHUB_EMAIL', passEnv: 'GITHUB_PASSWORD' },
];

// Allow running specific trajectory: node scripts/run_all.mjs reddit_register
const filter = process.argv[2];

async function runOne(t) {
  console.log(`\n${'='.repeat(60)}\n[${t.name}] Starting...\n${'='.repeat(60)}`);
  if (t.emailEnv) {
    process.env.SVC_EMAIL = process.env[t.emailEnv] || '';
    process.env.SVC_PASSWORD = process.env[t.passEnv] || '';
    if (!process.env.SVC_EMAIL) {
      console.log(`[${t.name}] SKIP — no ${t.emailEnv} in env`);
      return { name: t.name, status: 'skip', reason: `missing ${t.emailEnv}` };
    }
  }
  let ctx;
  try {
    ctx = await AsyncNewBrowser({ os: 'macos', browser: 'chromium', headless: false });
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto(t.url, { waitUntil: t.waitLoad ? 'load' : 'domcontentloaded' });
    await page.waitForTimeout(t.waitLoad ? 5000 : 3000);
    const result = await execute(page, `Open ${t.url}. ${t.goal}`, {
      envHints: t.emailEnv ? { SVC_EMAIL: process.env.SVC_EMAIL, SVC_PASSWORD: '***' } : {},
    });
    console.log(`[${t.name}] PASS: ${JSON.stringify(result.value).slice(0, 200)}`);
    return { name: t.name, status: 'pass', value: result.value };
  } catch (e) {
    console.log(`[${t.name}] FAIL: ${e.message.slice(0, 200)}`);
    return { name: t.name, status: 'fail', error: e.message.slice(0, 500) };
  } finally {
    try { if (ctx) await ctx.close(); } catch {}
  }
}

async function main() {
  const toRun = filter ? TRAJECTORIES.filter(t => t.name === filter || t.name.includes(filter)) : TRAJECTORIES;
  if (toRun.length === 0) { console.log(`No trajectory matching "${filter}"`); process.exit(1); }
  const results = [];
  for (const t of toRun) { results.push(await runOne(t)); }
  console.log(`\n${'='.repeat(60)}\nSUMMARY\n${'='.repeat(60)}`);
  for (const r of results) {
    const icon = r.status === 'pass' ? 'PASS' : r.status === 'skip' ? 'SKIP' : 'FAIL';
    console.log(`  ${icon} ${r.name}${r.value ? ': ' + JSON.stringify(r.value).slice(0,100) : ''}${r.error ? ': ' + r.error.slice(0,100) : ''}${r.reason ? ': ' + r.reason : ''}`);
  }
  writeFileSync('recordings/trajectory_results.json', JSON.stringify(results, null, 2));
  const p = results.filter(r => r.status === 'pass').length;
  const f = results.filter(r => r.status === 'fail').length;
  const s = results.filter(r => r.status === 'skip').length;
  console.log(`\n${p} passed, ${f} failed, ${s} skipped out of ${results.length}`);
  process.exit(f > 0 ? 1 : 0);
}
main();
