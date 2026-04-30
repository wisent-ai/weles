import { WSession } from '../../../dist/session/wsession.js';
import { humanType } from '../../../dist/human/keyboard.js';
import { humanClickLocator } from '../../../dist/human/mouse.js';

const URL = 'https://accounts.google.com/signup?continue=https%3A%2F%2Fwww.youtube.com%2F&flowName=GlifWebSignIn&flowEntry=SignUp';
const MAX_RETRIES = 3;

async function clickNext(s) {
  await humanClickLocator(
    s.page,
    s.page.locator('button:has-text("Next"), button[jsname]:has-text("Next"), #personalDetailsNext button, #birthdaygenderNext button, #createpasswordNext button, button[type="submit"]:has-text("Next")').filter({ visible: true }).first(),
  );
  await s.page.waitForTimeout(2500);
}

for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
  console.log(`\n=== YouTube/Google signup attempt ${attempt}/${MAX_RETRIES} ===`);
  const s = await WSession.start({ label: `youtube_register_${attempt}`, proxy: process.env.PROXY_URL || 'none' });
  try {
    const id = await s.generateIdentity('youtube');
    console.log(`[yt] identity: ${id.username} / ${id.email}`);

    await s.goto(URL);
    await s.page.waitForTimeout(3500);

    // 1. First/last name.
    const firstIn = s.page.locator('input[name="firstName"], input#firstName').filter({ visible: true }).first();
    await firstIn.waitFor({ state: 'visible' });
    await humanClickLocator(s.page, firstIn);
    await humanType(s.page, id.firstName);
    const lastIn = s.page.locator('input[name="lastName"], input#lastName').filter({ visible: true }).first();
    if (await lastIn.count()) {
      await humanClickLocator(s.page, lastIn);
      await humanType(s.page, id.lastName);
    }
    await clickNext(s);

    // 2. Birthday + gender.
    const monthSel = s.page.locator('select[id="month"], select[name="month"]').first();
    if (await monthSel.count()) await monthSel.selectOption(String(id.birthMonth));
    const dayIn = s.page.locator('input[name="day"], input[id="day"]').first();
    if (await dayIn.count()) {
      await humanClickLocator(s.page, dayIn);
      await humanType(s.page, String(id.birthDay));
    }
    const yearIn = s.page.locator('input[name="year"], input[id="year"]').first();
    if (await yearIn.count()) {
      await humanClickLocator(s.page, yearIn);
      await humanType(s.page, String(id.birthYear));
    }
    const genderSel = s.page.locator('select[id="gender"], select[name="gender"]').first();
    if (await genderSel.count()) {
      // Value 4 == "Rather not say" on Google's signup form (1=Female, 2=Male, 3=Custom, 4=Rather not say).
      await genderSel.selectOption('4').catch(() => genderSel.selectOption({ label: 'Rather not say' }).catch(() => {}));
    }
    await clickNext(s);

    // 3. Create-Gmail option (Google sometimes offers existing email vs new gmail).
    const createGmail = s.page.locator('div[role="radio"]:has-text("Create your own Gmail"), button:has-text("Create your own Gmail"), input[value="0"][type="radio"] + label, label:has-text("Create your own Gmail address")').filter({ visible: true }).first();
    if (await createGmail.isVisible({ timeout: 3000 }).catch(() => false)) {
      await humanClickLocator(s.page, createGmail);
      await s.page.waitForTimeout(1500);
    }

    // 4. Username (Gmail).
    const userIn = s.page.locator('input[name="Username"], input[name="username"], input[type="email"]').filter({ visible: true }).first();
    if (await userIn.count()) {
      await humanClickLocator(s.page, userIn);
      await humanType(s.page, id.username);
      await clickNext(s);
    }

    // 5. Password + confirm.
    const pwIn = s.page.locator('input[name="Passwd"], input[name="password"], input[type="password"]').filter({ visible: true }).first();
    await pwIn.waitFor({ state: 'visible', timeout: 15000 });
    await humanClickLocator(s.page, pwIn);
    await humanType(s.page, id.password);
    const cfIn = s.page.locator('input[name="ConfirmPasswd"], input[name="confirm-passwd"], input[name="passwd-again"]').filter({ visible: true }).first();
    if (await cfIn.count()) {
      await humanClickLocator(s.page, cfIn);
      await humanType(s.page, id.password);
    }
    await clickNext(s);

    // 6. Phone — try to skip if button available.
    const skip = s.page.locator('button:has-text("Skip"), button:has-text("Not now")').filter({ visible: true }).first();
    if (await skip.isVisible({ timeout: 4000 }).catch(() => false)) {
      await humanClickLocator(s.page, skip);
      await s.page.waitForTimeout(2500);
    } else {
      // No skip button — Google requires phone for this signup. Fail
      // deterministically so caller knows why.
      const phoneIn = s.page.locator('input[type="tel"], input[name="phoneNumber"], input[name="phoneNumberId"]').filter({ visible: true }).first();
      if (await phoneIn.count()) {
        throw new Error('youtube_phone_required: SMS verification path not implemented for Google signup');
      }
    }

    // 7. Terms / I agree.
    const agree = s.page.locator('button:has-text("I agree"), button:has-text("Accept"), button:has-text("Agree")').filter({ visible: true }).first();
    if (await agree.isVisible({ timeout: 6000 }).catch(() => false)) {
      await humanClickLocator(s.page, agree);
      await s.page.waitForTimeout(3500);
    }

    await s.page.waitForFunction(() => /youtube\.com|myaccount\.google\.com/.test(location.href), { timeout: 30000 });
    await s.saveAccount('youtube', { username: id.username, email: id.email, password: id.password, status: 'verified' });
    console.log(`PASS: ${id.username}`);
    process.exit(0);
  } catch (e) {
    console.log(`FAIL (attempt ${attempt}): ${e.message?.slice(0, 200)}`);
    if (attempt === MAX_RETRIES) { console.log('All attempts exhausted'); process.exit(1); }
  } finally {
    await s.close().catch(() => {});
  }
}
