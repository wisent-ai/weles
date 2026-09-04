// Canonical Apple ID login. Three one-use Skarbiec capabilities permit the
// email, password and 2FA operations; Stado owns execution and placement.

import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WSession } from '../../../dist/session/wsession.js';
import { cancelCapability, withCapability, withCapabilityPendingRetry } from '../../../dist/utils/capability.js';
import { parseAppleLoginCapabilities } from '../../../dist/utils/apple-login-capabilities.js';
import { completeAppleNativeTwoFactorChallenge } from './native_2fa/native_2fa.mjs';
import { getSocialAccount } from '../../../dist/utils/credentials.js';
import { appleChallengeRelayTarget } from '../../auth/apple-account-placement.mjs';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// A Stado queue job id is eight hex characters; the Weles API names a run with
// a UUID and overwrites ACTION_LOG_ID with it after params are mapped, so a
// caller cannot choose. Accept either — both identify exactly one run — rather
// than refuse the only dispatch path Stado actually uses.
const JOB_PATTERN = /^(?:[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const ACCOUNT_PATTERN = /^weles-apple-[a-z0-9][a-z0-9-]{0,126}-account$/;
const guardId = (process.env.APPLE_AUTH_GUARD_ID?.trim() ?? '').toLowerCase();
const accountId = process.env.WELES_LOGIN_ITEM?.trim() ?? '';
const actionLogId = process.env.ACTION_LOG_ID?.trim() ?? '';
if (!UUID_PATTERN.test(guardId)) throw new Error('[apple-login] APPLE_AUTH_GUARD_ID must be a valid UUID');
if (!ACCOUNT_PATTERN.test(accountId)) throw new Error('[apple-login] WELES_LOGIN_ITEM must name an Apple account');
if (!JOB_PATTERN.test(actionLogId)) throw new Error('[apple-login] ACTION_LOG_ID must be a Stado job id');

const LOGIN_URL = 'https://appstoreconnect.apple.com/login?targetUrl=%2Fapps&authResult=FAILED';
const challengeResource = `challenge:apple/${guardId}`;
let capabilities = null;
let capabilityRefs = [];

function isDashboardUrl(url) {
  return url.includes('appstoreconnect.apple.com') && !url.includes('/login') && !url.includes('idmsa');
}

async function waitForPostPasswordState(session, frame, attempts = 30) {
  const twoFactorSelector = 'input[aria-label*="digit"], input[aria-label*="Digit"], input[id*="char"], input[type="tel"][maxlength="1"]';
  const explicitFailure = /incorrect|verification failed|account (?:is |has been )?locked|unable to sign in|sign[ -]?in failed/i;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (isDashboardUrl(session.page.url?.() ?? '')) return 'dashboard';
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
  if (capabilityRefs.length !== 3) {
    throw new Error('capability cleanup unavailable because the Apple capability envelope was not validated');
  }
  const failures = [];
  for (const capability of capabilityRefs) {
    try {
      await cancelCapability(capability.capability_id, guardId);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (failures.length > 0) throw new Error(`capability cleanup unconfirmed: ${failures.join('; ')}`);
}

function requestTrustedMacChallengeRelay() {
  const command = fileURLToPath(new URL('../../auth/request-apple-challenge-relay.mjs', import.meta.url));
  const stat = statSync(command);
  if (!stat.isFile() || (stat.mode & 0o022) !== 0
      || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new Error('the Apple challenge relay must be a non-writable file owned by the worker');
  }
  const result = spawnSync(process.execPath, [
    command,
    '--guard-id', guardId,
    '--account-id', accountId,
    '--action-log-id', actionLogId,
  ], {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    timeout: Number(process.env.WELES_APPLE_2FA_RELAY_TIMEOUT_MS ?? '75000'),
    maxBuffer: 64 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) throw new Error('Trusted Mac Apple challenge relay failed closed');
  let acknowledgement;
  try { acknowledgement = JSON.parse(result.stdout); } catch {
    throw new Error('Trusted Mac Apple challenge relay returned invalid acknowledgement');
  }
  if (!acknowledgement || acknowledgement.status !== 'stored'
      || acknowledgement.resource !== `challenge:apple/${guardId}`) {
    throw new Error('Trusted Mac Apple challenge relay did not confirm the active authorization resource');
  }
}


console.log(`[apple-login] canonical one-attempt login for account ${accountId}`);
let passwordSubmitted = false;
let authorizationClosed = false;
let sessionClosed = true;
let dashboardPostcondition = '';
let s = null;
try {
  capabilities = parseAppleLoginCapabilities(process.env.APPLE_LOGIN_CAPABILITIES_JSON, guardId);
  capabilityRefs = [
    capabilities.email,
    capabilities.password,
    capabilities.two_factor.capability,
  ];
  s = await WSession.start({ label: 'apple_login', headless: process.env.WELES_HEADLESS === '1' });
  sessionClosed = false;
  // The unauthenticated root shell references protected /access/static assets.
  // ASC redirects those asset requests to HTML login responses, so the shell
  // cannot bootstrap and never inserts the idmsa iframe. Load the login
  // document directly, with bounded navigation, instead.
  await s.page.goto(LOGIN_URL, {
    waitUntil: 'domcontentloaded',
    timeout: Number(process.env.WELES_APPLE_NAV_TIMEOUT_MS ?? '60000'),
  });
  await s.wait(5);

  const authFrame = await s.page.waitForSelector('iframe[src*="idmsa.apple.com"]', { timeout: 30_000 }).catch(() => null);
  if (!authFrame) throw new Error('no idmsa auth iframe found');
  const frame = await authFrame.contentFrame();
  if (!frame) throw new Error('could not access auth iframe');

  // Step 1: fill email (Apple ID)
  console.log('[apple-login] > waitForSelector email');
  const emailField = frame.locator('#account_name_text_field');
  await emailField.waitFor({ state: 'visible', timeout: 15_000 });
  const emailActionability = await emailField.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return {
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
      disabled: el.disabled,
      readOnly: el.readOnly,
      hit: hit?.outerHTML.slice(0, 300) ?? null,
      field: el.outerHTML.slice(0, 300),
    };
  });
  console.log('[apple-login] email actionability:', JSON.stringify(emailActionability));
  // The Continue button (#sign-in) is Angular-bound and stays `disabled` until
  // the field validates; .fill() doesn't fire the keystroke it waits for, so
  // clicking it hangs. Submit via Enter instead — Apple's form advances on it.
  const emailLength = await withCapability(capabilities.email, {
    purpose: 'weles.browser.fill',
    resource: 'origin:https://idmsa.apple.com/email',
    authorization_id: guardId,
  }, async (email) => {
    console.log('[apple-login] > focus email');
    await emailField.focus();
    console.log('[apple-login] > type email');
    await emailField.pressSequentially(email);
    console.log('[apple-login] > submit email (Enter)');
    await emailField.press('Enter');
    return email.length;
  });
  console.log('[apple-login] email filled');
  await s.wait(5);

  // Step 2: Apple now shows a choice: "Continue with Password" / "Sign in with Passkey".
  // Click Continue with Password to reveal the password input.
  const continuePassword = frame.locator('#continue-password');
  const signInButton = frame.locator('#sign-in');
  console.log('[apple-login] > check continue-password');
  const legacyContinueVisible = await continuePassword.isVisible().catch(() => false);
  const signInLabel = await signInButton.innerText().catch(() => '');
  if (legacyContinueVisible || signInLabel.trim() === 'Continue') {
    await (legacyContinueVisible ? continuePassword : signInButton).click();
    console.log('[apple-login] clicked Continue with Password');
    await s.wait(4);
  }

  // Step 3: fill password — try known selectors in order
  const passwordSelectors = ['#password_text_field', 'input[type="password"]', 'input[name="password"]', 'input[aria-label*="assword"]'];
  let passwordField = null;
  console.log('[apple-login] > find password field');
  for (const selector of passwordSelectors) {
    const candidate = frame.locator(selector).first();
    if (await candidate.isVisible().catch(() => false)) { passwordField = candidate; break; }
  }
  if (!passwordField) throw new Error('password field not found');

  const passwordLength = await withCapability(capabilities.password, {
    purpose: 'weles.browser.fill',
    resource: 'origin:https://idmsa.apple.com/password',
    authorization_id: guardId,
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
  console.log('[apple-login] password filled');

  const formState = await frame.evaluate(({ expectedEmailLength, expectedPasswordLength }) => {
    const email = document.querySelector('#account_name_text_field');
    const password = document.querySelector('#password_text_field');
    const signIn = document.querySelector('#sign-in');
    return {
      emailLength: email?.value.length ?? -1,
      expectedEmailLength,
      passwordLength: password?.value.length ?? -1,
      expectedPasswordLength,
      disabled: signIn?.disabled ?? null,
    };
  }, { expectedEmailLength: emailLength, expectedPasswordLength: passwordLength });
  if (formState.emailLength !== emailLength || formState.passwordLength !== passwordLength) {
    throw new Error('typed credential length mismatch');
  }
  const signInEnabled = await frame.waitForFunction(() => {
    const button = document.querySelector('#sign-in');
    return button && !button.disabled && button.getAttribute('aria-disabled') !== 'true';
  }, null, { timeout: 10_000 }).then(() => true).catch(() => false);
  if (!signInEnabled) throw new Error('Apple password form stayed disabled after credential entry');

  passwordSubmitted = true;
  // Playwright's actionability-checked click hangs on Apple's Angular-bound
  // Sign In control, so submit the validated form with a DOM click.
  await frame.locator('#sign-in').evaluate((button) => button.click());
  console.log('[apple-login] submitted exactly one authorized password attempt');

  const postPasswordState = await waitForPostPasswordState(s, frame);
  if (postPasswordState === 'failed') throw new Error('Apple rejected the guarded login attempt');
  if (postPasswordState === 'timeout') throw new Error('Timed out waiting for Apple dashboard or 2FA challenge');

  if (postPasswordState === 'two_factor') {
    const account = await getSocialAccount('apple');
    const relayTarget = appleChallengeRelayTarget((account?.metadata?.email ?? account?.username ?? '').trim());
    const twoFactorOptions = {
      logPrefix: '[apple-login]',
      ...(relayTarget ? {
        nativeOnly: true,
        withCode: (consume) => withCapabilityPendingRetry(capabilities.two_factor.capability, {
          purpose: 'weles.apple.2fa',
          resource: challengeResource,
          authorization_id: guardId,
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

  let dashboardObserved = postPasswordState === 'dashboard';
  for (let attempt = 0; !dashboardObserved && attempt < 30; attempt += 1) {
    dashboardObserved = isDashboardUrl(s.page.url?.() ?? '');
    if (!dashboardObserved) await s.wait(1);
  }
  if (!dashboardObserved) throw new Error(`did not reach ASC dashboard, still at ${s.page.url?.()}`);
  const dashboardUrl = new URL(s.page.url?.() ?? '');
  dashboardPostcondition = `Authenticated App Store Connect dashboard observed at origin=${dashboardUrl.origin} pathname=${dashboardUrl.pathname}; URL excluded /login and idmsa`;

  await s.close();
  sessionClosed = true;
  await cancelSessionCapabilities();
  authorizationClosed = true;
  console.log(`PASS: ${dashboardPostcondition}`);
  process.exitCode = 0;
} catch (error) {
  const detail = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
  const cleanupFailures = [];
  if (!sessionClosed && s) {
    try { await s.close(); sessionClosed = true; } catch (closeError) {
      cleanupFailures.push(`browser close failed: ${closeError instanceof Error ? closeError.message : String(closeError)}`);
    }
  }
  try { await cancelSessionCapabilities(); } catch (cleanupError) {
    cleanupFailures.push(cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
  }
  console.log('FAIL:', detail);
  for (const failure of cleanupFailures) console.log('[apple-login] cleanup:', failure);
  process.exitCode = 1;
} finally {
  if (!sessionClosed && s) await s.close().catch(() => {});
}
