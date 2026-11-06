// Enrolling a Google Authenticator inside a browser session that is already
// signed in, and storing its seed on the Skarbiec login item the session
// signed in with.
//
// Google shows an authenticator setup key only inside a signed-in session,
// so a login item with no seed can get one only right after a sign-in that
// passed Google's second factor some other way (the owner's phone approval).
// Every sign-in that reaches that state calls `enrolAfterApproval`, so the one
// approval a seedless account needs is also the last: the seed is written in
// the same session and every later sign-in answers Google with a code.
// `weles run google/authenticator/enrol` drives the same steps for a login
// item on its own.
import { pageSettled } from '../../page/settled.mjs';
import {
  confirmSetupCode,
  openAuthenticatorSetup,
  revealSetupKey,
} from './authenticator_enrol.mjs';
import { loginMaterial, signIn } from './sign_in/account.mjs';
import { persistEnrolledSeed } from '../../../google/authenticator/account-binding.mjs';

/**
 * Reach the authenticator setup page, answering each sign-in Google asks for
 * on the way with `answerSignIn`. Google asks again ("Verify it's you", the
 * password once more) before it shows a security setting, so the page is
 * reopened after each sign-in, and the loop ends when Google asks again at an
 * address it already asked at after a sign-in.
 */
export async function openSignedIn(page, wait, answerSignIn) {
  const asked = new Set();
  for (;;) {
    const opened = await openAuthenticatorSetup(page, wait);
    if (opened.ok || opened.blocked !== 'google_sign_in_required') return opened;
    const at = page.url();
    if (asked.has(at)) return opened;
    asked.add(at);
    const signedIn = await answerSignIn(page, wait);
    if (!signedIn.ok) return signedIn;
  }
}

/**
 * Enrol on `page`, signed in as `login` (from `loginMaterial`): open the
 * setup, read the key, confirm the first code and write the seed to the
 * login item, read back. Each step that stops is reported by name with what
 * Google showed; a seed Google accepted but Skarbiec did not confirm is
 * `seed_persist_unconfirmed`.
 */
export async function enrolOnPage(page, login, answerSignIn) {
  const wait = () => pageSettled(page);
  const opened = await openSignedIn(page, wait, answerSignIn);
  if (!opened.ok) return { stage: 'authenticator_setup_open', ...opened };
  const revealed = await revealSetupKey(page, wait);
  if (!revealed.ok) return { stage: 'authenticator_key_reveal', ...revealed };
  const confirmed = await confirmSetupCode(page, wait, revealed.secret);
  if (!confirmed.ok) return { stage: 'authenticator_code_confirm', ...confirmed };
  const persisted = persistEnrolledSeed(login, revealed.secret);
  if (!persisted.ok) return { stage: 'authenticator_seed_write', ...persisted };
  return { ok: true, seed_written: true, url: confirmed.url };
}

/**
 * After a sign-in of `loginItem` passed Google's second factor without a
 * stored seed, enrol an authenticator in a page of the same browser context
 * and store its seed, leaving the caller's page where it is. A login item
 * that already holds a seed is left alone. Never throws for a stop it can
 * name: the caller's sign-in already succeeded, so the outcome is returned
 * and logged, and `stado credentials seed list` keeps showing the row as
 * empty until a run stores it.
 */
export async function enrolAfterApproval(context, loginItem) {
  if (!loginItem) {
    const result = {
      ok: false,
      blocked: 'authenticator_enrolment_login_item_unknown',
      detail:
        'the sign-in carried no Skarbiec login item, so no seed can be stored for it; read the login through readScopedLogin or readLoginMaterial, which name it',
    };
    console.log(`[google_sso] authenticator enrolment skipped: ${result.detail}`);
    return result;
  }
  let login;
  try {
    login = loginMaterial(loginItem);
  } catch (error) {
    const result = {
      ok: false,
      blocked: 'authenticator_enrolment_login_unreadable',
      login_item: loginItem,
      detail: `Skarbiec login ${loginItem} could not be read for enrolment: ${error.message}`,
    };
    console.log(`[google_sso] authenticator enrolment stopped: ${result.detail}`);
    return result;
  }
  if (login.seed) return { ok: true, seed_written: false, login_item: loginItem };
  const page = await context.newPage();
  try {
    console.log(`[google_sso] enrolling an authenticator for ${loginItem} after the approval`);
    const result = await enrolOnPage(page, login, (p, wait) =>
      signIn(p, wait, login),
    );
    const named = { login_item: loginItem, email: login.email, ...result };
    console.log(
      result.ok
        ? `[google_sso] authenticator seed stored for ${loginItem}`
        : `[google_sso] authenticator enrolment for ${loginItem} stopped at ${result.stage}: ${result.blocked}`,
    );
    return named;
  } catch (error) {
    const result = {
      ok: false,
      blocked: 'authenticator_enrolment_error',
      login_item: loginItem,
      detail: String(error?.message || error),
    };
    console.log(`[google_sso] authenticator enrolment for ${loginItem} failed: ${result.detail}`);
    return result;
  } finally {
    await page.close();
  }
}
