// LinkedIn phone-verification challenge solver.
//
// After /signup/api/cors/createAccount returns challengeUrl, LinkedIn replaces
// the signup form with a phone-verification UI on the same /signup origin. This
// module waits for that UI, rents an SMS number, submits it, polls for the OTP,
// and fills it back in.

import { humanFill, humanType } from '../../../../dist/human/keyboard.js';
import { humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';

const DEFAULT_COUNTRY = 'US';
const PHONE_POLL_TIMEOUT_SECS = 900;

function stripNonDigits(phone) {
  return String(phone ?? '').replace(/\D/g, '');
}

function phoneDigitsForInput(phone, country) {
  const digits = stripNonDigits(phone);
  if (country === 'US' && digits.startsWith('1') && digits.length === 11) return digits.slice(1);
  return digits;
}

async function findPhoneFrame(page) {
  // Top-level form first — LinkedIn renders the challenge directly on /signup.
  const topPhone = page.locator('input[name="phoneNumber"], input#register-verification-phone-number, input#phone-verification-phone-number, input[type="tel"]').filter({ visible: true }).first();
  if (await topPhone.count() && await topPhone.isVisible({ timeout: 2000 }).catch(() => false)) {
    return { frame: page, phoneInput: topPhone };
  }
  // Fallback: challenge rendered inside an iframe.
  const frames = page.frames();
  for (const frame of frames) {
    const phoneInput = frame.locator('input[name="phoneNumber"], input#register-verification-phone-number, input#phone-verification-phone-number, input[type="tel"]').filter({ visible: true }).first();
    if (await phoneInput.count() && await phoneInput.isVisible({ timeout: 1000 }).catch(() => false)) {
      return { frame, phoneInput };
    }
  }
  return null;
}

async function findCodeInput(frame) {
  const loc = frame.locator('input[name="pin"], input#register-verification-phone-pin, input#phone-verification-pin, input[autocomplete="one-time-code"], input[type="tel"][maxlength="6"]').filter({ visible: true }).first();
  if (await loc.count() && await loc.isVisible({ timeout: 2000 }).catch(() => false)) return loc;
  return null;
}

async function setCountry(frame, country) {
  const select = frame.locator('select[name="country"], select#register-verification-country, select#phone-verification-country').first();
  if (!(await select.count())) return false;
  try {
    const options = await select.locator('option').allTextContents();
    const values = await select.locator('option').all();
    const targets = [country, 'United States', 'USA', 'US'];
    for (const target of targets) {
      for (let i = 0; i < options.length; i++) {
        const text = String(options[i] ?? '').trim();
        const value = await values[i]?.getAttribute('value').catch(() => '');
        if (text.toLowerCase().includes(target.toLowerCase()) || String(value).toLowerCase() === target.toLowerCase()) {
          await select.selectOption(value || text);
          return true;
        }
      }
    }
  } catch (e) { console.log(`[phone_verify] country select err: ${e.message?.slice(0, 80)}`); }
  return false;
}

async function submitPhoneForm(page, frame, phoneInput, country, phone) {
  await setCountry(frame, country);
  await humanIdlePause('deliberate');
  await humanFill(page, phoneInput, phoneDigitsForInput(phone, country));
  await humanIdlePause('deliberate');
  const submit = frame.locator('button[type="submit"], button#register-verification-submit, button:has-text("Submit"), button:has-text("Continue"), button:has-text("Send code")').filter({ visible: true }).first();
  if (!(await submit.count())) throw new Error('phone_verify: submit button not found');
  await humanClickLocator(page, submit);
  return true;
}

async function submitCodeForm(page, frame, code) {
  const codeInput = await findCodeInput(frame);
  if (!codeInput) throw new Error('phone_verify: code input not found after submitting phone');
  await humanClickLocator(page, codeInput);
  await humanType(page, code);
  await humanIdlePause('deliberate');
  const submit = frame.locator('button[type="submit"], button#register-verification-pin-submit, button:has-text("Submit"), button:has-text("Continue"), button:has-text("Verify")').filter({ visible: true }).first();
  if (!(await submit.count())) throw new Error('phone_verify: code submit button not found');
  await humanClickLocator(page, submit);
}

/**
 * Wait for the phone-verification UI, rent an SMS number, submit it, poll for
 * the OTP, and complete the challenge. Throws on failure.
 *
 * @param {WSession} session
 * @param {string} [country='US']
 * @returns {Promise<{phone: string, code: string}>}
 */
export async function solveLinkedinPhoneChallenge(session, country = DEFAULT_COUNTRY) {
  const page = session.page;
  console.log('[phone_verify] waiting for phone-verification UI...');
  let frameInfo = null;
  for (let i = 0; i < 30; i++) {
    frameInfo = await findPhoneFrame(page);
    if (frameInfo) break;
    await humanIdlePause('short');
  }
  if (!frameInfo) throw new Error('phone_verify: phone input did not appear');

  console.log('[phone_verify] renting SMS number...');
  const smsResult = await session.checkSms('linkedin', country);
  if (!smsResult || smsResult.startsWith('error:')) throw new Error(`phone_verify: ${smsResult}`);
  const phone = session._env?.LINKEDIN_NEW_PHONE ?? session._smsOrder?.phone;
  if (!phone) throw new Error('phone_verify: no phone number from SMS provider');
  console.log(`[phone_verify] got phone ${phoneDigitsForInput(phone, country)}`);

  console.log('[phone_verify] submitting phone number...');
  await submitPhoneForm(page, frameInfo.frame, frameInfo.phoneInput, country, phone);

  console.log('[phone_verify] polling for SMS code...');
  const code = await session.pollSmsCode();
  if (!code || code === 'no code received' || code.startsWith('error:')) throw new Error(`phone_verify: ${code}`);
  console.log(`[phone_verify] received code ${code}`);

  // The code input may be in the same frame or a refreshed challenge frame.
  let codeFrame = frameInfo.frame;
  let codeInput = await findCodeInput(codeFrame);
  if (!codeInput) {
    const refreshed = await findPhoneFrame(page);
    if (refreshed) codeFrame = refreshed.frame;
    codeInput = await findCodeInput(codeFrame);
  }
  if (!codeInput) throw new Error('phone_verify: code input disappeared after receiving SMS');

  console.log('[phone_verify] submitting verification code...');
  await submitCodeForm(page, codeFrame, code);
  await humanIdlePause('long');

  return { phone, code };
}
