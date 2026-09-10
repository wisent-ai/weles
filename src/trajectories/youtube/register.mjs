import { WSession } from '../../../dist/session/wsession.js';
import { humanType } from '../../../dist/human/keyboard.js';
import { humanClickLocator, humanIdlePause } from '../../../dist/human/mouse.js';
import { autoBindCharacter } from '../lib/character-bind.mjs';
import { assertAuthed, AuthProbeError } from '../_shared/auth-probe.mjs';

const URL = 'https://accounts.google.com/signup?continue=https%3A%2F%2Fwww.youtube.com%2F&flowName=GlifWebSignIn&flowEntry=SignUp';
const MAX_RETRIES = 3;

async function clickNext(s) {
  await humanClickLocator(
    s.page,
    s.page.locator('button:has-text("Next"), button[jsname]:has-text("Next"), #personalDetailsNext button, #birthdaygenderNext button, #createpasswordNext button, button[type="submit"]:has-text("Next")').filter({ visible: true }).first(),
  );
  await humanIdlePause('deliberate');
}

for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
  console.log(`\n=== YouTube/Google signup attempt ${attempt}/${MAX_RETRIES} ===`);
  const s = await WSession.start({ label: `youtube_register_${attempt}`, proxy: process.env.PROXY_URL || 'none' });
  try {
    const id = await s.generateIdentity('youtube');
    console.log(`[yt] identity: ${id.username} / ${id.email}`);

    await s.goto(URL);
    await humanIdlePause('deliberate');

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
      await humanIdlePause('short');
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
      await humanIdlePause('deliberate');
    } else {
      // Google requires phone verification on automation IPs. Walk the
      // SMS-verify flow via JuicySMS (service='google', SID=1; same provider
      // used by twitter/instagram/apple registers). Country preference: US
      // first, then UK.
      const phoneIn = s.page.locator('input[type="tel"], input[name="phoneNumber"], input[name="phoneNumberId"]').filter({ visible: true }).first();
      if (await phoneIn.count()) {
        let phone = await s.checkSms('google', 'US');
        if (phone.startsWith('error')) {
          console.log(`[yt] US SMS unavailable (${phone.slice(0, 80)}) — trying UK`);
          phone = await s.checkSms('google', 'UK');
          if (phone.startsWith('error')) throw new Error(`youtube_sms_unavailable: ${phone.slice(0, 120)}`);
        }
        const phoneNum = s.resolveEnv('$GOOGLE_NEW_PHONE');
        const digits = phoneNum.replace(/^\+\d{1,2}/, '').replace(/\D/g, '');
        console.log(`[yt] phone reserved: ${phoneNum}`);

        await humanClickLocator(s.page, phoneIn);
        await humanType(s.page, digits);
        await clickNext(s);

        const code = await s.pollSmsCode();
        if (!code || /^no code|^error/i.test(code)) throw new Error(`youtube_sms_otp_failed: ${code}`);
        console.log(`[yt] SMS code received: ${code}`);

        const codeIn = s.page.locator('input[type="tel"], input[name="code"], input[autocomplete="one-time-code"], input[id*="code" i]').filter({ visible: true }).first();
        await codeIn.waitFor({ state: 'visible' });
        await humanClickLocator(s.page, codeIn);
        await humanType(s.page, code);
        await clickNext(s);
      }
    }

    // 7. Terms / I agree.
    const agree = s.page.locator('button:has-text("I agree"), button:has-text("Accept"), button:has-text("Agree")').filter({ visible: true }).first();
    if (await agree.isVisible({ timeout: 6000 }).catch(() => false)) {
      await humanClickLocator(s.page, agree);
      await humanIdlePause('deliberate');
    }

    await s.page.waitForFunction(() => /youtube\.com|myaccount\.google\.com/.test(location.href), { timeout: 30000 });
    // Defense-in-depth: confirm the Google→YouTube OAuth actually
    // authed before persisting the row. PH register hit this same class
    // — a logged-out _producthunt_session_production cookie got
    // accepted as proof of auth and saveAccount persisted a row claiming
    // someone else's identity (vinitra incident, weles 21e21eb).
    try {
      await s.page.goto('https://www.youtube.com/');
      await humanIdlePause('deliberate');
      await assertAuthed('youtube', s, { label: 'youtube_register_post_oauth' });
    } catch (probeErr) {
      if (probeErr instanceof AuthProbeError) {
        throw new Error(`oauth_did_not_authenticate: ${probeErr.message?.slice(0, 200)}`);
      }
      throw probeErr;
    }

    await s.saveAccount('youtube', { username: id.username, email: id.email, password: id.password, status: 'verified' });
    await autoBindCharacter(id.username, 'youtube').then(r => console.log(`[bind] ${JSON.stringify(r)}`)).catch((e) => console.log(`[bind] err: ${e.message?.slice(0, 80)}`));
    console.log(`PASS: ${id.username}`);
    process.exit(0);
  } catch (e) {
    console.log(`FAIL (attempt ${attempt}): ${e.message?.slice(0, 200)}`);
    if (attempt === MAX_RETRIES) { console.log('All attempts exhausted'); process.exit(1); }
  } finally {
    await s.close().catch(() => {});
  }
}
