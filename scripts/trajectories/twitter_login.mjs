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
try {
  await s.goto(URL);

  // Happy path: drive the two-step login form directly via Playwright
  // selectors. x.com's modal is SPA flake for the vision agent — it keeps
  // observing a blank-ish loading state and burns iterations. Direct fills
  // on the known input names deliver us straight to the redirect.
  const usernameSel = 'input[autocomplete="username"], input[name="text"]';
  const passwordSel = 'input[autocomplete="current-password"], input[name="password"]';
  const nextBtnSel = '[data-testid="LoginForm_Login_Button"], button:has-text("Next")';
  const loginBtnSel = '[data-testid="LoginForm_Login_Button"], button:has-text("Log in")';

  await s.page.waitForSelector(usernameSel);
  await s.page.fill(usernameSel, process.env.SVC_EMAIL);
  await s.page.click(nextBtnSel);

  await s.page.waitForSelector(passwordSel);
  await s.page.fill(passwordSel, process.env.SVC_PASSWORD);
  await s.page.click(loginBtnSel);

  // Give the SPA a moment to redirect; success = URL lands on /home.
  try {
    await s.page.waitForURL(/x\.com\/(home|i\/flow\/login\/check)/);
  } catch { /* may still be on checkpoint/2FA */ }

  // If we're on /home, we're logged in. Otherwise hand off to the agent
  // to handle the remaining challenge (2FA, captcha, suspicious-login).
  if (/x\.com\/home/.test(s.page.url())) {
    console.log('PASS: logged in (direct path)');
  } else {
    const result = await execute(s, `Open ${URL}. Resolve the remaining login challenge (2FA / captcha / suspicious-login prompt) and land on the home feed. done(value="logged in") once x.com/home is loaded.`, {
      envHints: { SVC_EMAIL: process.env.SVC_EMAIL, SVC_PASSWORD: '***' },
      flowName: 'twitter_login',
      maxSteps: 20,
    });
    console.log('PASS:', result.value);
  }
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
