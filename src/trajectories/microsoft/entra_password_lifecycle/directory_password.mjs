// The two directory surfaces that hold an Entra password: the change form that
// needs the current value and the self-service reset that does not, together
// with the compensating restore of the previous value and what that restore
// leaves the provider in.
//
// A screen this run could not read never counts as a screen that confirmed or
// refused anything: it answers 'unavailable' where nothing was submitted yet,
// and 'ambiguous' where a password had already been sent to the directory.
//
// Moved out of entra_password_lifecycle.mjs, which keeps the three trajectory
// entry points.

import { humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';

import {
  appears,
  fill,
  IDENTITY_CHALLENGE,
  IDENTITY_CHALLENGE_PRESENT,
  identityChallengeState,
  PAGE_TEXT_UNREADABLE,
  pageText,
  signIn,
  visible,
} from './authorized_session.mjs';
import { assertEntraIdentity } from './proven_identity.mjs';
import { CHANGE_PASSWORD_URL, SELF_SERVICE_RESET_URL } from './queued_job.mjs';

const CHANGE_CONFIRMED = /password (?:has been |was )?(?:changed|updated)|password change (?:was )?successful|you (?:have )?(?:successfully )?changed your password/i;
const CHANGE_REJECTED = /(?:current|old) password (?:is )?(?:incorrect|wrong)|(?:doesn.t|does not) meet|couldn.t (?:be )?chang|password (?:is )?(?:incorrect|invalid)|try again/i;
const RESET_VERIFICATION = /verification step|email my alternate email|text my mobile phone|call my (?:mobile|office) phone|approve a notification|enter a code from my authenticator|enter the characters (?:in|you see)|security check/i;
const RESET_NOT_ELIGIBLE = /we couldn.t verify (?:the |your )?account|account (?:was )?not found|contact your administrator|self-service password reset (?:is )?(?:not|isn.t) (?:enabled|available)/i;

// 'changed' | 'rejected' | 'ambiguous' | 'challenged' | 'unavailable'
export async function changeEntraPassword(session, currentPassword, nextPassword) {
  const page = session.page;
  await page.goto(CHANGE_PASSWORD_URL, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');
  const challenged = await identityChallengeState(page);
  if (challenged === IDENTITY_CHALLENGE_PRESENT) return 'challenged';
  if (challenged === PAGE_TEXT_UNREADABLE) return 'unavailable';
  const passwordInputs = page.locator('input[type="password"]');
  const rendered = await appears(passwordInputs.first(), Number('60000'));
  const count = await passwordInputs.count().catch(() => Number('0'));
  if (!rendered || count < Number('3')) return 'unavailable';
  await fill(page, passwordInputs.nth(''.length), currentPassword);
  await fill(page, passwordInputs.nth(count - Number('2')), nextPassword);
  await fill(page, passwordInputs.nth(count - 'x'.length), nextPassword);
  await humanClickLocator(page, page.locator('input[type="submit"], button[type="submit"]').first());
  await humanIdlePause('long');
  const answered = await pageText(page);
  if (!answered.ok) return 'ambiguous';
  if (CHANGE_CONFIRMED.test(answered.text)) return 'changed';
  if (CHANGE_REJECTED.test(answered.text)) return 'rejected';
  return await visible(page.locator('input[type="password"]')) ? 'rejected' : 'ambiguous';
}

// 'none' | 'completed' | 'failed' | 'unknown'
//
// 'failed' is the known-state refusal: the restore never reached the directory,
// so it still holds the value this run wrote. Everything the restore leaves
// unproven is 'unknown'.
export async function rollbackEntraPassword(session, contract, changedPassword, previousPassword, sink) {
  const signedIn = await signIn(session, contract, changedPassword);
  if (signedIn !== 'authenticated') return 'unknown';
  const identity = await assertEntraIdentity(session, contract, sink);
  if (!identity.ok) return 'unknown';
  const restored = await changeEntraPassword(session, changedPassword, previousPassword);
  if (restored === 'rejected' || restored === 'unavailable') return 'failed';
  if (restored !== 'changed') return 'unknown';
  const reauthenticated = await signIn(session, contract, previousPassword);
  if (reauthenticated !== 'authenticated') return 'unknown';
  const restoredIdentity = await assertEntraIdentity(session, contract, sink);
  return restoredIdentity.ok ? 'completed' : 'unknown';
}

// A rollback that restored the previous value leaves the provider untouched, a
// refused rollback leaves the value this run wrote, and anything else leaves the
// directory password unknown.
export function providerEffectAfterRollback(rollbackStatus) {
  if (rollbackStatus === 'completed') return 'none';
  if (rollbackStatus === 'failed') return 'changed';
  return 'unknown';
}

// 'password_form' | 'identity_verification_required' | 'not_eligible' | 'unavailable'
export async function openSelfServiceReset(session, contract) {
  const page = session.page;
  await session.ctx.clearCookies();
  await page.goto(SELF_SERVICE_RESET_URL, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');
  const userInput = page.locator(
    'input#userNameInput, input[name="UserName"], input[type="email"], input[type="text"]',
  ).first();
  if (await appears(userInput, Number('60000')) && await visible(userInput)) {
    await fill(page, userInput, contract.accountUpn);
    const proceed = page.getByRole('button', { name: /Next|Continue|Submit/i }).first();
    if (await visible(proceed)) {
      await humanClickLocator(page, proceed);
    } else {
      await humanClickLocator(page, page.locator('input[type="submit"], button[type="submit"]').first());
    }
    await humanIdlePause('long');
  }
  const answered = await pageText(page);
  if (!answered.ok) return 'unavailable';
  if (RESET_NOT_ELIGIBLE.test(answered.text)) return 'not_eligible';
  if (RESET_VERIFICATION.test(answered.text) || IDENTITY_CHALLENGE.test(answered.text)) {
    return 'identity_verification_required';
  }
  const captcha = page.locator('iframe[src*="recaptcha"], iframe[title*="captcha" i], #wCaptchaDiv').first();
  if (await visible(captcha)) return 'identity_verification_required';
  const newPasswords = page.locator('input[type="password"]');
  const count = await newPasswords.count().catch(() => Number('0'));
  return count >= Number('2') ? 'password_form' : 'unavailable';
}

export async function submitResetPasswordForm(session, nextPassword) {
  const page = session.page;
  const passwordInputs = page.locator('input[type="password"]');
  const count = await passwordInputs.count().catch(() => Number('0'));
  if (count < Number('2')) return 'unavailable';
  await fill(page, passwordInputs.nth(count - Number('2')), nextPassword);
  await fill(page, passwordInputs.nth(count - 'x'.length), nextPassword);
  await humanClickLocator(page, page.locator('input[type="submit"], button[type="submit"]').first());
  await humanIdlePause('long');
  const answered = await pageText(page);
  if (!answered.ok) return 'ambiguous';
  if (CHANGE_CONFIRMED.test(answered.text) || /your password has been reset/i.test(answered.text)) return 'changed';
  if (CHANGE_REJECTED.test(answered.text)) return 'rejected';
  return await visible(page.locator('input[type="password"]')) ? 'rejected' : 'ambiguous';
}
