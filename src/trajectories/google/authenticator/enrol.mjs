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
import { completeGooglePhoneApproval } from '../../_shared/services/google_sso/sign_in/challenge/phone.mjs';
import { WSession } from '../../../../dist/session/wsession.js';
import {
  readDocument,
  writeDocument,
} from '../../../../dist/state/skarbiec-records.js';
import {
  confirmSetupCode,
  onSignIn,
  openAuthenticatorSetup,
  redactKeys,
  revealSetupKey,
} from '../../_shared/services/google_sso/authenticator_enrol.mjs';
import {
  accountProfileDir,
  loginMaterial,
  pageDescription,
  signIn as signInAccount,
} from '../../_shared/services/google_sso/sign_in/account.mjs';

import { pageSettled } from '../../_shared/page/settled.mjs';
const RESULT_DIR = runOutputPath('google-authenticator-enrol');
const RESULT_FILE = join(RESULT_DIR, 'result.json');

// Every exit of this trajectory goes through here, so a missing directory
// turns each one into `ENOENT … /runs/google-authenticator-enrol/result.json`
// and the real verdict — including the refusals this flow is built to report —
// is replaced by a crash: the browser signs in and the run still dies at
// its first report. The directory is created here, where
// the file is written, rather than at import time, because the run output root
// is created per run.
function report(result) {
  mkdirSync(RESULT_DIR, { recursive: true });
  writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  return result;
}

// Each step that waits on Google's pages is a stage the run reports, so a run
// that stands still names the step it stands in.
function mark(stage) {
  process.stderr.write(`STEP ${stage}\n`);
}

async function signIn(page, wait, login) {
  mark('google_sign_in');
  const signed = await signInAccount(page, wait, login);
  if (signed.ok || signed.blocked !== 'google_push_approval_required')
    return signed;
  mark('google_phone_approval');
  await completeGooglePhoneApproval(
    page,
    login.email,
    `google-authenticator-enrol ${login.loginItem}`,
  );
  mark('google_phone_approved');
  if (onSignIn(page.url())) {
    return {
      ok: false,
      blocked: 'google_sign_in_requires_action',
      ...(await pageDescription(page)),
    };
  }
  return { ok: true };
}

/**
 * Reach the authenticator setup page, signing in whenever Google asks. After
 * the first sign-in Google asks again ("Verify it's you", the password once
 * more) before it shows a security setting, so the page is reopened after
 * each sign-in. It ends when Google asks again at an address it already
 * asked at after a sign-in: signing in once more there cannot change its
 * answer. Run 5a61d47d stopped at `google_sign_in_required` right after the
 * operator's phone approval, because the page was reopened only once.
 */
async function openSignedIn(page, wait, login) {
  const asked = new Set();
  for (;;) {
    const opened = await openAuthenticatorSetup(page, wait);
    if (opened.ok || opened.blocked !== 'google_sign_in_required') return opened;
    const at = page.url();
    if (asked.has(at)) return opened;
    asked.add(at);
    const signedIn = await signIn(page, wait, login);
    if (!signedIn.ok) return signedIn;
    mark('authenticator_setup_reopen');
  }
}

async function main() {
  const loginItem = String(process.env.WELES_LOGIN_ITEM || '').trim();
  if (!loginItem) {
    report({
      ok: false,
      blocked: 'login_item_required',
      detail: 'WELES_LOGIN_ITEM must name the Skarbiec login item to enrol',
    });
    process.exitCode = 2;
    return;
  }
  const login = loginMaterial(loginItem);
  // One persistent profile per GOOGLE ACCOUNT, not per login item: a profile
  // per item stops at `google_push_not_approved` for an account already
  // signed in from this host under another row.
  const userDataDir = accountProfileDir(login);
  const session = await WSession.start({
    label: `google-authenticator-enrol-${loginItem}`,
    browser: 'chromium',
    headless: false,
    userDataDir,
  });
  const page = session.page;
  const wait = () => pageSettled(page);
  try {
    mark('authenticator_setup_open');
    const opened = await openSignedIn(page, wait, login);
    if (!opened.ok) {
      report({
        ok: false,
        login_item: loginItem,
        email: login.email,
        ...opened,
      });
      process.exitCode = 4;
      return;
    }
    mark('authenticator_key_reveal');
    const revealed = await revealSetupKey(page, wait);
    if (!revealed.ok) {
      report({
        ok: false,
        login_item: loginItem,
        email: login.email,
        ...revealed,
      });
      process.exitCode = 5;
      return;
    }
    mark('authenticator_code_confirm');
    const confirmed = await confirmSetupCode(page, wait, revealed.secret);
    if (!confirmed.ok) {
      report({
        ok: false,
        login_item: loginItem,
        email: login.email,
        ...confirmed,
      });
      process.exitCode = 6;
      return;
    }
    // Google accepted the first code: the seed is live. Write it beside the
    // password and read it back, so the vault and the account agree.
    mark('authenticator_seed_write');
    const current = readDocument(loginItem);
    current.fields = { ...current.fields, totp_secret: revealed.secret };
    writeDocument(loginItem, current);
    const stored = String(readDocument(loginItem).fields?.totp_secret || '');
    if (stored !== revealed.secret) {
      report({
        ok: false,
        login_item: loginItem,
        email: login.email,
        blocked: 'seed_persist_unconfirmed',
        detail: 'Skarbiec did not return the seed just written',
      });
      process.exitCode = 7;
      return;
    }
    report({
      ok: true,
      login_item: loginItem,
      email: login.email,
      seed_written: true,
      url: confirmed.url,
    });
  } finally {
    await session.close();
  }
}

main().catch((error) => {
  report({
    ok: false,
    blocked: error?.code || 'google_authenticator_enrol_error',
    error: redactKeys(String(error?.message || error)),
  });
  process.exitCode = 1;
});
