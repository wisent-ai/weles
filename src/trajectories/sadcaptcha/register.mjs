// SadCaptcha registration. Creates an account with a generated password and
// persists it to Skarbiec.
import { randomUUID } from 'node:crypto';
import { WSession } from '../../../dist/session/wsession.js';
import { CaptchaSolver } from '../../../dist/captcha/solver.js';
import { registrationPassword } from '../../../dist/utils/identity/password.js';
import {
  markSignupSuccess,
  pickDomain,
} from '../../../dist/utils/email/domain.js';
import { pageSettled } from '../_shared/page/settled.mjs';
import { writeServiceCredentials } from '../_shared/skarbiec/accounts.mjs';

// SadCaptcha rejects gmail aliases, so the address is a fresh mailbox on an
// inbound domain Weles receives mail for (the recorded domains, or
// FORCE_EMAIL_DOMAIN / AGENT_EMAIL_DOMAINS / AGENT_DOMAIN); none is assumed.
const EMAIL = `svc.sad.${randomUUID()}@${await pickDomain('sadcaptcha')}`;
const password = registrationPassword();

console.log(`[trajectory] registering: ${EMAIL}`);

const s = await WSession.start({
  label: 'sadcaptcha_register',
  browser: 'chromium',
});
try {
  await s.goto('https://www.sadcaptcha.com/register');
  await pageSettled(s.page);
  await s.page.locator('input#username').click();
  await s.page.locator('input#username').pressSequentially(EMAIL);
  await s.page.locator('input#password1').click();
  await s.page.locator('input#password1').pressSequentially(password);
  await s.page.locator('input#password2').click();
  await s.page.locator('input#password2').pressSequentially(password);
  await s.page.locator('input#agreeToTerms').check();

  // Solve reCAPTCHA v2 (sitekey 6LdRfgQqAAAAAMmRfNPmuSunXUrrYxnrJLEhPrdV)
  const solver = new CaptchaSolver();
  const token = await solver.solveRecaptchaV2(
    s.page,
    '6LdRfgQqAAAAAMmRfNPmuSunXUrrYxnrJLEhPrdV',
  );
  if (typeof token !== 'string')
    throw new Error('reCAPTCHA solve returned no token');
  await s.page.evaluate((t) => {
    const ta = document.getElementById('g-recaptcha-response');
    if (ta) ta.value = t;
  }, token);
  console.log('[trajectory] reCAPTCHA token injected');

  await s.page.locator('input[type="submit"]').click();
  await pageSettled(s.page);
  console.log(`[trajectory] post-register url=${s.page.url()}`);

  if (/\/register/.test(s.page.url())) {
    const errText = await s.page.evaluate(() => document.body.innerText);
    throw new Error(
      `still on /register. Body: ${errText.replace(/\n/g, ' | ')}`,
    );
  }

  const item = writeServiceCredentials('SadCaptcha', {
    username: EMAIL,
    password,
  });
  await markSignupSuccess(EMAIL, 'sadcaptcha');
  console.log(`PASS: registered ${EMAIL}; credentials persisted to ${item}`);
} finally {
  // A failure is thrown on to the runner, which reports it and exits failed.
  await s.close();
}
