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
import { join } from 'node:path';
import { runOutputPath } from '#run-output';
import { closeOperatorRequest, openOperatorRequest } from '#operator-request';
import { WSession } from '../../../../dist/session/wsession.js';
import { readDocument, writeDocument } from '../../../../dist/state/skarbiec-records.js';
import {
  confirmSetupCode, openAuthenticatorSetup, redactKeys, revealSetupKey,
} from '../../_shared/services/google_sso/authenticator_enrol.mjs';
import {
  accountProfileDir, loginMaterial, signIn as signInAccount,
} from '../../_shared/services/google_sso/sign_in/account.mjs';

/** How long the operator has to approve Google's push prompt on the phone. */
const PUSH_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
const MILLISECONDS_PER_SECOND = 1000;
const NAV_TIMEOUT_MS = 60_000;
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

async function signIn(page, wait, login) {
  const signed = await signInAccount(page, wait, login);
  if (signed.ok || signed.blocked !== 'google_push_approval_required') return signed;
  // Google's push to the operator's phone: one approval, waited for once —
  // and the operator is actually told, instead of the run waiting in silence
  // and dying with a blocked verdict nobody saw.
  const request = openOperatorRequest({
    kind: 'google-push-approval',
    account: login.email,
    run: `google-authenticator-enrol ${login.loginItem}`,
    instruction: `Open the Gmail or Google app on your phone, find the "Is it you?" prompt for ${login.email} and tap Yes. Weles is signing that account in on this host to enrol an authenticator, and this is the only step it cannot do itself.`,
    deadlineSeconds: PUSH_APPROVAL_TIMEOUT_MS / MILLISECONDS_PER_SECOND,
  });
  console.log(`[google-authenticator-enrol] operator request ${request.id} opened; ${request.pages.some((attempt) => attempt.ok) ? 'the operator was paged' : 'nobody could be paged'}`);
  try {
    await page.waitForURL((url) => !/accounts\.google\.com/.test(String(url)), { timeout: PUSH_APPROVAL_TIMEOUT_MS });
  } catch (error) {
    if (error?.name !== 'TimeoutError') {
      closeOperatorRequest(request.id, false, `the run failed while waiting: ${String(error?.message || error)}`);
      throw error;
    }
    closeOperatorRequest(request.id, false, 'nobody approved the prompt before the deadline');
    return { ok: false, blocked: 'google_push_not_approved', url: page.url(), operator_request: request.id };
  }
  closeOperatorRequest(request.id, true, 'the prompt was approved and the session signed in');
  return { ok: true };
}

async function main() {
  const loginItem = String(process.env.WELES_LOGIN_ITEM || '').trim();
  if (!loginItem) {
    report({ ok: false, blocked: 'login_item_required', detail: 'WELES_LOGIN_ITEM must name the Skarbiec login item to enrol' });
    process.exit(2);
  }
  const login = loginMaterial(loginItem);
  // One persistent profile per GOOGLE ACCOUNT, not per login item: on
  // 2026-09-21 `claude-wisent-google-sso` stopped at `google_push_not_approved`
  // for an account already signed in from this host under another row.
  const userDataDir = accountProfileDir(login);
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
