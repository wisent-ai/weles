// Linear login probe via Google Workspace SSO (Wisent org uses Workspace).
//
// Resolves the exact Linear Workspace login through its scoped Skarbiec grant.
//
// Drives linear.app/login → "Continue with Google" → Google OAuth →
// Workspace landing. Exits 0 on a Linear-workspace URL, 1 otherwise.
//
// Run: node scripts/trajectories/linear/login.mjs
import { readScopedLogin } from '../../_shared/scoped-secrets.mjs';
import { WSession } from '../../../dist/session/wsession.js';
import { humanIdlePause, humanClickLocator } from '../../../dist/human/mouse.js';
import { humanFill } from '../../../dist/human/keyboard.js';

const LOGIN_URL = 'https://linear.app/login';
const SUCCESS_URL_RE = /linear\.app\/[^/]+\/(team|my|issues|inbox|settings)/;
const DISPLAY_NAME = 'Linear';

async function resolveCreds() {
  return { ...readScopedLogin('linearDashboard'), source: 'skarbiec' };
}

const creds = await resolveCreds();
if (!creds) {
  throw new Error('scoped Linear credentials are unavailable');
}
console.log(`[linear-login] credentials from ${creds.source}: ${creds.email}`);

const s = await WSession.start({ label: 'linear_login', browser: 'chromium' });
try {
  await s.goto(LOGIN_URL);
  await humanIdlePause('deliberate');

  // If already logged in, Linear redirects /login → workspace home.
  if (SUCCESS_URL_RE.test(s.page.url())) {
    console.log(`PASS: already logged in, landed on ${s.page.url()}`);
    process.exit(0);
  }

  const googleBtn = s.page.getByRole('button', { name: /continue with google/i })
    .or(s.page.getByRole('link', { name: /continue with google/i }));
  if (!(await googleBtn.first().isVisible().catch(() => false))) {
    console.log('FAIL: Continue with Google button not visible');
    process.exit(1);
  }
  await humanClickLocator(s.page, googleBtn.first(), { timeoutMs: 15000 });
  await humanIdlePause('long');

  // Google email step. The popup may inherit the prior workspace SSO cookie
  // and skip straight to consent — handle both.
  const emailInput = s.page.locator('input[type="email"]').first();
  if (await emailInput.isVisible().catch(() => false)) {
    await humanFill(s.page, emailInput, creds.email);
    await s.page.keyboard.press('Enter');
    await humanIdlePause('long');
  }

  // Password step (Workspace SSO; passkey path mirrors slack/create_app.mjs).
  async function fillPasswordWhenAvailable() {
    const pwd = s.page.locator('input[type="password"]');
    if (await pwd.count() === 0) return false;
    await humanFill(s.page, pwd, creds.password);
    await s.page.keyboard.press('Enter');
    await humanIdlePause('long');
    return true;
  }
  if (!(await fillPasswordWhenAvailable())) {
    const tryOther = s.page.getByRole('button', { name: /try another way/i })
      .or(s.page.getByRole('link', { name: /try another way/i }));
    if (await tryOther.count() > 0) {
      await humanClickLocator(s.page, tryOther.first(), { timeoutMs: 10000 });
      await humanIdlePause('long');
      const enterPwd = s.page.getByText(/enter your password/i).first();
      if (await enterPwd.count() > 0) {
        await humanClickLocator(s.page, enterPwd, { timeoutMs: 10000 });
        await humanIdlePause('long');
        await fillPasswordWhenAvailable();
      }
    }
  }

  const continueBtn = s.page.getByRole('button', { name: /^\s*continue\s*$/i });
  if (await continueBtn.count() > 0) {
    await humanClickLocator(s.page, continueBtn.first(), { timeoutMs: 10000 });
    await humanIdlePause('long');
  }

  // Wait up to 30s for navigation to a Linear-workspace URL.
  for (let i = 0; i < 30; i++) {
    await humanIdlePause('short');
    const u = s.page.url();
    if (SUCCESS_URL_RE.test(u)) { console.log(`PASS: landed on ${u}`); process.exit(0); }
  }
  console.log(`FAIL: not on a Linear workspace url after 30s. url=${s.page.url()}`);
  process.exit(1);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
