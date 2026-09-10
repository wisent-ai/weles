import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { POST_PASSWORD_POLLS } from './constants.mjs';

/** A worker-side path from the environment: absolute, or ~/ expanded. */
export function absoluteWorkerPath(raw, variable) {
  const value = String(raw ?? '').trim();
  const expanded = value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
  if (!isAbsolute(expanded)) {
    throw new Error(`[apple-create-developer-id] ${variable} must be absolute or start with ~/`);
  }
  return expanded;
}

export function isDevPortalUrl(url) {
  return /developer\.apple\.com\/account/.test(url) && !/idmsa|\/login/.test(url);
}

// `signInStatus` reads the status Apple answered `signin/complete` with. The DOM
// was the only witness here and it is the weaker one: Apple renders the refusal
// inside the widget iframe, and in a headless context the text this loop looks
// for was never `isVisible`, so a rejected password was reported as
// `Timed out waiting for developer portal or 2FA challenge` - a sentence that
// sent four separate investigations at the relay, the broker and the socket
// while the answer had been 401 within a second of the click.
export async function waitForPostPasswordState(session, frame, signInStatus, polls = POST_PASSWORD_POLLS) {
  const twoFactorSelector = 'input[aria-label*="digit"], input[aria-label*="Digit"], input[id*="char"], input[type="tel"][maxlength="1"]';
  const explicitFailure = /incorrect|verification failed|account (?:is |has been )?locked|unable to sign in|sign[ -]?in failed/i;
  for (let poll = 0; poll < polls; poll += 1) {
    if (isDevPortalUrl(session.page.url?.() ?? '')) return 'dashboard';
    const twoFactorVisible = await frame.locator(twoFactorSelector).first().isVisible().catch(() => false)
      || await session.page.getByText(/Two-Factor Authentication|verification code sent to your Apple devices/i).first().isVisible().catch(() => false);
    const status = signInStatus();
    if (status === 401 || status === 403) return 'rejected';
    if (twoFactorVisible) return 'two_factor';
    const failureVisible = await frame.getByText(explicitFailure).first().isVisible().catch(() => false)
      || await session.page.getByText(explicitFailure).first().isVisible().catch(() => false);
    if (failureVisible) return 'failed';
    await session.wait(1);
  }
  return 'timeout';
}

/** Click the first visible text, radio, button or link matching the pattern. */
export async function clickChoice(page, pattern) {
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

/** Click the first visible button or exact text matching the pattern. */
export async function clickButton(page, pattern) {
  for (const locator of [page.getByRole('button', { name: pattern }).first(), page.getByText(pattern, { exact: true }).first()]) {
    if (await locator.isVisible().catch(() => false)) { await locator.click(); return true; }
  }
  return false;
}
