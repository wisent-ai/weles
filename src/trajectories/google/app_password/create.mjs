// Create a Google app password for one Skarbiec Google login and give it to
// Skrzynka, so the account's mailbox can be read over IMAP without anybody
// opening myaccount.google.com.
//
// Google refuses an account's ordinary password over IMAP when two-step
// verification is on ("Application-specific password required"), and offers
// no API that issues an app password: the only way is the account's own App
// passwords page in a signed-in browser. This trajectory signs the login in
// (password and authenticator seed from Skarbiec), creates a password named
// Skrzynka, reads it from the one dialog that shows it, and pipes it to
// `skrzynka gmail app-password --email <address>`, which proves it with an
// IMAP login, stores it in Skarbiec and declares the mailbox. The password is
// never written to a file, a log or this run's result.
//
// Input: WELES_LOGIN_ITEM, the Skarbiec Google login (username, password,
// totp_secret). Output: one JSON result on stdout and in the run's output
// directory; every stop is named.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runOutputPath } from '#run-output';
import { WSession } from '../../../../dist/session/wsession.js';
import {
  accountProfileDir, loginMaterial, signIn,
} from '../../_shared/services/google_sso/sign_in/account.mjs';
import { createAppPassword, openAppPasswords, redactAppPasswords } from './page.mjs';
import {
  APP_NAME, SIGN_IN_ROUNDS, SKRZYNKA_BIN_VARIABLE, SKRZYNKA_DEFAULT_BIN, SKRZYNKA_DETAIL_CHARS,
} from './constants.mjs';

const RUN = 'google-app-password';
const RESULT_DIR = runOutputPath(RUN);
const RESULT_FILE = join(RESULT_DIR, 'result.json');

function report(result) {
  mkdirSync(RESULT_DIR, { recursive: true });
  const text = redactAppPasswords(JSON.stringify(result, null, 2));
  writeFileSync(RESULT_FILE, text);
  console.log(text);
  return result;
}

/**
 * Reach the App passwords page, signing in whenever Google asks, and create
 * the password. Google may ask for the password again between the page and
 * the dialog, so the whole step is repeated after each sign-in.
 */
async function issue(page, wait, login) {
  let last = { ok: false, blocked: 'google_sign_in_required', url: page.url(), textPreview: '' };
  for (let round = 0; round <= SIGN_IN_ROUNDS; round++) {
    if (round > 0) {
      const signed = await signIn(page, wait, login);
      if (!signed.ok) return signed;
    }
    const opened = await openAppPasswords(page, wait);
    if (!opened.ok) {
      last = opened;
      if (opened.blocked === 'google_sign_in_required') continue;
      return opened;
    }
    const created = await createAppPassword(page, wait, APP_NAME);
    if (created.ok || created.blocked !== 'google_sign_in_required') return created;
    last = created;
  }
  return last;
}

/** Hand the password to Skrzynka on stdin; its JSON answer is the verdict. */
function giveToSkrzynka(email, password) {
  const binary = String(process.env[SKRZYNKA_BIN_VARIABLE] || '').trim() || SKRZYNKA_DEFAULT_BIN;
  const result = spawnSync(binary, ['gmail', 'app-password', '--email', email], {
    input: password,
    encoding: 'utf8',
  });
  if (result.error) {
    return { ok: false, blocked: 'skrzynka_unavailable', detail: `${binary}: ${result.error.message}` };
  }
  const output = redactAppPasswords(`${result.stdout || ''}${result.stderr || ''}`).slice(0, SKRZYNKA_DETAIL_CHARS);
  if (result.status !== 0) {
    return { ok: false, blocked: 'skrzynka_refused_app_password', exit_status: result.status, detail: output };
  }
  return { ok: true, skrzynka: output };
}

async function main() {
  const loginItem = String(process.env.WELES_LOGIN_ITEM || '').trim();
  if (!loginItem) {
    report({ ok: false, blocked: 'login_item_required', detail: 'WELES_LOGIN_ITEM must name the Skarbiec Google login' });
    process.exit(2);
  }
  const login = loginMaterial(loginItem);
  const session = await WSession.start({
    label: `${RUN}-${loginItem}`, browser: 'chromium', headless: false, userDataDir: accountProfileDir(login),
  });
  const wait = (seconds) => session.wait(seconds);
  let issued;
  try {
    issued = await issue(session.page, wait, login);
  } finally {
    await session.close();
  }
  if (!issued.ok) {
    const next = issued.blocked === 'google_push_approval_required'
      ? { next_action: `POST /run {"action":"google_authenticator_enrol","params":{"login_item":"${loginItem}"},"detached":true} on this executor, then weles app-password --login-item ${loginItem}` }
      : {};
    report({ ok: false, login_item: loginItem, email: login.email, ...issued, ...next });
    process.exit(3);
  }
  const handed = giveToSkrzynka(login.email, issued.password);
  if (!handed.ok) {
    report({ ok: false, login_item: loginItem, email: login.email, app_password_created: true, ...handed });
    process.exit(4);
  }
  report({ ok: true, login_item: loginItem, email: login.email, app_name: APP_NAME, skrzynka: handed.skrzynka });
}

main().catch((error) => {
  report({ ok: false, blocked: 'google_app_password_error', error: String(error?.message || error) });
  process.exit(1);
});
