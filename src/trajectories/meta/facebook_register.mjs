// Facebook account signup. Creates a fresh Facebook account at /r.php so the
// cross_login flow can inject Facebook cookies for `Continue with Facebook`
// SSO into tiktok / instagram / producthunt.
//
// Form fields:
//   First name + Surname (split across two text inputs)
//   Day / Month / Year selects (DOB)
//   Gender select
//   Mobile-or-email single text input
//   Password
// Verification: the email code Facebook sends, read from Skrzynka
// (_shared/inputs/mailed_code.mjs).
// Some IPs trigger a phone-SMS gate instead — JuicySMS handles that branch.

import { WSession } from '../../../dist/session/wsession.js';
import { humanType } from '../../../dist/human/keyboard.js';
import { humanClickLocator } from '../../../dist/human/mouse.js';
import { pageSettled } from '../_shared/page/settled.mjs';
import { statedProxy } from '../_shared/inputs/stated.mjs';
import { phoneForField } from '../_shared/inputs/phone.mjs';
import { fieldCodeLength, mailedCode } from '../_shared/inputs/mailed_code.mjs';

const SIGNUP_URL = 'https://www.facebook.com/r.php';

async function signup(s) {
  const id = await s.generateIdentity('facebook');
  console.log(`[fb] identity: ${id.username} <${id.email}>`);

  await s.goto(SIGNUP_URL);
  await pageSettled(s.page);

  // Some locales prompt a cookie consent banner Meta marks with its test id.
  const cookieBtn = s.page
    .locator('button[data-testid="cookie-policy-manage-dialog-accept-button"]')
    .filter({ visible: true })
    .first();
  if (await cookieBtn.isVisible()) {
    await humanClickLocator(s.page, cookieBtn);
    await pageSettled(s.page);
  }

  // 1. First name + Surname.
  const firstIn = s.page
    .locator('input[name="firstname"], input[aria-label*="First name" i]')
    .filter({ visible: true })
    .first();
  await firstIn.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, firstIn);
  await humanType(s.page, id.firstName);

  const lastIn = s.page
    .locator(
      'input[name="lastname"], input[aria-label*="Surname" i], input[aria-label*="Last name" i]',
    )
    .filter({ visible: true })
    .first();
  await humanClickLocator(s.page, lastIn);
  await humanType(s.page, id.lastName);

  // 2. DOB selects.
  const daySel = s.page
    .locator('select#day,   select[name="birthday_day"]')
    .first();
  const monthSel = s.page
    .locator('select#month, select[name="birthday_month"]')
    .first();
  const yearSel = s.page
    .locator('select#year,  select[name="birthday_year"]')
    .first();
  if (await daySel.count()) await daySel.selectOption(String(id.birthDay));
  // Facebook's month options show short names ("Jan"); the identity carries
  // the full one, so the option is the one whose name begins it.
  if (await monthSel.count()) {
    const month = await monthSel.evaluate(
      (select, name) =>
        [...select.options].find(
          (option) =>
            option.value && name.startsWith(option.textContent.trim()),
        )?.value,
      String(id.birthMonth),
    );
    if (!month)
      throw new Error(
        `FACEBOOK_MONTH_ABSENT: the month select offers no option for ${id.birthMonth}`,
      );
    await monthSel.selectOption(month);
  }
  if (await yearSel.count()) await yearSel.selectOption(String(id.birthYear));

  // 3. Gender — Facebook uses radio inputs (1=Female, 2=Male, -1=Custom). Pick
  // Custom to avoid a pronoun-pick redirect, then leave the optional pronoun.
  const customRadio = s.page
    .locator(
      'input[type="radio"][name="sex"][value="-1"], input#u_0_d, label:has-text("Custom") input[type="radio"]',
    )
    .first();
  if (await customRadio.count()) {
    await humanClickLocator(s.page, customRadio);
    await pageSettled(s.page);
  } else {
    const femaleRadio = s.page
      .locator('input[type="radio"][name="sex"][value="1"]')
      .first();
    if (await femaleRadio.count()) await humanClickLocator(s.page, femaleRadio);
  }

  // 4. Mobile-or-email.
  const contactIn = s.page
    .locator(
      'input[name="reg_email__"], input[aria-label*="Mobile number or email" i], input[aria-label*="Email" i]',
    )
    .filter({ visible: true })
    .first();
  await humanClickLocator(s.page, contactIn);
  await humanType(s.page, id.email);
  // Facebook re-prompts for confirmation when the field looks email-shaped.
  const confirmIn = s.page
    .locator('input[name="reg_email_confirmation__"]')
    .filter({ visible: true })
    .first();
  if (await confirmIn.count()) {
    await humanClickLocator(s.page, confirmIn);
    await humanType(s.page, id.email);
  }

  // 5. Password.
  const pwIn = s.page
    .locator('input[name="reg_passwd__"], input[type="password"]')
    .filter({ visible: true })
    .first();
  await humanClickLocator(s.page, pwIn);
  await humanType(s.page, id.password);

  // 6. Submit through Facebook's named sign-up button.
  const submit = s.page
    .locator('button[name="websubmit"], button[type="submit"]')
    .filter({ visible: true })
    .first();
  await humanClickLocator(s.page, submit);
  await pageSettled(s.page);

  // 7. Verification — email OTP by default; some IPs trigger a phone-SMS
  // gate instead. Detect which branch we landed on and run the matching code.
  const phoneIn = s.page
    .locator('input[type="tel"], input[name="phone_number"]')
    .filter({ visible: true })
    .first();
  if (await phoneIn.isVisible()) {
    // The number is rented in the country the phone field is set to
    // (../_shared/inputs/phone.mjs).
    const digits = await phoneForField(s, s.page, 'facebook');
    await humanClickLocator(s.page, phoneIn);
    await humanType(s.page, digits);
    await phoneIn.press('Enter');
    await pageSettled(s.page);
    const smsCode = await s.textedCode();
    const smsIn = s.page
      .locator(
        'input[name="code"], input[autocomplete="one-time-code"], input[type="tel"][maxlength]',
      )
      .filter({ visible: true })
      .first();
    if (await smsIn.count()) {
      await humanClickLocator(s.page, smsIn);
      await humanType(s.page, smsCode);
      await smsIn.press('Enter');
      await pageSettled(s.page);
    }
  } else {
    const codeIn = s.page
      .locator(
        'input[name="code"], input[name="confirmation_code"], input[aria-label*="confirmation" i]',
      )
      .filter({ visible: true })
      .first();
    await codeIn.waitFor({ state: 'visible' });
    // The confirmation field states how many digits the mailed code has.
    const emailCode = await mailedCode(
      id.email,
      'facebook',
      await fieldCodeLength(codeIn),
    );
    await humanClickLocator(s.page, codeIn);
    await humanType(s.page, emailCode);
    await codeIn.press('Enter');
    await pageSettled(s.page);
  }

  // 8. Land on facebook.com home (or /home.php / /?ref=...) on success.
  const finalUrl = s.page.url();
  if (
    !/facebook\.com\/(home|\?|$)/.test(finalUrl) &&
    !/facebook\.com\/$/.test(finalUrl) &&
    !/messenger\.com/.test(finalUrl)
  ) {
    // Many flows show a "save your login info" interstitial: the landing is
    // read once the page has settled past it.
    await pageSettled(s.page);
    const settled = s.page.url();
    if (!/facebook\.com/.test(settled)) {
      throw new Error(`facebook_register_no_landing: ${settled}`);
    }
  }

  await s.saveAccount('facebook', {
    username: id.username,
    email: id.email,
    password: id.password,
    name: `${id.firstName} ${id.lastName}`,
    status: 'verified',
  });
  return id.username;
}

const s = await WSession.start({
  label: 'facebook_register',
  proxy: statedProxy('the Facebook signup'),
});
try {
  console.log(`PASS: ${await signup(s)}`);
} finally {
  await s.close();
}
