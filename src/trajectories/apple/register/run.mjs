// Apple ID signup. Creates a fresh Apple ID at appleid.apple.com/account so
// the cross_login flow can inject Apple cookies into reddit/tiktok/twitter/
// linkedin/github/producthunt for `Sign in with Apple` SSO.
//
// Flow: country → name → DOB → email (generateIdentity's inbound domain) → password+confirm
//   → phone (rented in the country Apple's phone field is set to) → email-OTP
//   → phone-OTP → land on /manage
// Apple's signup form is rendered inside an iframe hosted at appleid.apple.com
// (the same pattern as appstoreconnect.apple.com in apple/login.mjs).
// Selectors target stable input ids/names rather than label text because the
// modal re-renders aggressively and labels are i18n-dependent.

import { WSession } from '../../../../dist/session/wsession.js';
import { humanType } from '../../../../dist/human/keyboard.js';
import { humanClickLocator } from '../../../../dist/human/mouse.js';
import { pageSettled } from '../../_shared/page/settled.mjs';
import { statedProxy, statedText } from '../../_shared/inputs/stated.mjs';
import { phoneForField } from '../../_shared/inputs/phone.mjs';
import { mailedCode } from '../../_shared/inputs/mailed_code.mjs';

const SIGNUP_URL = 'https://appleid.apple.com/account';

/** `value` padded with zeros to the width the field's own maxlength states. */
async function toFieldWidth(field, value) {
  const width = await field.evaluate((el) => el.maxLength);
  return width > value.length ? value.padStart(width, '0') : value;
}

// Apple shows either one box for the whole code or one box per digit of the
// code it sent; the code's own length says how many boxes that is. A box that
// refuses its digit fails the signup with Playwright's error instead of being
// skipped, which left a code half typed and the run waiting on Apple.
async function fillCodeBoxes(boxes, code, refusal) {
  if (boxes.length === code.length) {
    for (const [index, digit] of [...code].entries())
      await boxes[index].fill(digit);
    return;
  }
  const [single, ...others] = boxes;
  if (single && !others.length) {
    await single.fill(code);
    return;
  }
  throw new Error(
    `${refusal}: count=${boxes.length}, code digits=${code.length}`,
  );
}

// One signup per run: a failure is reported with its cause, and whether to
// spend another identity on a second run is the caller's decision.
{
  const s = await WSession.start({
    label: 'apple_register',
    proxy: statedProxy('the Apple ID signup'),
  });
  try {
    const id = await s.generateIdentity('apple');
    console.log(
      `[apple] identity: ${id.username} <${id.email}> dob=${id.birthMonth}/${id.birthDay}/${id.birthYear}`,
    );

    await s.goto(SIGNUP_URL);

    // Resolve the signup frame — iframe-hosted on appleid.apple.com. Filling
    // the outer page instead fails much later on a field it does not hold,
    // with nothing saying the frame never appeared.
    const iframeHandle = await s.page.waitForSelector(
      'iframe[src*="appleid.apple.com"], iframe[name*="auth"], iframe[id*="auth"]',
    );
    const frame = await iframeHandle.contentFrame();
    if (!frame)
      throw new Error(
        `no_signup_frame: the appleid.apple.com frame on ${s.page.url()} has no content`,
      );

    // 1. Country: the one the run states (APPLE_ID_COUNTRY, as Apple's
    // country select values it), not the GeoIP default Apple preselects. A
    // select that refuses the value fails the run: an account registered in
    // another country is not the identity generated for it. The phone number
    // is then rented in that same country (phoneForField reads the select).
    const country = frame
      .locator('select[name="countryCode"], select[id*="country" i]')
      .first();
    if (await country.count())
      await country.selectOption(
        statedText(
          ['APPLE_ID_COUNTRY'],
          "the country the Apple ID is registered in, as Apple's country select values it",
        ),
      );

    // 2. First / Last name
    const firstIn = frame
      .locator(
        'input[name="firstName"], input#firstName, input[autocomplete="given-name"]',
      )
      .first();
    await firstIn.waitFor({ state: 'visible' });
    await humanClickLocator(s.page, firstIn);
    await humanType(s.page, id.firstName);
    const lastIn = frame
      .locator(
        'input[name="lastName"], input#lastName, input[autocomplete="family-name"]',
      )
      .first();
    if (await lastIn.count()) {
      await humanClickLocator(s.page, lastIn);
      await humanType(s.page, id.lastName);
    }

    // 3. DOB — selects in older variants, plain inputs in newer.
    const monthIn = frame
      .locator(
        'select[name="birthMonth"], input[name="month"], input[id*="month" i]',
      )
      .first();
    const dayIn = frame
      .locator(
        'select[name="birthDay"],   input[name="day"],   input[id*="day" i]',
      )
      .first();
    const yearIn = frame
      .locator(
        'select[name="birthYear"],  input[name="year"],  input[id*="year" i]',
      )
      .first();
    if (await monthIn.count()) {
      const tag = await monthIn.evaluate((el) => el.tagName);
      if (tag === 'SELECT') {
        await monthIn.selectOption(String(id.birthMonth));
        if (await dayIn.count()) await dayIn.selectOption(String(id.birthDay));
        if (await yearIn.count())
          await yearIn.selectOption(String(id.birthYear));
      } else {
        await humanClickLocator(s.page, monthIn);
        await humanType(
          s.page,
          await toFieldWidth(monthIn, String(id.birthMonth)),
        );
        if (await dayIn.count()) {
          await humanClickLocator(s.page, dayIn);
          await humanType(
            s.page,
            await toFieldWidth(dayIn, String(id.birthDay)),
          );
        }
        if (await yearIn.count()) {
          await humanClickLocator(s.page, yearIn);
          await humanType(s.page, String(id.birthYear));
        }
      }
    }

    // 4. Apple ID email = the inbound-domain address generateIdentity picked
    const emailIn = frame
      .locator(
        'input[name="appleId"], input[name="email"], input[type="email"], input[autocomplete="email"]',
      )
      .first();
    await emailIn.waitFor({ state: 'visible' });
    await humanClickLocator(s.page, emailIn);
    await humanType(s.page, id.email);

    // 5. Password + confirm
    const pwIn = frame
      .locator(
        'input[name="password"], input[id="password"], input[type="password"][autocomplete="new-password"]',
      )
      .first();
    await pwIn.waitFor({ state: 'visible' });
    await humanClickLocator(s.page, pwIn);
    await humanType(s.page, id.password);
    // The confirm box is the second new-password field the form shows.
    const [, cfIn] = await frame
      .locator(
        'input[name="confirmPassword"], input[id="confirmPassword"], input[type="password"][autocomplete="new-password"]',
      )
      .all();
    if (cfIn) {
      await humanClickLocator(s.page, cfIn);
      await humanType(s.page, id.password);
    }

    // 6. Phone — Apple requires SMS verification, in the country its phone
    // field is set to (../../_shared/inputs/phone.mjs).
    const phoneIn = frame
      .locator(
        'input[name="phoneNumber"], input[type="tel"], input[autocomplete="tel"]',
      )
      .first();
    await phoneIn.waitFor({ state: 'visible' });
    const digits = await phoneForField(s, frame, 'apple');
    await humanClickLocator(s.page, phoneIn);
    await humanType(s.page, digits);

    // 7. Submit
    const submit = frame
      .locator('button[type="submit"]')
      .filter({ visible: true })
      .first();
    await humanClickLocator(s.page, submit);
    await pageSettled(s.page);

    // 8. Email OTP: one digit per box, as many boxes as the code has digits.
    const emailBoxes = frame.locator(
      'input[id*="email-verification" i], input[aria-label*="verification" i][type="tel"], input[aria-label*="digit" i]',
    );
    await emailBoxes.first().waitFor({ state: 'visible' });
    const emailCodeBoxes = await emailBoxes.all();
    const emailCode = await mailedCode(
      id.email,
      'apple',
      emailCodeBoxes.length,
    );
    await fillCodeBoxes(
      emailCodeBoxes,
      emailCode,
      'apple_email_otp_unexpected_inputs',
    );
    await pageSettled(s.page);

    // 9. Phone OTP
    const smsCode = await s.textedCode();
    const smsBoxes = await frame
      .locator(
        'input[id*="phone-verification" i], input[aria-label*="phone" i][type="tel"], input[aria-label*="digit" i]',
      )
      .all();
    await fillCodeBoxes(smsBoxes, smsCode, 'apple_sms_otp_unexpected_inputs');
    await pageSettled(s.page);

    // 10. Success lands on appleid.apple.com, or on idmsa's auth/done page.
    const landed = new URL(s.page.url());
    if (
      landed.hostname !== 'appleid.apple.com' &&
      !(
        landed.hostname === 'idmsa.apple.com' &&
        landed.pathname.includes('/auth/done')
      )
    ) {
      await pageSettled(s.page);
      const settled = s.page.url();
      if (new URL(settled).hostname !== 'appleid.apple.com')
        throw new Error(`apple_register_no_landing: ${settled}`);
    }

    await s.saveAccount('apple', {
      username: id.username,
      email: id.email,
      password: id.password,
      name: `${id.firstName} ${id.lastName}`,
      status: 'verified',
    });
    console.log(`PASS: apple ${id.email}`);
  } finally {
    await s.close();
  }
}
