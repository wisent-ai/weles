// Google Authenticator activation through the persistent Weles keeper.
// No CUA. No CDP attach. No short-lived WSession loop. The keeper owns the browser/profile.

import { assertScopedSecretWriter } from '../../../../_shared/scoped-secrets.mjs';
import { EMAIL, GOOGLE_ADS_LOGIN, RESULT_FILE, SESSION, SOCK, USER_DATA_DIR, writeResult } from './totp_keeper_activate/settings.mjs';
import { startKeeperIfNeeded, waitForKeeper } from './totp_keeper_activate/keeper.mjs';
import { activateSetup } from './totp_keeper_activate/setup.mjs';

async function main() {

  const creds = GOOGLE_ADS_LOGIN;
  if (!creds?.password || !creds?.totpSecret) {
    writeResult({ ok: false, blocked: 'missing_google_ads_password_or_totp_secret', email: EMAIL }, Number('2'));
  }
  assertScopedSecretWriter('googleAds');

  const started = startKeeperIfNeeded();
  if (!await waitForKeeper()) writeResult({ ok: false, blocked: 'keeper_not_ready', session: SESSION, socket: SOCK, started }, 3);

  const report = await activateSetup({ ...creds, email: EMAIL });
  report.session = SESSION;
  report.profile = USER_DATA_DIR;
  report.resultFile = RESULT_FILE;
  writeResult(report, report.ok ? 0 : 4);
}

main().catch((error) => {
  writeResult({ ok: false, blocked: 'google_totp_keeper_error', error: String(error?.message || error) }, 1);
});
