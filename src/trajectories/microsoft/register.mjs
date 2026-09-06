// Microsoft account signup. Creates a new Outlook/Live account at
// signup.live.com so the cross_login flow can inject Microsoft cookies into
// linkedin for `Sign in with Microsoft` SSO.
//
// Flow: pick existing-email-or-new-outlook → fill email → password → name →
// country + DOB → captcha (Arkose enforced inline) → phone-OTP → land on
// account.microsoft.com.
//
// We always pick "Get a new email address" so the resulting handle matches
// the wisentmedia identity and we don't depend on an external email loop.

import { WSession } from '../../../dist/session/wsession.js';
import { humanType } from '../../../dist/human/keyboard.js';
import { humanClickLocator, humanIdlePause } from '../../../dist/human/mouse.js';

const URL = 'https://signup.live.com';
const MAX_RETRIES = 3;

for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
  console.log(`\n=== Microsoft signup attempt ${attempt}/${MAX_RETRIES} ===`);
  const s = await WSession.start({ label: `microsoft_register_${attempt}`, proxy: process.env.PROXY_URL || 'none' });
  try {
    const id = await s.generateIdentity('microsoft');
    console.log(`[ms] identity: ${id.username} <${id.username}@outlook.com>`);

    await s.goto(URL);
    await humanIdlePause('deliberate');

    // 1. The first step asks "Create account" — there's a prefix-suffix combo.
    // The default suffix is @outlook.com; we just type the local part.
    const memberIn = s.page.locator('input[name="MemberName"], input[name="MemberNameHandle"], input#MemberName').first();
    await memberIn.waitFor({ state: 'visible' });
    await humanClickLocator(s.page, memberIn);
    await humanType(s.page, id.username);
    await humanClickLocator(s.page, s.page.locator('input[type="submit"], button[type="submit"], button:has-text("Next")').filter({ visible: true }).first());
    await humanIdlePause('deliberate');

    // 2. Password
    const pwIn = s.page.locator('input[name="Password"], input[name="PasswordInput"], input[type="password"]').filter({ visible: true }).first();
    await pwIn.waitFor({ state: 'visible' });
    await humanClickLocator(s.page, pwIn);
    await humanType(s.page, id.password);
    await humanClickLocator(s.page, s.page.locator('input[type="submit"], button[type="submit"], button:has-text("Next")').filter({ visible: true }).first());
    await humanIdlePause('deliberate');

    // 3. Name (first / last)
    const firstIn = s.page.locator('input[name="FirstName"], input#firstName, input[autocomplete="given-name"]').filter({ visible: true }).first();
    if (await firstIn.count()) {
      await humanClickLocator(s.page, firstIn);
      await humanType(s.page, id.firstName);
      const lastIn = s.page.locator('input[name="LastName"], input#lastName, input[autocomplete="family-name"]').filter({ visible: true }).first();
      if (await lastIn.count()) {
        await humanClickLocator(s.page, lastIn);
        await humanType(s.page, id.lastName);
      }
      await humanClickLocator(s.page, s.page.locator('input[type="submit"], button[type="submit"], button:has-text("Next")').filter({ visible: true }).first());
      await humanIdlePause('deliberate');
    }

    // 4. Country + DOB
    const countrySel = s.page.locator('select#Country, select[name="Country"]').first();
    if (await countrySel.count()) await countrySel.selectOption('US').catch(() => {});
    const monthSel = s.page.locator('select#BirthMonth, select[name="BirthMonth"]').first();
    if (await monthSel.count()) await monthSel.selectOption(String(id.birthMonth));
    const daySel = s.page.locator('select#BirthDay, select[name="BirthDay"]').first();
    if (await daySel.count()) await daySel.selectOption(String(id.birthDay));
    const yearIn = s.page.locator('input#BirthYear, input[name="BirthYear"]').first();
    if (await yearIn.count()) {
      await humanClickLocator(s.page, yearIn);
      await humanType(s.page, String(id.birthYear));
    }
    await humanClickLocator(s.page, s.page.locator('input[type="submit"], button[type="submit"], button:has-text("Next")').filter({ visible: true }).first());
    await humanIdlePause('long');

    // 5. Arkose / "Press and Hold" captcha. Microsoft is moving from a
    // visual-puzzle Arkose to a per-puzzle "press and hold" challenge that
    // Capsolver can solve via funcaptcha solver (same pattern as github
    // /_funcaptcha.mjs). For now, surface a deterministic blocker so the
    // operator can plug in the solver path if needed.
    const arkose = await s.page.locator('iframe[src*="arkoselabs.com"], iframe[src*="enforcement.arkoselabs"], #enforcementFrame').first().isVisible().catch(() => false);
    if (arkose) {
      console.log('[ms] Arkose challenge detected — solver hookup needed (funcaptcha)');
      const solved = await s.solveCaptcha().catch(() => 'no-target-found');
      if (typeof solved === 'string' && solved.startsWith('error')) {
        throw new Error(`microsoft_arkose_unsolved: ${solved.slice(0, 120)}`);
      }
      await humanIdlePause('deliberate');
    }

    // 6. Phone verification
    const phone = await s.checkSms('microsoft', 'US');
    if (phone.startsWith('error')) throw new Error(`microsoft_sms_unavailable: ${phone}`);
    const digits = s.resolveEnv('$MICROSOFT_NEW_PHONE').replace(/^\+\d{1,2}/, '').replace(/\D/g, '');
    const phoneIn = s.page.locator('input[name="phoneNumber"], input[type="tel"], input#phoneNumber').filter({ visible: true }).first();
    if (await phoneIn.count()) {
      await humanClickLocator(s.page, phoneIn);
      await humanType(s.page, digits);
      await humanClickLocator(s.page, s.page.locator('input[type="submit"], button[type="submit"], button:has-text("Send code"), button:has-text("Next")').filter({ visible: true }).first());
      await humanIdlePause('deliberate');
    }
    const smsCode = await s.pollSmsCode();
    if (!smsCode || /^no code|^error/i.test(smsCode)) throw new Error(`microsoft_sms_otp_failed: ${smsCode}`);
    const codeIn = s.page.locator('input[name="otc"], input[name="VerificationCode"], input[type="tel"][maxlength], input[autocomplete="one-time-code"]').filter({ visible: true }).first();
    if (await codeIn.count()) {
      await humanClickLocator(s.page, codeIn);
      await humanType(s.page, smsCode);
      await humanClickLocator(s.page, s.page.locator('input[type="submit"], button[type="submit"], button:has-text("Next"), button:has-text("Verify")').filter({ visible: true }).first());
      await humanIdlePause('long');
    }

    // 7. Land on account.microsoft.com or login.live.com/oauth20.* on success.
    const finalUrl = s.page.url?.() ?? '';
    if (!/account\.microsoft\.com|login\.live\.com\/oauth20|outlook\.live\.com|signup\.live\.com\/welcome/i.test(finalUrl)) {
      await humanIdlePause('deliberate');
      const settled = s.page.url?.() ?? '';
      if (!/microsoft\.com|live\.com|outlook\.com/i.test(settled)) {
        throw new Error(`microsoft_register_no_landing: ${settled}`);
      }
    }

    const email = `${id.username}@outlook.com`;
    await s.saveAccount('microsoft', {
      username: id.username,
      email,
      password: id.password,
      name: `${id.firstName} ${id.lastName}`,
      status: 'verified',
    });
    console.log(`PASS: microsoft ${email}`);
    process.exit(0);
  } catch (e) {
    console.log(`FAIL (attempt ${attempt}): ${e.message?.slice(0, 200)}`);
    await s.close().catch(() => {});
    if (attempt === MAX_RETRIES) { console.log('All attempts exhausted'); process.exit(1); }
    await humanIdlePause('deliberate');
  }
}
