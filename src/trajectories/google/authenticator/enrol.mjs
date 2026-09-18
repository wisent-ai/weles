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
import { writeFileSync } from 'node:fs';
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
const RESULT_DIR = runOutputPath('google-authenticator-enrol');
const RESULT_FILE = join(RESULT_DIR, 'result.json');

function report(result) {
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

async function signIn(page, wait, login) {
  await page.goto('https://accounts.google.com/ServiceLogin?hl=en', { waitUntil: 'commit', timeout: NAV_TIMEOUT_MS });
  await humanIdlePause('deliberate');
  const email = page.locator('input[type="text"][autocomplete*="username"], input#identifierId, input[name="identifier"], input[type="email"]')
    .filter({ visible: true }).first();
  await email.waitFor({ state: 'visible' });
  await fillAndVerify(page, email, login.email, humanClickLocator, humanType);
  await waitForEnabledThenClick(page, /next|continue|dalej/i);
  await humanIdlePause('deliberate');
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
  const session = await WSession.start({ label: `google-authenticator-enrol-${loginItem}`, browser: 'chromium', headless: false });
  const page = session.page;
  const wait = (seconds) => session.wait(seconds);
  try {
    const signedIn = await signIn(page, wait, login);
    if (!signedIn.ok) {
      report({ ok: false, login_item: loginItem, email: login.email, ...signedIn });
      process.exit(3);
    }
    const opened = await openAuthenticatorSetup(page, wait, NAV_TIMEOUT_MS);
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
