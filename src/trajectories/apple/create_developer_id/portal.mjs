import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/** A worker-side path from the environment: absolute, or ~/ expanded. */
export function absoluteWorkerPath(raw, variable) {
  const value = String(raw ?? '').trim();
  const expanded = value.startsWith('~/')
    ? join(homedir(), value.slice(2))
    : value;
  if (!isAbsolute(expanded)) {
    throw new Error(
      `[apple-create-developer-id] ${variable} must be absolute or start with ~/`,
    );
  }
  return expanded;
}

export function isDevPortalUrl(url) {
  return (
    /developer\.apple\.com\/account/.test(url) && !/idmsa|\/login/.test(url)
  );
}

// `signInStatus` reads the status Apple answered `signin/complete` with. The DOM
// was the only witness here and it is the weaker one: Apple renders the refusal
// inside the widget iframe, and in a headless context the refusal text is never
// `isVisible`, so a rejected password used to read as no answer at all while
// the answer had been 401 within a second of the click. The state is whichever
// of the portal, the 2FA prompt, the refusal status or the refusal text comes
// first; nothing here counts polls.
export async function waitForPostPasswordState(session, frame, signInStatus) {
  const page = session.page;
  const refused = (status) => status === 401 || status === 403;
  if (refused(signInStatus())) return 'rejected';
  const twoFactorSelector =
    'input[aria-label*="digit"], input[aria-label*="Digit"], input[id*="char"], input[type="tel"][maxlength="1"]';
  const explicitFailure =
    /incorrect|verification failed|account (?:is |has been )?locked|unable to sign in|sign[ -]?in failed/i;
  return Promise.any([
    page
      .waitForURL((url) => isDevPortalUrl(String(url)))
      .then(() => 'dashboard'),
    frame
      .locator(twoFactorSelector)
      .first()
      .waitFor({ state: 'visible' })
      .then(() => 'two_factor'),
    page
      .getByText(
        /Two-Factor Authentication|verification code sent to your Apple devices/i,
      )
      .first()
      .waitFor({ state: 'visible' })
      .then(() => 'two_factor'),
    page
      .waitForResponse(
        (response) =>
          response.url().includes('/appleauth/auth/signin/complete') &&
          refused(response.status()),
      )
      .then(() => 'rejected'),
    frame
      .getByText(explicitFailure)
      .first()
      .waitFor({ state: 'visible' })
      .then(() => 'failed'),
    page
      .getByText(explicitFailure)
      .first()
      .waitFor({ state: 'visible' })
      .then(() => 'failed'),
  ]);
}

/** Click the first visible text, radio, button or link matching the pattern. */
export async function clickChoice(page, pattern) {
  for (const locator of [
    page.getByText(pattern, { exact: true }).first(),
    page.getByRole('radio', { name: pattern }).first(),
    page.getByRole('button', { name: pattern }).first(),
    page.getByRole('link', { name: pattern }).first(),
  ]) {
    if (await locator.isVisible().catch(() => false)) {
      await locator.click();
      return true;
    }
  }
  return false;
}

/** Click the first visible button or exact text matching the pattern. */
export async function clickButton(page, pattern) {
  for (const locator of [
    page.getByRole('button', { name: pattern }).first(),
    page.getByText(pattern, { exact: true }).first(),
  ]) {
    if (await locator.isVisible().catch(() => false)) {
      await locator.click();
      return true;
    }
  }
  return false;
}
