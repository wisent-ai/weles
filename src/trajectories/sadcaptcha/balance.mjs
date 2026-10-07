// SadCaptcha balance check via native username+password form. No Google SSO
// offered. If service_credentials lacks creds, surface blocker.
import { getServiceLogin } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import {
  parseBalanceFromText,
  patchServiceBalance,
} from '../_shared/services/google_sso.mjs';
import { pageSettled } from '../_shared/page/settled.mjs';
import { submitLoginForm } from '../_shared/services/native_login/submit.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runRecordingsDir } from '../../../dist/session/run-recordings.js';

const LOGIN_URL = 'https://www.sadcaptcha.com/login';
const DASH_URL = 'https://www.sadcaptcha.com/dashboard';
const DISPLAY_NAME = 'SadCaptcha';

const login = await getServiceLogin(DISPLAY_NAME);
if (!login) {
  console.log(
    'FAIL: SadCaptcha row in service_credentials has no login_email/login_password. SadCaptcha login is native form only — no Google SSO, no Discord OAuth. Register an account at sadcaptcha.com/register and PATCH the row with login_email + login_password before this trajectory can scrape.',
  );
  process.exit(1);
}
console.log(`[trajectory] Using service login: ${login.email}`);

const s = await WSession.start({
  label: 'sadcaptcha_balance',
  browser: 'chromium',
});
try {
  await s.goto(LOGIN_URL);

  const userIn = s.page
    .locator('input[name="username"], input[type="email"]')
    .filter({ visible: true })
    .first();
  await userIn.waitFor({ state: 'visible' });
  await userIn.click();
  await userIn.pressSequentially(login.email);

  const pwIn = s.page
    .locator('input[name="password"], input[type="password"]')
    .filter({ visible: true })
    .first();
  await pwIn.waitFor({ state: 'visible' });
  await pwIn.click();
  await pwIn.pressSequentially(login.password);
  await submitLoginForm(s.page, pwIn);

  const response = await s.page.goto(DASH_URL, {
    waitUntil: 'domcontentloaded',
  });
  if (!response)
    throw new Error(`SADCAPTCHA_DASHBOARD_RESPONSE_MISSING: ${s.page.url()}`);
  if (!response.ok())
    throw new Error(
      `SADCAPTCHA_DASHBOARD_HTTP_ERROR: HTTP ${response.status()} at ${response.url()}`,
    );
  const responseError = await response.finished();
  if (responseError)
    throw new Error(`SADCAPTCHA_DASHBOARD_RESPONSE_FAILED: ${response.url()}`, {
      cause: responseError,
    });
  await pageSettled(s.page);
  if (
    new URL(s.page.url()).origin !== new URL(DASH_URL).origin ||
    new URL(s.page.url()).pathname !== new URL(DASH_URL).pathname
  ) {
    throw new Error(
      `SADCAPTCHA_DASHBOARD_DESTINATION_MISMATCH: requested ${DASH_URL}; observed ${s.page.url()}`,
    );
  }

  const text = await s.page.evaluate(() => document.body.innerText);
  const balance = parseBalanceFromText(text);
  if (balance == null) {
    const dir = runRecordingsDir('sadcaptcha_balance');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'dashboard-text.txt'), text);
    try {
      writeFileSync(join(dir, 'dashboard.html'), await s.page.content());
    } catch (error) {
      console.error('SADCAPTCHA_DIAGNOSTIC_HTML_FAILED:', error);
    }
    try {
      await s.page.screenshot({
        path: join(dir, 'dashboard.png'),
        fullPage: true,
      });
    } catch (error) {
      console.error('SADCAPTCHA_DIAGNOSTIC_SCREENSHOT_FAILED:', error);
    }
    throw new Error(
      `SADCAPTCHA_BALANCE_NOT_FOUND: no labelled USD balance at ${s.page.url()}; dashboard text saved to ${dir}`,
    );
  }
  console.log(`[trajectory] balance=$${balance}`);

  const patched = await patchServiceBalance(DISPLAY_NAME, balance);
  if (!patched)
    throw new Error(
      `SADCAPTCHA_BALANCE_NOT_PERSISTED: service record update did not succeed for ${DISPLAY_NAME}`,
    );
  console.log(`PASS: balance=$${balance} (persisted)`);
} catch (e) {
  console.error('FAIL:', e);
  process.exitCode = 1;
} finally {
  await s.close();
}
