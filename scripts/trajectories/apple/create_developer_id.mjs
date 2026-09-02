// Apple Developer ID Application certificate creation.
// One-use Skarbiec capabilities authorize email, password and 2FA; Stado owns
// execution and placement.

import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WSession } from '../../../dist/session/wsession.js';
import { withCapability, withCapabilityPendingRetry, cancelCapability } from '../../../dist/utils/capability.js';
import { parseAppleLoginCapabilities } from '../../../dist/utils/apple-login-capabilities.js';
import { completeAppleNativeTwoFactorChallenge } from './native_2fa/native_2fa.mjs';
import { getSocialAccount } from '../../../dist/utils/credentials.js';
import { appleChallengeRelayTarget } from '../../auth/apple-account-placement.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Eight hex from the Stado queue, or the UUID the Weles API assigns and then
// forces into ACTION_LOG_ID. Both name one run; refusing the second one meant
// refusing every run Stado dispatches.
const JOB = /^(?:[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const ACCOUNT = /^weles-apple-[a-z0-9][a-z0-9-]{0,126}-account$/;
const guardId = (process.env.APPLE_AUTH_GUARD_ID?.trim() ?? '').toLowerCase();
const accountId = process.env.WELES_LOGIN_ITEM?.trim() ?? '';
const actionLogId = process.env.ACTION_LOG_ID?.trim() ?? '';
if (!UUID.test(guardId)) throw new Error('[apple-create-developer-id] invalid guard id');
if (!ACCOUNT.test(accountId)) throw new Error('[apple-create-developer-id] invalid Apple account item');
if (!JOB.test(actionLogId)) throw new Error('[apple-create-developer-id] invalid Stado job id');

const csrPath = process.env.APPLE_CSR_PATH?.trim() ?? '';
const certificatePath = process.env.APPLE_CERTIFICATE_PATH?.trim() ?? '';
if (!isAbsolute(csrPath)) throw new Error('[apple-create-developer-id] APPLE_CSR_PATH must be absolute');
if (!isAbsolute(certificatePath)) throw new Error('[apple-create-developer-id] APPLE_CERTIFICATE_PATH must be absolute');

const ADD_URL = 'https://developer.apple.com/account/resources/certificates/add';
const challengeResource = `challenge:apple/${guardId}`;
let capabilities = null;
let capabilityRefs = [];

function isDevPortalUrl(url) {
  return /developer\.apple\.com\/account/.test(url) && !/idmsa|\/login/.test(url);
}

async function waitForPostPasswordState(session, frame, attempts = 30) {
  const twoFactorSelector = 'input[aria-label*="digit"], input[aria-label*="Digit"], input[id*="char"], input[type="tel"][maxlength="1"]';
  const explicitFailure = /incorrect|verification failed|account (?:is |has been )?locked|unable to sign in|sign[ -]?in failed/i;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (isDevPortalUrl(session.page.url?.() ?? '')) return 'dashboard';
    const twoFactorVisible = await frame.locator(twoFactorSelector).first().isVisible().catch(() => false)
      || await session.page.getByText(/Two-Factor Authentication|verification code sent to your Apple devices/i).first().isVisible().catch(() => false);
    if (twoFactorVisible) return 'two_factor';
    const failureVisible = await frame.getByText(explicitFailure).first().isVisible().catch(() => false)
      || await session.page.getByText(explicitFailure).first().isVisible().catch(() => false);
    if (failureVisible) return 'failed';
    await session.wait(1);
  }
  return 'timeout';
}

async function cancelSessionCapabilities() {
  if (capabilityRefs.length !== 3) throw new Error('capability cleanup unavailable');
  const failures = [];
  for (const capability of capabilityRefs) {
    try { await cancelCapability(capability.capability_id, guardId); }
    catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
  }
  if (failures.length > 0) throw new Error(`capability cleanup unconfirmed: ${failures.join('; ')}`);
}

// Ask the machine that holds the account to catch the prompt and put the digits in
// Skarbiec. Nothing comes back through here: this returns once the code is stored.
//
// The program is the one shipped beside this trajectory, found relative to this
// module rather than named by an environment variable. APPLE_2FA_RELAY_COMMAND was
// an absolute path written into one host's configuration, which is a second way of
// saying where this installation is -- and the way that goes stale when the release
// symlink moves. Resolving it from `import.meta.url` cannot point outside the release
// currently running, which is a stronger guarantee than the mode bits it replaced.
function requestTrustedMacChallengeRelay() {
  const command = fileURLToPath(new URL('../../auth/request-apple-challenge-relay.mjs', import.meta.url));
  const stat = statSync(command);
  if (!stat.isFile() || (stat.mode & 0o022) !== 0
      || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new Error('the Apple challenge relay must be a non-writable file owned by the worker');
  }
  // Run it through this same interpreter. Spawning the file directly would also
  // require an executable bit to survive packaging, which is a property of how the
  // release was built rather than of whether the relay is intact.
  const result = spawnSync(process.execPath, [command, '--guard-id', guardId, '--account-id', accountId, '--action-log-id', actionLogId], {
    cwd: process.cwd(), env: process.env, encoding: 'utf8',
    timeout: Number(process.env.WELES_APPLE_2FA_RELAY_TIMEOUT_MS ?? '75000'),
    maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) throw new Error('Trusted Mac Apple challenge relay failed closed');
  let ack;
  try { ack = JSON.parse(result.stdout); } catch { throw new Error('Relay returned invalid acknowledgement'); }
  if (!ack || ack.status !== 'stored' || ack.resource !== challengeResource) {
    throw new Error('Relay did not confirm the active authorization resource');
  }
}

// --- Cert creation helpers ---

async function clickChoice(page, pattern) {
  for (const locator of [
    page.getByText(pattern, { exact: true }).first(),
    page.getByRole('radio', { name: pattern }).first(),
    page.getByRole('button', { name: pattern }).first(),
    page.getByRole('link', { name: pattern }).first(),
  ]) {
    if (await locator.isVisible().catch(() => false)) { await locator.click(); return true; }
  }
  return false;
}

async function clickButton(page, pattern) {
  for (const locator of [page.getByRole('button', { name: pattern }).first(), page.getByText(pattern, { exact: true }).first()]) {
    if (await locator.isVisible().catch(() => false)) { await locator.click(); return true; }
  }
  return false;
}

// --- Main flow ---

console.log(`[apple-create-developer-id] account ${accountId}, CSR ${csrPath}`);
let passwordSubmitted = false;
let authorizationClosed = false;
let sessionClosed = true;
let s = null;
try {
  capabilities = parseAppleLoginCapabilities(process.env.APPLE_LOGIN_CAPABILITIES_JSON, guardId);
  capabilityRefs = [capabilities.email, capabilities.password, capabilities.two_factor.capability];

  s = await WSession.start({ label: 'apple_create_developer_id', headless: process.env.WELES_HEADLESS === '1' });
  sessionClosed = false;
  await s.page.goto(ADD_URL, { waitUntil: 'domcontentloaded', timeout: Number(process.env.WELES_APPLE_NAV_TIMEOUT_MS ?? '60000') });
  await s.wait(5);

  // --- Apple ID authentication (same guard/capability flow as login.mjs) ---
  const authFrame = await s.page.waitForSelector('iframe[src*="idmsa.apple.com"]', { timeout: 30_000 }).catch(() => null);
  if (!authFrame) throw new Error('no idmsa auth iframe found');
  const frame = await authFrame.contentFrame();
  if (!frame) throw new Error('could not access auth iframe');

  const emailField = frame.locator('#account_name_text_field');
  await emailField.waitFor({ state: 'visible', timeout: 15_000 });
  const emailLength = await withCapability(capabilities.email, {
    purpose: 'weles.browser.fill', resource: 'origin:https://idmsa.apple.com/email', authorization_id: guardId,
  }, async (email) => {
    await emailField.focus();
    await emailField.pressSequentially(email);
    await emailField.press('Enter');
    return email.length;
  });
  await s.wait(5);

  const continuePassword = frame.locator('#continue-password');
  const signInButton = frame.locator('#sign-in');
  const legacyContinueVisible = await continuePassword.isVisible().catch(() => false);
  const signInLabel = await signInButton.innerText().catch(() => '');
  if (legacyContinueVisible || signInLabel.trim() === 'Continue') {
    await (legacyContinueVisible ? continuePassword : signInButton).click();
    await s.wait(4);
  }

  const passwordSelectors = ['#password_text_field', 'input[type="password"]', 'input[name="password"]', 'input[aria-label*="assword"]'];
  let passwordField = null;
  for (const selector of passwordSelectors) {
    const candidate = frame.locator(selector).first();
    if (await candidate.isVisible().catch(() => false)) { passwordField = candidate; break; }
  }
  if (!passwordField) throw new Error('password field not found');

  const passwordLength = await withCapability(capabilities.password, {
    purpose: 'weles.browser.fill', resource: 'origin:https://idmsa.apple.com/password', authorization_id: guardId,
  }, async (password) => {
    await passwordField.focus();
    await passwordField.pressSequentially(password);
    await passwordField.evaluate((input) => {
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.blur();
    });
    return password.length;
  });

  const formState = await frame.evaluate(({ expectedEmailLength, expectedPasswordLength }) => {
    const email = document.querySelector('#account_name_text_field');
    const password = document.querySelector('#password_text_field');
    const signIn = document.querySelector('#sign-in');
    return {
      emailLength: email?.value.length ?? -1, expectedEmailLength,
      passwordLength: password?.value.length ?? -1, expectedPasswordLength,
      disabled: signIn?.disabled ?? null,
    };
  }, { expectedEmailLength: emailLength, expectedPasswordLength: passwordLength });
  if (formState.emailLength !== emailLength || formState.passwordLength !== passwordLength) throw new Error('typed credential length mismatch');

  const signInEnabled = await frame.waitForFunction(() => {
    const button = document.querySelector('#sign-in');
    return button && !button.disabled && button.getAttribute('aria-disabled') !== 'true';
  }, null, { timeout: 10_000 }).then(() => true).catch(() => false);
  if (!signInEnabled) throw new Error('Apple password form stayed disabled after credential entry');

  passwordSubmitted = true;
  await frame.locator('#sign-in').click();
  console.log('[apple-create-developer-id] submitted one authorized password attempt');

  const postPasswordState = await waitForPostPasswordState(s, frame);
  if (postPasswordState === 'failed') throw new Error('Apple rejected the guarded login attempt');
  if (postPasswordState === 'timeout') throw new Error('Timed out waiting for developer portal or 2FA challenge');

  if (postPasswordState === 'two_factor') {
    // Whether this prompt needs relaying is a fact about the fleet, not a setting, so
    // it is asked rather than configured: the registry knows which host is signed into
    // this account and which host this is. A `relayConfigured` flag in one host's env
    // said the same thing by hand, and kept saying it after the answer changed.
    const account = await getSocialAccount('apple');
    const relayTarget = appleChallengeRelayTarget((account?.metadata?.email ?? account?.username ?? '').trim());
    const twoFactorOptions = {
      logPrefix: '[apple-create-developer-id]',
      ...(relayTarget ? {
        nativeOnly: true,
        withCode: (consume) => withCapabilityPendingRetry(capabilities.two_factor.capability, {
          purpose: 'weles.apple.2fa', resource: challengeResource, authorization_id: guardId,
        }, async (code) => consume(code), {
          timeoutMs: Number(process.env.WELES_APPLE_2FA_PENDING_TIMEOUT_MS ?? '120000'),
          intervalMs: Number(process.env.WELES_APPLE_2FA_PENDING_INTERVAL_MS ?? '1000'),
        }),
      } : {}),
    };
    if (relayTarget) requestTrustedMacChallengeRelay();
    const twoFactor = await completeAppleNativeTwoFactorChallenge(s, frame, twoFactorOptions);
    if (!twoFactor.ok) throw new Error(`Apple 2FA did not complete (${twoFactor.source || 'unknown source'})`);
  }

  // --- Developer portal: navigate to certificate add page ---
  let portalObserved = postPasswordState === 'dashboard';
  for (let attempt = 0; !portalObserved && attempt < 30; attempt += 1) {
    portalObserved = isDevPortalUrl(s.page.url?.() ?? '');
    if (!portalObserved) await s.wait(1);
  }
  if (!portalObserved) throw new Error(`did not reach developer portal, still at ${s.page.url()}`);

  await s.page.goto(ADD_URL, { waitUntil: 'domcontentloaded', timeout: Number(process.env.WELES_APPLE_NAV_TIMEOUT_MS ?? '60000') });
  await s.wait(6);

  if (!/developer\.apple\.com\/account\/resources\/certificates\/add/.test(s.page.url())) {
    throw new Error(`certificate add page unavailable at ${s.page.url()}`);
  }
  console.log('[apple-create-developer-id] CERTIFICATE_TYPE_PAGE');

  if (!(await clickChoice(s.page, /^Developer ID Application$/i))) {
    const text = (await s.page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 1000);
    throw new Error(`Developer ID Application choice missing; page=${text}`);
  }
  await s.wait(1);
  if (!(await clickButton(s.page, /^continue$/i))) throw new Error('certificate type Continue control missing');
  await s.wait(4);

  const fileInput = s.page.locator('input[type="file"]').first();
  await fileInput.waitFor({ state: 'attached', timeout: 20_000 });
  await fileInput.setInputFiles(csrPath);
  console.log('[apple-create-developer-id] CSR_UPLOADED');
  await s.wait(1);
  if (!(await clickButton(s.page, /^continue$/i))) throw new Error('CSR Continue control missing');
  await s.wait(6);

  const downloadPromise = s.page.waitForEvent('download', { timeout: 120_000 });
  if (!(await clickButton(s.page, /download/i))) throw new Error('certificate Download control missing');
  const download = await downloadPromise;
  await download.saveAs(certificatePath);
  console.log(`[apple-create-developer-id] CERTIFICATE_SAVED=${certificatePath}`);

  authorizationClosed = true;
} catch (error) {
  console.error(`FAIL=${error instanceof Error ? error.message.slice(0, 1200) : String(error).slice(0, 1200)}`);
  try { await cancelSessionCapabilities(); } catch {}
  process.exitCode = 1;
} finally {
  if (s && !sessionClosed) { await s.close().catch(() => {}); sessionClosed = true; }
}
process.exit(process.exitCode ?? 0);
