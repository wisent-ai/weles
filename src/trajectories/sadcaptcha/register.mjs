// SadCaptcha registration. Creates an account with a generated password and
// persists it to Skarbiec.
import { randomBytes } from 'node:crypto';
import { WSession } from '../../../dist/session/wsession.js';
import { CaptchaSolver } from '../../../dist/captcha/solver.js';
import { registrationPassword } from '../../../dist/utils/identity/password.js';
import { humanIdlePause } from '../../../dist/human/mouse.js';
import { writeServiceCredentials } from '../_shared/skarbiec/accounts.mjs';

// SadCaptcha rejects gmail aliases; use a fresh wisentmedia.com mailbox instead.
const EMAIL = `svc.sad.${randomBytes(3).toString('hex')}@wisentmedia.com`;
const password = registrationPassword();

console.log(`[trajectory] registering: ${EMAIL}`);

const s = await WSession.start({ label: 'sadcaptcha_register', browser: 'chromium' });
try {
  await s.goto('https://www.sadcaptcha.com/register');
  await humanIdlePause('deliberate');
  await s.page.locator('input#username').click();
  await s.page.locator('input#username').pressSequentially(EMAIL);
  await s.page.locator('input#password1').click();
  await s.page.locator('input#password1').pressSequentially(password);
  await s.page.locator('input#password2').click();
  await s.page.locator('input#password2').pressSequentially(password);
  await s.page.locator('input#agreeToTerms').check();

  // Solve reCAPTCHA v2 (sitekey 6LdRfgQqAAAAAMmRfNPmuSunXUrrYxnrJLEhPrdV)
  const solver = new CaptchaSolver();
  const token = await solver.solveRecaptchaV2(s.page, '6LdRfgQqAAAAAMmRfNPmuSunXUrrYxnrJLEhPrdV');
  if (typeof token !== 'string') { console.log('FAIL: reCAPTCHA solve returned no token'); process.exit(1); }
  await s.page.evaluate((t) => {
    const ta = document.getElementById('g-recaptcha-response');
    if (ta) ta.value = t;
  }, token);
  console.log('[trajectory] reCAPTCHA token injected');

  await s.page.locator('input[type="submit"]').click();
  await humanIdlePause('long');
  console.log(`[trajectory] post-register url=${s.page.url()}`);

  if (/\/register/.test(s.page.url())) {
    const errText = await s.page.evaluate(() => document.body.innerText);
    console.log(`FAIL: still on /register. Body: ${errText.replace(/\n/g, ' | ')}`);
    process.exit(1);
  }

  const item = writeServiceCredentials('SadCaptcha', { username: EMAIL, password });
  console.log(`PASS: registered ${EMAIL}; credentials persisted to ${item}`);
} catch (e) {
  console.log('FAIL:', e.message);
  process.exit(1);
} finally {
  await s.close();
}
