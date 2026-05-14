// Facebook account signup. Creates a fresh Facebook account at /r.php so the
// cross_login flow can inject Facebook cookies for `Continue with Facebook`
// SSO into tiktok / instagram / producthunt.
//
// Form fields (verified 2026-05-02 by .work/login-modes/captures/facebook_signup.json):
//   First name + Surname (split across two text inputs)
//   Day / Month / Year selects (DOB)
//   Gender select
//   Mobile-or-email single text input
//   Password
// Verification: email code sent via Resend (wisentmedia.com receiving).
// Some IPs trigger a phone-SMS gate instead — JuicySMS handles that branch.

import { WSession } from '../../../dist/session/wsession.js';
import { humanType } from '../../../dist/human/keyboard.js';
import { humanClickLocator, humanIdlePause } from '../../../dist/human/mouse.js';

const URL = 'https://www.facebook.com/r.php';
const MAX_RETRIES = 3;
const sleep = (sec) => new Promise(r => setTimeout(r, sec * 1000));  // allow-raw-playwright: utility sleep shim — usages should migrate to humanIdlePause

async function signup(s) {
  const id = await s.generateIdentity('facebook');
  console.log(`[fb] identity: ${id.username} <${id.email}>`);

  await s.goto(URL);
  await humanIdlePause('deliberate');

  // Some locales prompt a cookie consent banner before the form is interactable.
  const cookieBtn = s.page.locator('button:has-text("Allow all cookies"), button:has-text("Accept all"), button[data-testid="cookie-policy-manage-dialog-accept-button"]').filter({ visible: true }).first();
  if (await cookieBtn.isVisible().catch(() => false)) {
    await humanClickLocator(s.page, cookieBtn);
    await humanIdlePause('deliberate');
  }

  // 1. First name + Surname.
  const firstIn = s.page.locator('input[name="firstname"], input[aria-label*="First name" i]').filter({ visible: true }).first();
  await firstIn.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, firstIn);
  await humanType(s.page, id.firstName);

  const lastIn = s.page.locator('input[name="lastname"], input[aria-label*="Surname" i], input[aria-label*="Last name" i]').filter({ visible: true }).first();
  await humanClickLocator(s.page, lastIn);
  await humanType(s.page, id.lastName);

  // 2. DOB selects.
  const daySel   = s.page.locator('select#day,   select[name="birthday_day"]').first();
  const monthSel = s.page.locator('select#month, select[name="birthday_month"]').first();
  const yearSel  = s.page.locator('select#year,  select[name="birthday_year"]').first();
  if (await daySel.count())   await daySel.selectOption(String(id.birthDay)).catch(() => {});
  if (await monthSel.count()) await monthSel.selectOption(String(id.birthMonth)).catch(() => {});
  if (await yearSel.count())  await yearSel.selectOption(String(id.birthYear)).catch(() => {});

  // 3. Gender — Facebook uses radio inputs (1=Female, 2=Male, -1=Custom). Pick
  // Custom to avoid a pronoun-pick redirect, then leave the optional pronoun.
  const customRadio = s.page.locator('input[type="radio"][name="sex"][value="-1"], input#u_0_d, label:has-text("Custom") input[type="radio"]').first();
  if (await customRadio.count()) {
    await humanClickLocator(s.page, customRadio);
    await humanIdlePause('short');
  } else {
    const femaleRadio = s.page.locator('input[type="radio"][name="sex"][value="1"]').first();
    if (await femaleRadio.count()) await humanClickLocator(s.page, femaleRadio);
  }

  // 4. Mobile-or-email.
  const contactIn = s.page.locator('input[name="reg_email__"], input[aria-label*="Mobile number or email" i], input[aria-label*="Email" i]').filter({ visible: true }).first();
  await humanClickLocator(s.page, contactIn);
  await humanType(s.page, id.email);
  // Facebook re-prompts for confirmation when the field looks email-shaped.
  const confirmIn = s.page.locator('input[name="reg_email_confirmation__"]').filter({ visible: true }).first();
  if (await confirmIn.count()) {
    await humanClickLocator(s.page, confirmIn);
    await humanType(s.page, id.email);
  }

  // 5. Password.
  const pwIn = s.page.locator('input[name="reg_passwd__"], input[type="password"]').filter({ visible: true }).first();
  await humanClickLocator(s.page, pwIn);
  await humanType(s.page, id.password);

  // 6. Submit.
  const submit = s.page.locator('button[name="websubmit"], button:has-text("Sign Up"), button:has-text("Sign up")').filter({ visible: true }).first();
  await humanClickLocator(s.page, submit);
  await humanIdlePause('long');

  // 7. Verification — email OTP by default; some IPs trigger a phone-SMS
  // gate instead. Detect which branch we landed on and run the matching code.
  const phoneGate = await s.page.locator('input[type="tel"], input[name="phone_number"]').filter({ visible: true }).first().isVisible().catch(() => false);
  if (phoneGate) {
    const phone = await s.checkSms('facebook', 'US');
    if (phone.startsWith('error')) throw new Error(`fb_phone_gate_no_sms: ${phone}`);
    const digits = s.resolveEnv('$FACEBOOK_NEW_PHONE').replace(/^\+\d{1,2}/, '').replace(/\D/g, '');
    const phoneIn = s.page.locator('input[type="tel"], input[name="phone_number"]').filter({ visible: true }).first();
    await humanClickLocator(s.page, phoneIn);
    await humanType(s.page, digits);
    await humanClickLocator(s.page, s.page.locator('button:has-text("Continue"), button[type="submit"]').filter({ visible: true }).first());
    await humanIdlePause('deliberate');
    const smsCode = await s.pollSmsCode();
    if (!smsCode || /^no code|^error/i.test(smsCode)) throw new Error(`fb_sms_otp_failed: ${smsCode}`);
    const smsIn = s.page.locator('input[name="code"], input[autocomplete="one-time-code"], input[type="tel"][maxlength]').filter({ visible: true }).first();
    if (await smsIn.count()) {
      await humanClickLocator(s.page, smsIn);
      await humanType(s.page, smsCode);
      await humanClickLocator(s.page, s.page.locator('button:has-text("Continue"), button:has-text("Confirm"), button[type="submit"]').filter({ visible: true }).first());
      await humanIdlePause('long');
    }
  } else {
    const emailCode = await s.checkEmail(id.email, 'facebook');
    if (!emailCode || /^no code|^error/i.test(emailCode)) throw new Error(`fb_email_otp_failed: ${emailCode}`);
    const codeIn = s.page.locator('input[name="code"], input[name="confirmation_code"], input[aria-label*="confirmation" i]').filter({ visible: true }).first();
    if (await codeIn.count()) {
      await humanClickLocator(s.page, codeIn);
      await humanType(s.page, emailCode);
      await humanClickLocator(s.page, s.page.locator('button:has-text("Continue"), button:has-text("Confirm"), button[type="submit"]').filter({ visible: true }).first());
      await humanIdlePause('long');
    }
  }

  // 8. Land on facebook.com home (or /home.php / /?ref=...) on success.
  const finalUrl = s.page.url?.() ?? '';
  if (!/facebook\.com\/(home|\?|$)/.test(finalUrl) && !/facebook\.com\/$/.test(finalUrl) && !/messenger\.com/.test(finalUrl)) {
    // Many flows show a "save your login info" interstitial — wait for the
    // post-interstitial settle.
    await humanIdlePause('deliberate');
    const settled = s.page.url?.() ?? '';
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

for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
  console.log(`\n=== Facebook signup attempt ${attempt}/${MAX_RETRIES} ===`);
  const s = await WSession.start({ label: `facebook_register_${attempt}`, proxy: process.env.PROXY_URL || 'none' });
  try {
    const username = await signup(s);
    console.log(`PASS: ${username}`);
    await s.close();
    process.exit(0);
  } catch (e) {
    console.log(`FAIL (attempt ${attempt}): ${e.message?.slice(0, 200)}`);
    await s.close().catch(() => {});
    if (attempt === MAX_RETRIES) { console.log('All attempts exhausted'); process.exit(1); }
    await sleep(3);
  }
}
