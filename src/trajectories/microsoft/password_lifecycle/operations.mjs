import { humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';
import {
  IDENTITY_CHALLENGE, LOGIN_HOSTS, LOGIN_URL, NEW_PASSWORD_FORM_WAIT_MS, PASSWORD_CHANGE_URL, RECOVERY_FIELD_WAIT_MS,
} from './constants.mjs';
import { bodyText, choosePasswordSignIn, completeEmailIdentityChallenge, fill, pageConfig, press, visible } from './sign_in_page.mjs';

const EMAIL_INPUT = 'input[name="loginfmt"], input#i0116, input[type="email"]';
const SUBMIT = 'input[type="submit"]#idSIButton9, button[type="submit"]';
const NEW_PASSWORD = 'input#iPassword, input[name="Password"][aria-label*="New password" i]';
const RETYPE_PASSWORD = 'input#iRetypePassword, input[name="RetypePassword"]';

/** A field that never appeared is logged; the step decides what it means. */
function noteAbsent(name) {
  return (error) => console.log(`[microsoft] ${name} did not appear: ${String(error?.message ?? error).slice(0, 120)}`);
}

/** Sign in from a clean context with the given password; true when Microsoft accepted it. */
export async function verifyPassword(session, email, password) {
  await session.ctx.clearCookies();
  await session.page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('deliberate');
  const emailInput = session.page.locator(EMAIL_INPUT).first();
  await fill(session.page, emailInput, email);
  const next = session.page.locator(SUBMIT).first();
  await humanClickLocator(session.page, next);
  await humanIdlePause('deliberate');
  await choosePasswordSignIn(session.page);
  const passwordInput = session.page.locator('input[name="passwd"], input#i0118, input[type="password"]').first();
  if (!await visible(passwordInput)) return false;
  await fill(session.page, passwordInput, password);
  const submit = session.page.locator(SUBMIT).first();
  await humanClickLocator(session.page, submit);
  await humanIdlePause('long');
  const body = await bodyText(session.page);
  if (/incorrect|wrong password|password is invalid|try again/i.test(body)) return false;
  if (await visible(session.page.locator('input[name="passwd"], input#i0118'))) return false;
  if (IDENTITY_CHALLENGE.test(body)) return true;
  return /stay signed in/i.test(body) || !/login\.live\.com\/login/i.test(session.page.url());
}

/**
 * The recovery route taken when the current password is not known: enter the
 * email, follow Microsoft's reset link on the account origin, leave any
 * passkey prompt, and confirm the sign-in name.
 */
async function openRecovery(page, email) {
  const emailInput = page.locator(EMAIL_INPUT).first();
  await emailInput.waitFor({ state: 'visible', timeout: RECOVERY_FIELD_WAIT_MS }).catch(noteAbsent('recovery email field'));
  if (await visible(emailInput)) {
    await fill(page, emailInput, email);
    const next = page.locator(SUBMIT).first();
    await humanClickLocator(page, next);
    await humanIdlePause('deliberate');
  }
  const resetUrl = await pageConfig(page, () => globalThis.$Config?.urlResetPassword ?? globalThis.ServerData?.urlResetPassword ?? '');
  if (!resetUrl) {
    const forgotPassword = page.getByText(/Forgot password|Reset password/i).first();
    await forgotPassword.waitFor({ state: 'visible', timeout: RECOVERY_FIELD_WAIT_MS }).catch(noteAbsent('forgot-password link'));
    if (await visible(forgotPassword)) {
      await humanClickLocator(page, forgotPassword);
      await humanIdlePause('long');
    }
    return;
  }
  const target = new URL(resetUrl, page.url());
  if (target.hostname !== 'account.live.com') {
    throw new Error('Microsoft password reset URL escaped the account origin');
  }
  await page.goto(target.href, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');
  await press(page, 'Escape');
  const passkeyBack = page.locator('#idBtn_Back, button[aria-label="Back"]').first();
  if (await passkeyBack.count().catch(() => false)) {
    await passkeyBack.evaluate((element) => element.click()).catch(noteAbsent('passkey back control'));
    await humanIdlePause('long');
  }
  const recoveryBody = await bodyText(page);
  const resumeUrl = await pageConfig(page, () => globalThis.$Config?.urlCancel
    ?? globalThis.$Config?.urlResume
    ?? globalThis.ServerData?.urlCancel
    ?? globalThis.ServerData?.urlResume
    ?? '');
  if (/security window|try again/i.test(recoveryBody) && resumeUrl) {
    const resumeTarget = new URL(resumeUrl, page.url());
    if (!LOGIN_HOSTS.includes(resumeTarget.hostname)) {
      throw new Error('Microsoft recovery resume URL escaped the login origin');
    }
    await page.goto(resumeTarget.href, { waitUntil: 'domcontentloaded' });
    await humanIdlePause('long');
  }
  await choosePasswordSignIn(page, false);
  const recoveryEmail = page.locator('input#iSigninName, input[name="iSigninName"], input[type="email"]').first();
  await recoveryEmail.waitFor({ state: 'visible', timeout: RECOVERY_FIELD_WAIT_MS }).catch(noteAbsent('recovery sign-in name'));
  if (await visible(recoveryEmail)) {
    await fill(page, recoveryEmail, email);
    const recoveryNext = page.getByRole('button', { name: /^Next$/i }).first();
    if (await visible(recoveryNext)) {
      await humanClickLocator(page, recoveryNext);
    } else {
      await humanClickLocator(page, page.locator('input[type="submit"]').first());
    }
    await humanIdlePause('long');
  }
}

/**
 * Change the password on account.live.com. Returns 'changed', 'rejected',
 * 'unavailable' (no password form reached) or 'ambiguous'.
 */
export async function changePassword(session, email, currentPassword, nextPassword) {
  let page = session.page;
  const recovering = process.env.MICROSOFT_ALLOW_UNKNOWN_CURRENT_PASSWORD_RECOVERY === '1';
  if (recovering) {
    await page.addInitScript(() => {
      Object.defineProperty(globalThis, 'PublicKeyCredential', {
        configurable: true,
        value: undefined,
      });
    });
  }
  await page.goto(PASSWORD_CHANGE_URL, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');
  await choosePasswordSignIn(page);
  if (recovering) await openRecovery(page, email);

  let newPasswordInput = page.locator(NEW_PASSWORD).first();
  let retypePasswordInput = page.locator(RETYPE_PASSWORD).first();
  let dedicatedFormReady = await visible(newPasswordInput) && await visible(retypePasswordInput);

  if (!dedicatedFormReady) {
    const challengePage = await completeEmailIdentityChallenge(page, email);
    if (challengePage) page = challengePage;
    newPasswordInput = page.locator(NEW_PASSWORD).first();
    retypePasswordInput = page.locator(RETYPE_PASSWORD).first();
    await newPasswordInput.waitFor({ state: 'visible', timeout: NEW_PASSWORD_FORM_WAIT_MS }).catch(noteAbsent('new-password form'));
    dedicatedFormReady = await visible(newPasswordInput) && await visible(retypePasswordInput);
  }

  if (dedicatedFormReady) {
    await fill(page, newPasswordInput, nextPassword);
    await fill(page, retypePasswordInput, nextPassword);
    const submit = page.locator('input#UpdatePasswordAction, button[type="submit"], input[type="submit"]').first();
    await humanClickLocator(page, submit);
  } else {
    const passwordInputs = page.locator('input[type="password"]');
    const count = await passwordInputs.count();
    if (count < 2) return 'unavailable';
    if (count >= 3) {
      await fill(page, passwordInputs.nth(0), currentPassword);
    }
    await fill(page, passwordInputs.nth(count - 2), nextPassword);
    await fill(page, passwordInputs.nth(count - 1), nextPassword);
    const submit = page.locator('button[type="submit"], input[type="submit"]').first();
    await humanClickLocator(page, submit);
  }

  await humanIdlePause('long');
  const body = await bodyText(page);
  if (/couldn.t change|try again|incorrect|error/i.test(body)) return 'rejected';
  return /password.{0,40}(changed|updated|success)/i.test(body)
    || /account\.microsoft\.com\/security/i.test(page.url())
    || !await visible(page.locator('input#iPassword, input[type="password"]'))
    ? 'changed'
    : 'ambiguous';
}

/** Put the previous password back and prove it signs in. */
export async function rollbackPassword(session, email, currentPassword, previousPassword) {
  await changePassword(session, email, currentPassword, previousPassword);
  return verifyPassword(session, email, previousPassword);
}
