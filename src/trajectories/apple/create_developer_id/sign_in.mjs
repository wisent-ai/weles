import { withCapability, withCapabilityPendingRetry } from '../../../../dist/utils/capability.js';
import { completeAppleTwoFactorChallenge } from '../two_factor.mjs';
import { relayAppleChallenge } from '../../../auth/apple-account-placement.mjs';
import { AUTH_FRAME_WAIT_MS, EMAIL_FIELD_WAIT_MS, SIGN_IN_ENABLE_WAIT_MS, TWO_FACTOR_POLL_MS, TWO_FACTOR_WAIT_MS } from './constants.mjs';
import { waitForPostPasswordState } from './portal.mjs';

/** The idmsa sign-in iframe's frame, once it is on the page. */
async function authFrame(page) {
  const handle = await page.waitForSelector('iframe[src*="idmsa.apple.com"]', { timeout: AUTH_FRAME_WAIT_MS }).catch(() => false);
  if (!handle) throw new Error('no idmsa auth iframe found');
  const frame = await handle.contentFrame();
  if (!frame) throw new Error('could not access auth iframe');
  return frame;
}

/** Type the email under its capability and advance to the password step. */
async function enterEmail(s, frame, capability, guardId) {
  const emailField = frame.locator('#account_name_text_field');
  await emailField.waitFor({ state: 'visible', timeout: EMAIL_FIELD_WAIT_MS });
  const emailLength = await withCapability(capability, {
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
  const signInLabel = await signInButton.innerText().catch(() => 'unreadable');
  if (legacyContinueVisible || signInLabel.trim() === 'Continue') {
    await (legacyContinueVisible ? continuePassword : signInButton).click();
    await s.wait(4);
  }
  return emailLength;
}

/** Type the password under its capability; returns its length for the form check. */
async function enterPassword(frame, capability, guardId) {
  const passwordSelectors = ['#password_text_field', 'input[type="password"]', 'input[name="password"]', 'input[aria-label*="assword"]'];
  let passwordField = false;
  for (const selector of passwordSelectors) {
    const candidate = frame.locator(selector).first();
    if (await candidate.isVisible().catch(() => false)) { passwordField = candidate; break; }
  }
  if (!passwordField) throw new Error('password field not found');
  return withCapability(capability, {
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
}

/** Refuse to submit unless the form holds exactly what was typed and Apple enabled the button. */
async function assertFormReady(frame, emailLength, passwordLength) {
  const formState = await frame.evaluate(({ expectedEmailLength, expectedPasswordLength }) => {
    const email = document.querySelector('#account_name_text_field');
    const password = document.querySelector('#password_text_field');
    const signIn = document.querySelector('#sign-in');
    return {
      emailLength: email?.value.length ?? -1, expectedEmailLength,
      passwordLength: password?.value.length ?? -1, expectedPasswordLength,
      disabled: signIn?.disabled ?? 'no-button',
    };
  }, { expectedEmailLength: emailLength, expectedPasswordLength: passwordLength });
  if (formState.emailLength !== emailLength || formState.passwordLength !== passwordLength) throw new Error('typed credential length mismatch');
  const signInEnabled = await frame.waitForFunction(() => {
    const button = document.querySelector('#sign-in');
    return button && !button.disabled && button.getAttribute('aria-disabled') !== 'true';
  }, null, { timeout: SIGN_IN_ENABLE_WAIT_MS }).then(() => true).catch(() => false);
  if (!signInEnabled) throw new Error('Apple password form stayed disabled after credential entry');
}

/**
 * Sign into the Apple ID with the guarded email, password and two-factor
 * capabilities. Returns the post-password state ('dashboard' or 'two_factor')
 * and, after a challenge, the receipt of the relay that served the code.
 */
export async function signInWithCapabilities(s, { capabilities, guardId, identity }) {
  const frame = await authFrame(s.page);
  const emailLength = await enterEmail(s, frame, capabilities.email, guardId);
  const passwordLength = await enterPassword(frame, capabilities.password, guardId);
  await assertFormReady(frame, emailLength, passwordLength);

  // Attached before the click, because the answer can arrive before the first
  // poll. Only the status is kept: no header, no body, nothing that could carry
  // the credential into a log.
  let signInStatus = false;
  s.page.on('response', (response) => {
    try {
      if (response.url().includes('/appleauth/auth/signin/complete')) signInStatus = response.status();
    } catch { /* a response that cannot be read is not a verdict */ }
  });

  await frame.locator('#sign-in').click();
  console.log('[apple-create-developer-id] submitted one authorized password attempt');

  const postPasswordState = await waitForPostPasswordState(s, frame, () => signInStatus);
  if (postPasswordState === 'failed') throw new Error('Apple rejected the guarded login attempt');
  if (postPasswordState === 'rejected') {
    throw new Error(
      `Apple refused the sign-in with HTTP ${signInStatus}: the secret the broker resolved for `
      + 'origin:https://idmsa.apple.com/password is not this account\'s current password. '
      + 'The route names which vault field was read; nothing here can tell whether it is stale '
      + 'or wrong, and a second attempt spends another of Apple\'s few before it locks.',
    );
  }
  if (postPasswordState === 'timeout') throw new Error('Timed out waiting for developer portal or 2FA challenge');

  let twoFactorReceipt = false;
  if (postPasswordState === 'two_factor') {
    const relay = relayAppleChallenge(identity, guardId);
    const twoFactor = await completeAppleTwoFactorChallenge(s, frame, {
      logPrefix: '[apple-create-developer-id]',
      withCode: (consume) => withCapabilityPendingRetry(
        capabilities.two_factor.capability,
        {
          purpose: 'weles.apple.2fa',
          resource: `challenge:apple/${guardId}`,
          authorization_id: guardId,
        },
        consume,
        { timeoutMs: TWO_FACTOR_WAIT_MS, intervalMs: TWO_FACTOR_POLL_MS },
      ),
    });
    if (!twoFactor.ok) {
      throw new Error(`Apple 2FA did not complete (${twoFactor.source || 'unknown source'})`);
    }
    twoFactorReceipt = {
      authorization_id: guardId,
      holder: relay.holder,
      user: relay.user,
      destination: relay.destination,
      source: twoFactor.source,
    };
  }
  return { postPasswordState, twoFactorReceipt };
}
