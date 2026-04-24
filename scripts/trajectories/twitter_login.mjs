import { getSocialAccount, resolveAccountSession } from '../../dist/utils/credentials.js';
import { WSession } from '../../dist/session/wsession.js';
import { execute } from '../../dist/agent/loop.js';

const URL = 'https://x.com/i/flow/login';

const acct = await getSocialAccount('twitter');
if (!acct) { console.log('FAIL: no active twitter account in DB'); process.exit(1); }
process.env.SVC_EMAIL = acct.metadata.email ?? acct.username;
process.env.SVC_PASSWORD = acct.metadata.password ?? '';
console.log(`[trajectory] Using account: ${acct.username}`);

const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'twitter_login', proxy: proxyUrl, persona });

async function tryDirectPath() {
  // Drive the two-step login form directly via Playwright selectors. x.com's
  // modal is SPA flake for the vision agent — it keeps observing a blank-ish
  // loading state and burns iterations.
  const usernameSel = 'input[autocomplete="username"], input[name="text"]';
  const passwordSel = 'input[autocomplete="current-password"], input[name="password"]';
  const nextBtnSel = '[data-testid="LoginForm_Login_Button"], button:has-text("Next")';
  const loginBtnSel = '[data-testid="LoginForm_Login_Button"], button:has-text("Log in")';

  await s.page.waitForSelector(usernameSel);
  await s.screenshot('direct_username_visible').catch(() => {});
  await s.page.fill(usernameSel, process.env.SVC_EMAIL);
  await s.page.click(nextBtnSel);

  // After Next, Twitter EITHER shows password OR a "verify it's you" challenge
  // (enter phone/username to confirm). Race the two: whichever appears first
  // decides our next action. If neither, we bail and hand off to the agent.
  const passwordLocator = s.page.locator(passwordSel).first();
  const challengeLocator = s.page.locator('input[data-testid="ocfEnterTextTextInput"]').first();
  const winner = await Promise.race([
    passwordLocator.waitFor({ state: 'visible' }).then(() => 'password').catch(() => null),
    challengeLocator.waitFor({ state: 'visible' }).then(() => 'challenge').catch(() => null),
  ]);

  if (winner === 'challenge') {
    await s.screenshot('direct_challenge_detected').catch(() => {});
    return 'agent-required';
  }

  await s.screenshot('direct_password_visible').catch(() => {});
  await s.page.fill(passwordSel, process.env.SVC_PASSWORD);
  await s.page.click(loginBtnSel);

  try { await s.page.waitForURL(/x\.com\/(home|i\/flow\/login\/check)/); } catch {}
  await s.screenshot('direct_after_submit').catch(() => {});
  return /x\.com\/home/.test(s.page.url()) ? 'ok' : 'agent-required';
}

try {
  await s.goto(URL);
  // Give the SPA modal ~3s to boot before probing selectors. We avoid
  // waitForLoadState('networkidle') because weles sets context navigation
  // timeout to 0 (async_api.ts:191) and x.com never reaches network idle
  // — the call would hang indefinitely.
  await new Promise((r) => setTimeout(r, 3000));

  let outcome = 'agent-required';
  try {
    outcome = await tryDirectPath();
  } catch (e) {
    console.log(`[trajectory] direct path errored: ${e.message?.slice(0, 200)}`);
    await s.screenshot('direct_errored').catch(() => {});
  }

  if (outcome === 'ok') {
    console.log('PASS: logged in (direct path)');
  } else {
    const result = await execute(s, `You are on x.com login flow. Username/email is $SVC_EMAIL, password is $SVC_PASSWORD. If you see a username/email input, fill it and click Next. If you see a "confirm it's you" challenge asking for phone/email/username, fill it with $SVC_EMAIL and click Next. If you see a password input, fill it with $SVC_PASSWORD and click Log in. If you see a 2FA/verification-code prompt, use check_email to retrieve the code and submit it. done(value="logged in") once x.com/home is loaded.`, {
      envHints: { SVC_EMAIL: process.env.SVC_EMAIL, SVC_PASSWORD: '***' },
      flowName: 'twitter_login',
      maxSteps: 25,
    });
    console.log('PASS:', result.value);
  }
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
