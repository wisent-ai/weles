import { pageSettled } from '../_shared/page/settled.mjs';
// Canonical Apple ID login. Three one-use Skarbiec capabilities permit the
// email, password and 2FA operations; Stado owns execution and placement.

import { WSession } from '../../../dist/session/wsession.js';
import {
  cancelCapability,
  withCapability,
} from '../../../dist/utils/capability.js';
import { parseAppleLoginCapabilities } from '../../../dist/utils/identity/apple-login-capabilities.js';
import { completeAppleTwoFactorChallenge } from './two_factor.mjs';
import { getSocialAccount } from '../../../dist/utils/credentials.js';
import {
  preflightAppleChallengeRelay,
  relayAppleChallenge,
} from '../../auth/apple-account-placement.mjs';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// A Stado queue job id is eight hex characters; the Weles API names a run with
// a UUID and overwrites ACTION_LOG_ID with it after params are mapped, so a
// caller cannot choose. Accept either — both identify exactly one run — rather
// than refuse the only dispatch path Stado actually uses.
const JOB_PATTERN = /^(?:[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
// The item the worker selected by role; its id carries no meaning, only shape.
const ACCOUNT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const guardId = (process.env.APPLE_AUTH_GUARD_ID?.trim() ?? '').toLowerCase();
const accountId = process.env.WELES_LOGIN_ITEM?.trim() ?? '';
const actionLogId = process.env.ACTION_LOG_ID?.trim() ?? '';
if (!UUID_PATTERN.test(guardId)) throw new Error('[apple-login] APPLE_AUTH_GUARD_ID must be a valid UUID');
if (!ACCOUNT_PATTERN.test(accountId)) throw new Error('[apple-login] WELES_LOGIN_ITEM must hold the item the worker selected for the Apple account role');
if (!JOB_PATTERN.test(actionLogId)) throw new Error('[apple-login] ACTION_LOG_ID must be a Stado job id');

const LOGIN_URL = 'https://appstoreconnect.apple.com/login?targetUrl=%2Fapps&authResult=FAILED';
let capabilities = null;
let capabilityRefs = [];

function isDashboardUrl(url) {
  return url.includes('appstoreconnect.apple.com') && !url.includes('/login') && !url.includes('idmsa');
}

/** Whichever comes first of the dashboard, the 2FA prompt or a refusal. */
async function waitForPostPasswordState(session, frame) {
  const page = session.page;
  const twoFactorSelector = 'input[aria-label*="digit"], input[aria-label*="Digit"], input[id*="char"], input[type="tel"][maxlength="1"]';
  const explicitFailure = /incorrect|verification failed|account (?:is |has been )?locked|unable to sign in|sign[ -]?in failed/i;
  return Promise.any([
    page.waitForURL((url) => isDashboardUrl(String(url))).then(() => 'dashboard'),
    frame.locator(twoFactorSelector).first().waitFor({ state: 'visible' }).then(() => 'two_factor'),
    page.getByText(/Two-Factor Authentication|verification code sent to your Apple devices/i).first().waitFor({ state: 'visible' }).then(() => 'two_factor'),
    frame.getByText(explicitFailure).first().waitFor({ state: 'visible' }).then(() => 'failed'),
    page.getByText(explicitFailure).first().waitFor({ state: 'visible' }).then(() => 'failed'),
  ]);
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


console.log(`[apple-login] canonical one-attempt login for account ${accountId}`);
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
  // Resolve the live holder, its exact macOS user, this worker's broker and
  // the installed Stado relay before opening a browser or spending a password
  // attempt. This preflight reads state only and opens no native prompt.
  const preflightAccount = await getSocialAccount('apple');
  const preflightIdentity =
    (preflightAccount?.metadata?.email ?? preflightAccount?.username ?? '').trim();
  const challengeRoute = preflightAppleChallengeRelay(preflightIdentity, guardId);
  console.log(
    `[apple-login] Apple challenge route ${challengeRoute.holder}/${challengeRoute.user} `
    + `-> ${challengeRoute.destination}`,
  );
  s = await WSession.start({ label: 'apple_login', headless: process.env.WELES_HEADLESS === '1' });
  sessionClosed = false;
  // The unauthenticated root shell references protected /access/static assets.
  // ASC redirects those asset requests to HTML login responses, so the shell
  // cannot bootstrap and never inserts the idmsa iframe. Load the login
  // document directly.
  await s.page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
  await pageSettled(s.page);

  const authFrame = await s.page.waitForSelector('iframe[src*="idmsa.apple.com"]');
  const frame = await authFrame.contentFrame();
  if (!frame) throw new Error('could not access auth iframe');

  // Step 1: fill email (Apple ID)
  console.log('[apple-login] > waitForSelector email');
  const emailField = frame.locator('#account_name_text_field');
  await emailField.waitFor({ state: 'visible' });
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
      hit: hit?.outerHTML ?? null,
      field: el.outerHTML,
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
  await pageSettled(s.page);

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
    await pageSettled(s.page);
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
  await frame.waitForFunction(() => {
    const button = document.querySelector('#sign-in');
    return button && !button.disabled && button.getAttribute('aria-disabled') !== 'true';
  });

  // Playwright's actionability-checked click hangs on Apple's Angular-bound
  // Sign In control, so submit the validated form with a DOM click.
  await frame.locator('#sign-in').evaluate((button) => button.click());
  console.log('[apple-login] submitted exactly one authorized password attempt');

  const postPasswordState = await waitForPostPasswordState(s, frame);
  if (postPasswordState === 'failed') throw new Error('Apple rejected the guarded login attempt');

  if (postPasswordState === 'two_factor') {
    // Stado captures in the verified account holder's Aqua session and writes
    // the digits straight into this worker's already-authorized broker resource;
    // the relay returns only once they are stored, so one redeem reads them.
    // Weles sees only the one-use capability value and clears it after filling.
    relayAppleChallenge(preflightIdentity, guardId);
    const twoFactor = await completeAppleTwoFactorChallenge(s, frame, {
      logPrefix: '[apple-login]',
      withCode: (consume) => withCapability(
        capabilities.two_factor.capability,
        {
          purpose: 'weles.apple.2fa',
          resource: `challenge:apple/${guardId}`,
          authorization_id: guardId,
        },
        consume,
      ),
    });
    if (!twoFactor.ok) {
      throw new Error(`Apple 2FA did not complete (${twoFactor.source || 'unknown source'})`);
    }
  }

  if (postPasswordState !== 'dashboard') {
    await s.page.waitForURL((url) => isDashboardUrl(String(url)));
  }

  const dashboardUrl = new URL(s.page.url?.() ?? '');
  dashboardPostcondition = `Authenticated App Store Connect dashboard observed at origin=${dashboardUrl.origin} pathname=${dashboardUrl.pathname}; URL excluded /login and idmsa`;

  await s.close();
  sessionClosed = true;
  await cancelSessionCapabilities();
  console.log(`PASS: ${dashboardPostcondition}`);
  process.exitCode = 0;
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
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
