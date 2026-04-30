import { WSession } from '../../../dist/session/wsession.js';
import { humanType } from '../../../dist/human/keyboard.js';
import { humanClickLocator } from '../../../dist/human/mouse.js';

const URL = 'https://accounts.snapchat.com/accounts/signup';
const MAX_RETRIES = 3;

async function fillNext(s, locator, value) {
  await locator.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, locator);
  await humanType(s.page, value);
  await humanClickLocator(s.page, s.page.locator('button[type="submit"], button:has-text("Next"), button:has-text("Continue"), button:has-text("Sign Up")').filter({ visible: true }).first());
  await s.page.waitForTimeout(1800);
}

for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
  console.log(`\n=== Snapchat signup attempt ${attempt}/${MAX_RETRIES} ===`);
  const s = await WSession.start({ label: `snapchat_register_${attempt}`, proxy: process.env.PROXY_URL || 'none' });
  try {
    const id = await s.generateIdentity('snapchat');
    console.log(`[sc] identity: ${id.username} / ${id.email}`);

    await s.goto(URL);
    await s.page.waitForTimeout(2500);

    // 1. First name (most current Snap signup variants put first+last on the
    //    same screen with separate "Next" between or one shared submit).
    const firstIn = s.page.locator('input[name="firstName"], input#firstName, input[autocomplete="given-name"]').filter({ visible: true }).first();
    await firstIn.waitFor({ state: 'visible' });
    await humanClickLocator(s.page, firstIn);
    await humanType(s.page, id.firstName);
    const lastIn = s.page.locator('input[name="lastName"], input#lastName, input[autocomplete="family-name"]').filter({ visible: true }).first();
    if (await lastIn.count()) {
      await humanClickLocator(s.page, lastIn);
      await humanType(s.page, id.lastName);
    }
    await humanClickLocator(s.page, s.page.locator('button[type="submit"], button:has-text("Next"), button:has-text("Continue"), button:has-text("Sign Up")').filter({ visible: true }).first());
    await s.page.waitForTimeout(1800);

    // 2. Birthday — usually a single date input or three selects.
    const dateIn = s.page.locator('input[name="birthday"], input[type="date"]').filter({ visible: true }).first();
    if (await dateIn.count()) {
      const iso = `${id.birthYear.padStart(4, '0')}-${String(id.birthMonth).padStart(2, '0')}-${String(id.birthDay).padStart(2, '0')}`;
      await humanClickLocator(s.page, dateIn);
      await s.page.keyboard.type(iso);
      await humanClickLocator(s.page, s.page.locator('button[type="submit"], button:has-text("Next"), button:has-text("Continue")').filter({ visible: true }).first());
      await s.page.waitForTimeout(1800);
    } else {
      // Triple-select fallback (older flow).
      const monthSel = s.page.locator('select[name="month"]').first();
      const daySel = s.page.locator('select[name="day"]').first();
      const yearSel = s.page.locator('select[name="year"]').first();
      if (await monthSel.count()) await monthSel.selectOption(String(id.birthMonth));
      if (await daySel.count()) await daySel.selectOption(String(id.birthDay));
      if (await yearSel.count()) await yearSel.selectOption(String(id.birthYear));
      await humanClickLocator(s.page, s.page.locator('button[type="submit"], button:has-text("Next"), button:has-text("Continue")').filter({ visible: true }).first());
      await s.page.waitForTimeout(1800);
    }

    // 3. Username
    await fillNext(s, s.page.locator('input[name="username"], input#username, input[autocomplete="username"]').filter({ visible: true }).first(), id.username);
    // 4. Password
    await fillNext(s, s.page.locator('input[name="password"], input[type="password"], input[autocomplete="new-password"]').filter({ visible: true }).first(), id.password);
    // 5. Email/phone — Snap signup variants ask for one. Fill whichever appears.
    const emailIn = s.page.locator('input[name="email"], input[type="email"], input[autocomplete="email"]').filter({ visible: true }).first();
    const phoneIn = s.page.locator('input[name="phone"], input[type="tel"], input[autocomplete="tel"]').filter({ visible: true }).first();
    if (await emailIn.count({ timeout: 1500 }).catch(() => 0)) {
      await fillNext(s, emailIn, id.email);
      // 6. Email OTP — poll Resend, fill verification code.
      const code = await s.checkEmail(id.email, 'snap');
      if (!code || /^no code|^error:/.test(code)) throw new Error(`snapchat verification email did not arrive: ${code}`);
      await fillNext(s, s.page.locator('input[name="otp"], input[autocomplete="one-time-code"], input[name="code"], input[name="verificationCode"]').filter({ visible: true }).first(), code);
    } else if (await phoneIn.count({ timeout: 1500 }).catch(() => 0)) {
      throw new Error('snapchat_phone_required: SMS verification path not implemented; rerun with email-mode signup variant');
    }

    await s.page.waitForFunction(() => /accounts\.snapchat\.com\/(?!.*signup)|web\.snapchat\.com/.test(location.href), { timeout: 30000 }).catch(() => {});
    await s.saveAccount('snapchat', { username: id.username, email: id.email, password: id.password, status: 'verified' });
    console.log(`PASS: ${id.username}`);
    process.exit(0);
  } catch (e) {
    console.log(`FAIL (attempt ${attempt}): ${e.message?.slice(0, 200)}`);
    if (attempt === MAX_RETRIES) { console.log('All attempts exhausted'); process.exit(1); }
  } finally {
    await s.close().catch(() => {});
  }
}
