// 2Captcha registration through its native form, which takes an invisible
// reCAPTCHA instead of the Google sign-in button. The address is the session's
// generated identity (the domain rotator's mailbox), the reCAPTCHA sitekey is
// the one the form itself declares, and CapSolver solves it; its token is
// pushed back to the run once the task is solved (apiSolve). The registration counts once
// 2Captcha leaves the registration page; the credentials are then kept in
// Skarbiec.
import { exitStatusFor } from '../../../dist/cli/usage.js';
import { WSession } from '../../../dist/session/wsession.js';
import { registrationPassword } from '../../../dist/utils/identity/password.js';
import { apiSolve } from '../../../dist/captcha/providers/api.js';
import { writeServiceCredentials } from '../_shared/skarbiec/accounts.mjs';
import { pageSettled } from '../_shared/page/settled.mjs';

const REGISTER_URL = 'https://2captcha.com/auth/register';
const CAPSOLVER_API = 'https://api.capsolver.com';

/** The reCAPTCHA sitekey the registration form declares. */
async function formSitekey(page) {
  const sitekey = await page
    .locator('[data-sitekey]')
    .first()
    .getAttribute('data-sitekey');
  if (!sitekey)
    throw new Error(
      `TWOCAPTCHA_SITEKEY_UNREAD: the form at ${page.url()} declares no reCAPTCHA sitekey`,
    );
  return sitekey;
}

async function solveInvisibleRecaptcha(sitekey) {
  const key = process.env.CAPSOLVER_API_KEY;
  if (!key)
    throw new Error('twocaptcha_register: CAPSOLVER_API_KEY is not configured');
  return apiSolve(CAPSOLVER_API, key, {
    type: 'ReCaptchaV2TaskProxyLess',
    websiteURL: REGISTER_URL,
    websiteKey: sitekey,
    isInvisible: true,
  });
}

const s = await WSession.start({
  label: 'twocaptcha_register',
  browser: 'chromium',
  platform: 'twocaptcha',
});
try {
  const { email } = s.identity;
  const password = registrationPassword();
  console.log(`[trajectory] registering: ${email}`);
  await s.goto(REGISTER_URL);
  await pageSettled(s.page);
  await s.page.locator('input[name="email"]').fill(email);
  await s.page.locator('input[name="password"]').fill(password);
  await s.page.locator('input[name="agreement"]').check({ force: true });

  const token = await solveInvisibleRecaptcha(await formSitekey(s.page));
  await s.page.evaluate((t) => {
    for (const field of document.querySelectorAll(
      'textarea[name="g-recaptcha-response"]',
    ))
      field.value = t;
    if (typeof window.onRecaptchaSubmit === 'function')
      window.onRecaptchaSubmit(t);
  }, token);
  console.log('[trajectory] reCAPTCHA token injected');

  await s.page.locator('button:has-text("Create account")').click();
  await pageSettled(s.page);
  console.log(`[trajectory] post-register url=${s.page.url()}`);
  if (/\/register/.test(s.page.url())) {
    const body = await s.page.evaluate(() => document.body.innerText);
    throw new Error(
      `TWOCAPTCHA_REGISTER_REFUSED: still on /register. Body: ${body.replace(/\n/g, ' | ')}`,
    );
  }

  const item = writeServiceCredentials('2Captcha', {
    username: email,
    password,
  });
  console.log(`PASS: registered ${email}; credentials persisted to ${item}`);
} catch (error) {
  console.log(`FAIL: ${error.message}`);
  process.exitCode = exitStatusFor(error);
} finally {
  await s.close();
}
