// Signing one Skarbiec Google login into a persistent browser profile, for
// trajectories that act on the account's own settings pages
// (myaccount.google.com): the authenticator enrolment and the app password.
//
// The profile is keyed by the Google account, not by the login item: Google
// answers the first sign-in from a profile it has never seen with a push to the
// account owner's phone, and keyed by the account that approval is asked once
// for every later trajectory on the same account. This module answers every
// screen the login item can answer — address, password, authenticator code —
// and stops with `google_push_approval_required` at the phone prompt, which
// only the authenticator enrolment waits for, because it is the trajectory
// that ends the need for it.
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { humanFill, humanType } from '../../../../../../dist/human/keyboard.js';
import { humanClickLocator, humanIdlePause } from '../../../../../../dist/human/mouse.js';
import { readDocument } from '../../../../../../dist/state/skarbiec-records.js';
import { fillAndVerify, waitForEnabledThenClick } from '../../../../codex/google_sso/page_controls.mjs';
import { waitForGooglePassword } from '../../../../codex/google_sso/google_credentials.mjs';
import { onSignIn, redactKeys } from '../authenticator_enrol.mjs';
import { generateTotp } from '../totp_secret.mjs';
import { MAX_HEADING_CHARS } from './constants.mjs';

/** Google's password-only challenge: the account is known, the session is not. */
export const PASSWORD_CHALLENGE = /\/signin\/challenge\/pwd/;
const EMAIL_FIELD = 'input[type="text"][autocomplete*="username"], input#identifierId, input[name="identifier"], input[type="email"]';
const CODE_FIELD = 'input[name="totpPin"], input[autocomplete="one-time-code"]';

/** The username, password and authenticator seed of one Skarbiec login item. */
export function loginMaterial(loginItem) {
  const document = readDocument(loginItem);
  const fields = document.fields ?? {};
  if (typeof fields.username !== 'string' || !fields.username) {
    throw new Error(`Skarbiec login ${loginItem} has no username`);
  }
  if (typeof fields.password !== 'string' || !fields.password) {
    throw new Error(`Skarbiec login ${loginItem} has no password`);
  }
  return { loginItem, document, email: fields.username, password: fields.password, seed: String(fields.totp_secret || '').trim() };
}

/** The persistent browser profile of one Google account. */
export function accountProfileDir(login) {
  const account = (login.email || login.loginItem).toLowerCase().replace(/[^a-z0-9._@-]+/g, '_');
  const userDataDir = join(homedir(), '.weles', 'browser_profiles', 'google-account', account);
  mkdirSync(userDataDir, { recursive: true });
  return userDataDir;
}

/// What Google is showing, in the words a reader can act on: the address and
/// the first visible heading, bounded and redacted, so a stop names the page
/// that was actually there rather than the selector this code chose.
export async function pageDescription(page) {
  const heading = page.locator('h1, h2, [role="heading"]').filter({ visible: true }).first();
  const text = await heading.isVisible() ? await heading.textContent() : '';
  return {
    url: redactKeys(String(page.url())),
    heading: redactKeys(String(text || '').trim().slice(0, MAX_HEADING_CHARS)),
  };
}

/**
 * Sign `login` in, answering a password re-challenge where it stands and a
 * code challenge from the login's seed.
 * @returns {Promise<{ ok: true } | { ok: false, blocked: string, url: string, heading: string }>}
 */
export async function signIn(page, wait, login) {
  // Where this is called from matters. A settings page that asked for a
  // sign-in leaves the browser on Google's password re-challenge
  // (`/v3/signin/challenge/pwd`) while the session cookie is still live.
  // Navigating to ServiceLogin from there throws the challenge away: Google
  // sends the profile straight back to the account, this function reports
  // success, and the settings page demands re-authentication again —
  // measured on 2026-09-20 in runs 58bbd595 and a4ccd398. So a challenge
  // already on screen is answered where it stands.
  if (!PASSWORD_CHALLENGE.test(page.url())) {
    await page.goto('https://accounts.google.com/ServiceLogin?hl=en', { waitUntil: 'domcontentloaded' });
    await humanIdlePause('deliberate');
    // The profile is persistent on purpose, so the session an earlier run
    // established may still be live: Google then answers the sign-in address
    // with the account itself, and there is no form to fill.
    if (!onSignIn(page.url())) return { ok: true };
  }
  if (!PASSWORD_CHALLENGE.test(page.url())) {
    const email = page.locator(EMAIL_FIELD).filter({ visible: true }).first();
    if (await email.isVisible()) {
      await fillAndVerify(page, email, login.email, humanClickLocator, humanType);
      await waitForEnabledThenClick(page, /next|continue|dalej/i);
      await humanIdlePause('deliberate');
    } else if (!onSignIn(page.url())) {
      return { ok: true };
    } else if (!PASSWORD_CHALLENGE.test(page.url())) {
      return { ok: false, blocked: 'google_sign_in_page_unrecognised', ...(await pageDescription(page)) };
    }
  }
  const password = await waitForGooglePassword({ page, mark: () => {}, humanClickLocator, humanIdlePause });
  await fillAndVerify(page, password, login.password, humanClickLocator, humanType);
  await waitForEnabledThenClick(page, /next|sign in|continue|dalej/i);
  await humanIdlePause('long');
  await wait(4);
  if (!onSignIn(page.url())) return { ok: true };
  if (login.seed) {
    const code = page.locator(CODE_FIELD).filter({ visible: true }).first();
    if (await code.isVisible()) {
      await humanFill(page, code, generateTotp(login.seed));
      await waitForEnabledThenClick(page, /next|verify/i);
      await wait(6);
      if (!onSignIn(page.url())) return { ok: true };
    }
  }
  return { ok: false, blocked: 'google_push_approval_required', ...(await pageDescription(page)) };
}
