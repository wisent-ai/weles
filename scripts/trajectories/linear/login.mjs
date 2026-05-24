// Linear login probe via Google Workspace SSO (Wisent org uses Workspace).
//
// Reads service_credentials row display_name='Linear' for login_email +
// login_password; if absent falls back to weles/.work/_sso.env (SSO_EMAIL,
// SSO_PASS) — same path as the slack trajectory.
//
// Drives linear.app/login → "Continue with Google" → Google OAuth →
// Workspace landing. Exits 0 on a Linear-workspace URL, 1 otherwise.
//
// Run: node scripts/trajectories/linear/login.mjs
import { getServiceLogin } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { humanIdlePause, humanClickLocator } from '../../../dist/human/mouse.js';
import { humanFill } from '../../../dist/human/keyboard.js';
import { readFileSync, existsSync } from 'node:fs';

const LOGIN_URL = 'https://linear.app/login';
const SUCCESS_URL_RE = /linear\.app\/[^/]+\/(team|my|issues|inbox|settings)/;
const DISPLAY_NAME = 'Linear';

// Resolve credentials: service_credentials first, then weles/.work/_sso.env.
async function resolveCreds() {
  const svc = await getServiceLogin(DISPLAY_NAME);
  if (svc?.email && svc?.password) return { email: svc.email, password: svc.password, source: 'service_credentials' };
  const ssoEnv = `${process.env.HOME}/Documents/CodingProjects/Wisent/weles/.work/_sso.env`;
  if (existsSync(ssoEnv)) {
    const txt = readFileSync(ssoEnv, 'utf8');
    const email = (txt.match(/^SSO_EMAIL=(.+)$/m) || [])[1];
    const pass = (txt.match(/^SSO_PASS=(.+)$/m) || [])[1];
    if (email && pass) return { email, password: pass, source: '_sso.env' };
  }
  return null;
}

const creds = await resolveCreds();
if (!creds) {
  console.log(`FAIL: no '${DISPLAY_NAME}' row in service_credentials and no weles/.work/_sso.env`);
  process.exit(1);
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
