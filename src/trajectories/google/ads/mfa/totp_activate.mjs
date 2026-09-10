// Activate a Google Authenticator setup key for the Google Ads account.
// Uses Weles browser automation only; password and MFA material come from the dedicated Google Ads Skarbiec item.

import { writeFileSync } from 'node:fs';
import { WSession } from '../../../../../dist/session/wsession.js';
import { assertGoogleAdsProfileNotAlreadyOpen, closeAllowedByEnv } from '../_profile_guard.mjs';
import { EMAIL, GOOGLE_ADS_LOGIN, RESULT_FILE, USER_DATA_DIR, redact, stableProfilePersona } from './totp_activate/settings.mjs';
import { diag } from './totp_activate/page.mjs';
import { activateAuthenticator, openAuthenticatorSetup } from './totp_activate/authenticator.mjs';

async function main() {

  const creds = GOOGLE_ADS_LOGIN;
  if (!creds?.password || !creds?.totpSecret) {
    const report = {
      ok: false,
      blocked: 'missing_google_ads_password_or_totp_secret',
      email: EMAIL,
      hasPassword: Boolean(creds?.password),
      hasTotpSecret: Boolean(creds?.totpSecret),
    };
    writeFileSync(RESULT_FILE, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    process.exit(2);
  }

  assertGoogleAdsProfileNotAlreadyOpen(USER_DATA_DIR, 'google_totp_activate');
  const s = await WSession.start({
    label: 'google_totp_activate',
    browser: process.env.BROWSER || 'chromium',
    proxy: process.env.PROXY_URL || 'direct',
    persona: stableProfilePersona(),
    userDataDir: USER_DATA_DIR,
    pageDiagnostics: process.env.WELES_PAGE_DIAGNOSTICS === '1',
  });

  try {
    const opened = await openAuthenticatorSetup(s, creds);
    if (!opened.ok) {
      await diag(s.page, 'open_failed', creds.totpSecret);
      const report = { ok: false, email: EMAIL, ...opened };
      writeFileSync(RESULT_FILE, JSON.stringify(report, null, 2));
      console.log(JSON.stringify(report, null, 2));
      process.exit(3);
    }
    const activation = await activateAuthenticator(s, creds);
    const report = { email: EMAIL, ...activation, resultFile: RESULT_FILE };
    writeFileSync(RESULT_FILE, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (!activation.ok) process.exit(4);
    console.log('PASS: Google Authenticator TOTP setup activated');
  } finally {
    if (closeAllowedByEnv('GOOGLE_TOTP_ACTIVATION_CLOSE_AFTER')) await s.close().catch(() => {});
    else console.log('[google-totp-activate] leaving Google Ads profile open');
  }
}

main().catch((error) => {
  const report = {
    ok: false,
    blocked: 'google_totp_activation_error',
    email: EMAIL,
    error: redact(String(error?.message || error)),
  };
  writeFileSync(RESULT_FILE, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(1);
});
