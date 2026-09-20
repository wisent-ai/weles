// Enrol a Google Authenticator for one Skarbiec login item and store its
// seed there, so every later sign-in answers Google's second factor itself.
//
// `stado credentials seed-freshness --host <host>` found every Claude, Codex
// and Kimi Google login in the vault declaring `totp_secret` and holding
// nothing in it (`seed_field_empty`), so Brama's automatic sign-in stopped at
// Google's push prompt on every account. Google enrols an authenticator only
// from a signed-in session, and the first sign-in from a fresh profile is
// answered by a push to the operator's phone: this trajectory waits for that
// one approval, then reads the setup key Google shows, confirms the first
// code, and writes the seed to the login item. From then on the seed answers.
//
// Input: WELES_LOGIN_ITEM, the Skarbiec login item (username, password,
// totp_secret). Output: one JSON result on stdout and in the run's output
// directory; every stop is named.
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { runOutputPath } from '#run-output';
import { WSession } from '../../../../dist/session/wsession.js';
import { humanFill, humanType } from '../../../../dist/human/keyboard.js';
import { humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';
import { readDocument, writeDocument } from '../../../../dist/state/skarbiec-records.js';
import { fillAndVerify, waitForEnabledThenClick } from '../../codex/google_sso/page_controls.mjs';
import { waitForGooglePassword } from '../../codex/google_sso/google_credentials.mjs';
import {
  confirmSetupCode, onSignIn, openAuthenticatorSetup, redactKeys, revealSetupKey,
} from '../../_shared/services/google_sso/authenticator_enrol.mjs';
import { generateTotp } from '../../_shared/services/google_sso/totp_secret.mjs';

/** How long the operator has to approve Google's push prompt on the phone. */
const PUSH_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
const NAV_TIMEOUT_MS = 60_000;
/** A heading is a label, not a page: enough to recognise which screen Google
 * showed, never enough to carry its contents. */
const MAX_HEADING_CHARS = 200;
/** Google's password-only challenge: the account is known, the session is not. */
const PASSWORD_CHALLENGE = /\/signin\/challenge\/pwd/;
const RESULT_DIR = runOutputPath('google-authenticator-enrol');
const RESULT_FILE = join(RESULT_DIR, 'result.json');

// Every exit of this trajectory goes through here, so a missing directory
// turns each one into `ENOENT … /runs/google-authenticator-enrol/result.json`
// and the real verdict — including the refusals this flow is built to report —
// is replaced by a crash. Measured on 2026-09-20: the browser signed in and
// the run still died at its first report. The directory is created here, where
// the file is written, rather than at import time, because the run output root
// is created per run.
function report(result) {
  mkdirSync(RESULT_DIR, { recursive: true });
  writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  return result;
}

function loginMaterial(loginItem) {
  const document = readDocument(loginItem);
  const fields = document.fields ?? {};
  if (typeof fields.username !== 'string' || !fields.username) {
    throw new Error(`Skarbiec login ${loginItem} has no username`);
  }
  if (typeof fields.password !== 'string' || !fields.password) {
    throw new Error(`Skarbiec login ${loginItem} has no password`);
  }
  return { document, email: fields.username, password: fields.password, seed: String(fields.totp_secret || '').trim() };
}

/// What Google is showing, in the words a reader can act on: the address and
/// the first visible heading, bounded and redacted. A timeout that says only
/// "locator.waitFor: Timeout 30000ms exceeded" names the selector this code
/// chose and nothing about the page that was actually there.
async function pageDescription(page) {
  const heading = await page
    .locator('h1, h2, [role="heading"]')
    .filter({ visible: true })
    .first()
    .textContent({ timeout: 2_000 })
    .catch(() => '');
  return {
    url: redactKeys(String(page.url())),
    heading: redactKeys(String(heading || '').trim().slice(0, MAX_HEADING_CHARS)),
  };
}

async function signIn(page, wait, login) {
  await page.goto('https://accounts.google.com/ServiceLogin?hl=en', { waitUntil: 'commit', timeout: NAV_TIMEOUT_MS });
  await humanIdlePause('deliberate');
  // The profile is persistent on purpose, so the session an earlier run
  // established may still be live: Google then answers the sign-in address
  // with the account itself, and there is no form to fill.
  if (!onSignIn(page.url())) return { ok: true };
  // Google remembers the account on this persistent profile and asks only for
  // the password again, on `/v3/signin/challenge/pwd`, whose `continue` is
  // already the authenticator setup page. That screen carries no email field,
  // so the identifier step must be skipped rather than waited for: measured on
  // 2026-09-20 in run 58bbd595-f53d-4314-a33d-18606c32e232.
  if (!PASSWORD_CHALLENGE.test(page.url())) {
    const email = page.locator('input[type="text"][autocomplete*="username"], input#identifierId, input[name="identifier"], input[type="email"]')
      .filter({ visible: true }).first();
    try {
      await email.waitFor({ state: 'visible' });
    } catch (error) {
      if (error?.name !== 'TimeoutError') throw error;
      if (!onSignIn(page.url())) return { ok: true };
      if (!PASSWORD_CHALLENGE.test(page.url())) {
        return { ok: false, blocked: 'google_sign_in_page_unrecognised', ...(await pageDescription(page)) };
      }
    }
    if (await email.isVisible().catch(() => false)) {
      await fillAndVerify(page, email, login.email, humanClickLocator, humanType);
      await waitForEnabledThenClick(page, /next|continue|dalej/i);
      await humanIdlePause('deliberate');
    }
  }
  const password = await waitForGooglePassword({ page, mark: () => {}, humanClickLocator, humanIdlePause });
  await fillAndVerify(page, password, login.password, humanClickLocator, humanType);
  await waitForEnabledThenClick(page, /next|sign in|continue|dalej/i);
  await humanIdlePause('long');
  await wait(4);
  if (!onSignIn(page.url())) return { ok: true };
  if (login.seed) {
    const code = page.locator('input[name="totpPin"], input[autocomplete="one-time-code"]').filter({ visible: true }).first();
    if (await code.isVisible()) {
      await humanFill(page, code, generateTotp(login.seed));
      await waitForEnabledThenClick(page, /next|verify/i);
      await wait(6);
      if (!onSignIn(page.url())) return { ok: true };
    }
  }
  // Google's push to the operator's phone: one approval, waited for once.
  console.log(`[google-authenticator-enrol] waiting up to ${PUSH_APPROVAL_TIMEOUT_MS / 1000}s for the operator to approve Google's prompt on the phone`);
  try {
    await page.waitForURL((url) => !/accounts\.google\.com/.test(String(url)), { timeout: PUSH_APPROVAL_TIMEOUT_MS });
  } catch (error) {
    if (error?.name !== 'TimeoutError') throw error;
    return { ok: false, blocked: 'google_push_not_approved', url: page.url() };
  }
  return { ok: true };
}

async function main() {
  const loginItem = String(process.env.WELES_LOGIN_ITEM || '').trim();
  if (!loginItem) {
    report({ ok: false, blocked: 'login_item_required', detail: 'WELES_LOGIN_ITEM must name the Skarbiec login item to enrol' });
    process.exit(2);
  }
  const login = loginMaterial(loginItem);
  // One persistent profile per login item: the session the operator's one
  // approval established survives a later step's refusal, so a rerun after
  // a fixed page continues from a signed-in account instead of asking for a
  // second approval.
  const userDataDir = join(homedir(), '.weles', 'browser_profiles', 'google-authenticator', loginItem);
  mkdirSync(userDataDir, { recursive: true });
  const session = await WSession.start({
    label: `google-authenticator-enrol-${loginItem}`, browser: 'chromium', headless: false, userDataDir,
  });
  const page = session.page;
  const wait = (seconds) => session.wait(seconds);
  try {
    let opened = await openAuthenticatorSetup(page, wait, NAV_TIMEOUT_MS);
    if (!opened.ok && opened.blocked === 'google_sign_in_required') {
      const signedIn = await signIn(page, wait, login);
      if (!signedIn.ok) {
        report({ ok: false, login_item: loginItem, email: login.email, ...signedIn });
        process.exit(3);
      }
      opened = await openAuthenticatorSetup(page, wait, NAV_TIMEOUT_MS);
    }
    if (!opened.ok) {
      report({ ok: false, login_item: loginItem, email: login.email, ...opened });
      process.exit(4);
    }
    const revealed = await revealSetupKey(page, wait);
    if (!revealed.ok) {
      report({ ok: false, login_item: loginItem, email: login.email, ...revealed });
      process.exit(5);
    }
    const confirmed = await confirmSetupCode(page, wait, revealed.secret);
    if (!confirmed.ok) {
      report({ ok: false, login_item: loginItem, email: login.email, ...confirmed });
      process.exit(6);
    }
    // Google accepted the first code: the seed is live. Write it beside the
    // password and read it back, so the vault and the account agree.
    const current = readDocument(loginItem);
    current.fields = { ...current.fields, totp_secret: revealed.secret };
    writeDocument(loginItem, current);
    const stored = String(readDocument(loginItem).fields?.totp_secret || '');
    if (stored !== revealed.secret) {
      report({ ok: false, login_item: loginItem, email: login.email, blocked: 'seed_persist_unconfirmed',
        detail: 'Skarbiec did not return the seed just written' });
      process.exit(7);
    }
    report({ ok: true, login_item: loginItem, email: login.email, seed_written: true, url: confirmed.url });
  } finally {
    await session.close();
  }
}

main().catch((error) => {
  report({ ok: false, blocked: 'google_authenticator_enrol_error', error: redactKeys(String(error?.message || error)) });
  process.exit(1);
});
