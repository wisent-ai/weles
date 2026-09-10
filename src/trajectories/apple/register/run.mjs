// Apple ID signup. Creates a fresh Apple ID at appleid.apple.com/account so
// the cross_login flow can inject Apple cookies into reddit/tiktok/twitter/
// linkedin/github/producthunt for `Sign in with Apple` SSO.
//
// Flow: country → name → DOB → email (own wisentmedia.com) → password+confirm
//   → phone (JuicySMS US) → email-OTP → phone-OTP → land on /manage
// Apple's signup form is rendered inside an iframe hosted at appleid.apple.com
// (same pattern as appstoreconnect.apple.com — see apple/login.mjs:25).
// Selectors target stable input ids/names rather than label text because the
// modal re-renders aggressively and labels are i18n-dependent.

import { WSession } from '../../../../dist/session/wsession.js';
import { humanType } from '../../../../dist/human/keyboard.js';
import { humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';

const URL = 'https://appleid.apple.com/account';
const MAX_RETRIES = 3;

for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
  console.log(`\n=== Apple ID signup attempt ${attempt}/${MAX_RETRIES} ===`);
  const s = await WSession.start({ label: `apple_register_${attempt}`, proxy: process.env.PROXY_URL || 'none' });
  try {
    const id = await s.generateIdentity('apple');
    console.log(`[apple] identity: ${id.username} <${id.email}> dob=${id.birthMonth}/${id.birthDay}/${id.birthYear}`);

    await s.goto(URL);
    await humanIdlePause('deliberate');

    // Resolve the signup frame — iframe-hosted on appleid.apple.com.
    const iframeHandle = await s.page.waitForSelector(
      'iframe[src*="appleid.apple.com"], iframe[name*="auth"], iframe[id*="auth"]'
    ).catch(() => null);
    const frame = iframeHandle ? await iframeHandle.contentFrame() : s.page.mainFrame();
    if (!frame) throw new Error('no_signup_frame');

    // 1. Country (Apple defaults to GeoIP — pin US for predictable downstream)
    const country = frame.locator('select[name="countryCode"], select[id*="country" i]').first();
    if (await country.count()) await country.selectOption('US').catch(() => {});

    // 2. First / Last name
    const firstIn = frame.locator('input[name="firstName"], input#firstName, input[autocomplete="given-name"]').first();
    await firstIn.waitFor({ state: 'visible' });
    await humanClickLocator(s.page, firstIn);
    await humanType(s.page, id.firstName);
    const lastIn = frame.locator('input[name="lastName"], input#lastName, input[autocomplete="family-name"]').first();
    if (await lastIn.count()) {
      await humanClickLocator(s.page, lastIn);
      await humanType(s.page, id.lastName);
    }

    // 3. DOB — selects in older variants, plain inputs in newer.
    const monthIn = frame.locator('select[name="birthMonth"], input[name="month"], input[id*="month" i]').first();
    const dayIn   = frame.locator('select[name="birthDay"],   input[name="day"],   input[id*="day" i]').first();
    const yearIn  = frame.locator('select[name="birthYear"],  input[name="year"],  input[id*="year" i]').first();
    if (await monthIn.count()) {
      const tag = await monthIn.evaluate(el => el.tagName).catch(() => '');
      if (tag === 'SELECT') {
        await monthIn.selectOption(String(id.birthMonth)).catch(() => {});
        if (await dayIn.count()) await dayIn.selectOption(String(id.birthDay)).catch(() => {});
        if (await yearIn.count()) await yearIn.selectOption(String(id.birthYear)).catch(() => {});
      } else {
        await humanClickLocator(s.page, monthIn); await humanType(s.page, String(id.birthMonth).padStart(2, '0'));
        if (await dayIn.count()) { await humanClickLocator(s.page, dayIn); await humanType(s.page, String(id.birthDay).padStart(2, '0')); }
        if (await yearIn.count()) { await humanClickLocator(s.page, yearIn); await humanType(s.page, String(id.birthYear)); }
      }
    }

    // 4. Apple ID email = wisentmedia.com address from generateIdentity
    const emailIn = frame.locator('input[name="appleId"], input[name="email"], input[type="email"], input[autocomplete="email"]').first();
    await emailIn.waitFor({ state: 'visible' });
    await humanClickLocator(s.page, emailIn);
    await humanType(s.page, id.email);

    // 5. Password + confirm
    const pwIn = frame.locator('input[name="password"], input[id="password"], input[type="password"][autocomplete="new-password"]').first();
    await pwIn.waitFor({ state: 'visible' });
    await humanClickLocator(s.page, pwIn);
    await humanType(s.page, id.password);
    const cfIn = frame.locator('input[name="confirmPassword"], input[id="confirmPassword"], input[type="password"][autocomplete="new-password"]').nth(1);
    if (await cfIn.count()) {
      await humanClickLocator(s.page, cfIn);
      await humanType(s.page, id.password);
    }

    // 6. Phone — Apple requires SMS verification. Use JuicySMS US scoped to apple.
    const phone = await s.checkSms('apple', 'US');
    if (phone.startsWith('error')) throw new Error(`apple_sms_unavailable: ${phone}`);
    const digits = s.resolveEnv('$APPLE_NEW_PHONE').replace(/^\+\d{1,2}/, '').replace(/\D/g, '');
    const phoneIn = frame.locator('input[name="phoneNumber"], input[type="tel"], input[autocomplete="tel"]').first();
    if (await phoneIn.count()) {
      await humanClickLocator(s.page, phoneIn);
      await humanType(s.page, digits);
    }

    // 7. Submit
    const submit = frame.locator('button[type="submit"], button:has-text("Continue"), button:has-text("Create"), button:has-text("Next")').filter({ visible: true }).first();
    await humanClickLocator(s.page, submit);
    await humanIdlePause('long');

    // 8. Email OTP
    const emailCode = await s.checkEmail(id.email, 'apple');
    if (!emailCode || /^no code|^error/i.test(emailCode)) throw new Error(`apple_email_otp_failed: ${emailCode}`);
    const emailCodeBoxes = await frame.locator('input[id*="email-verification" i], input[aria-label*="verification" i][type="tel"], input[aria-label*="digit" i]').all();
    if (emailCodeBoxes.length >= 6) {
      for (let i = 0; i < 6; i++) await emailCodeBoxes[i].fill(emailCode[i]).catch(() => {});
    } else if (emailCodeBoxes.length === 1) {
      await emailCodeBoxes[0].fill(emailCode);
    } else {
      throw new Error(`apple_email_otp_unexpected_inputs: count=${emailCodeBoxes.length}`);
    }
    await humanIdlePause('deliberate');

    // 9. Phone OTP
    const smsCode = await s.pollSmsCode();
    if (!smsCode || /^no code|^error/i.test(smsCode)) throw new Error(`apple_sms_otp_failed: ${smsCode}`);
    const smsBoxes = await frame.locator('input[id*="phone-verification" i], input[aria-label*="phone" i][type="tel"], input[aria-label*="digit" i]').all();
    if (smsBoxes.length >= 6) {
      for (let i = 0; i < 6; i++) await smsBoxes[i].fill(smsCode[i]).catch(() => {});
    } else if (smsBoxes.length === 1) {
      await smsBoxes[0].fill(smsCode);
    } else {
      throw new Error(`apple_sms_otp_unexpected_inputs: count=${smsBoxes.length}`);
    }
    await humanIdlePause('long');

    // 10. Land on appleid.apple.com/manage (or /account/done) on success.
    const finalUrl = s.page.url?.() ?? '';
    if (!/appleid\.apple\.com.*\/(manage|account)/.test(finalUrl) && !/idmsa\.apple\.com.*\/auth\/done/.test(finalUrl)) {
      await humanIdlePause('deliberate');
      const settled = s.page.url?.() ?? '';
      if (!/appleid\.apple\.com/.test(settled)) throw new Error(`apple_register_no_landing: ${settled}`);
    }

    await s.saveAccount('apple', {
      username: id.username,
      email: id.email,
      password: id.password,
      name: `${id.firstName} ${id.lastName}`,
      status: 'verified',
    });
    console.log(`PASS: apple ${id.email}`);
    process.exit(0);
  } catch (e) {
    console.log(`FAIL (attempt ${attempt}): ${e.message?.slice(0, 200)}`);
    await s.close().catch(() => {});
    if (attempt === MAX_RETRIES) { console.log('All attempts exhausted'); process.exit(1); }
    await humanIdlePause('deliberate');
  }
}
