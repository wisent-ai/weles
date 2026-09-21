// Enrolling a Google Authenticator for a signed-in Google account: reaching
// the authenticator setup page, reading the setup key Google shows behind
// "Can't scan it?", and confirming the first code computed from it.
//
// Page-level helpers only. They take the page and return what they saw; the
// account, the vault write and the run's result belong to the trajectory that
// calls them, so this module can be imported without any secret being read.
// Every step is one attempt: a page that does not show what the step needs is
// reported with what it showed instead, never clicked at again, and a browser
// error is the caller's to see.
import { humanClickLocator, humanIdlePause } from '../../../../../dist/human/mouse.js';
import { humanFill } from '../../../../../dist/human/keyboard.js';
import { generateTotp } from './totp_secret.mjs';

const CLICKABLE = 'button, [role="button"], a, [role="link"], li, div[role="option"]';
/** Google's TOTP period; a code entered in its last seconds is refused. */
const TOTP_PERIOD_SECONDS = 30;
/** Seconds left in the period below which the next period's code is used. */
const CODE_MARGIN_SECONDS = 6;
/** How long the code field may take to appear after the key is shown. */
const CODE_INPUT_TIMEOUT_MS = 20_000;
/** How much of a page is kept in a refusal, after the key is redacted. */
const PREVIEW_CHARS = 1600;

/** The authenticator settings page, by its direct address.
 *
 * `hl=en` is load-bearing, not decoration: every step below recognises the
 * page by its English labels, and Google renders this page in the account's
 * own language. On 2026-09-20 `controlyourai@gmail.com` answered in Polish —
 * "Skonfiguruj aplikację" where this module looks for "Set up authenticator" —
 * so a run that had signed in correctly still refused with
 * `setup_action_not_found` (run 104832e3-adc2-49eb-880e-d67c974298f3). */
export const AUTHENTICATOR_SETUP_URL = 'https://myaccount.google.com/two-step-verification/authenticator?hl=en';

export async function bodyText(page) {
  return await page.evaluate(() => document.body?.innerText || '');
}

function preview(text) {
  return redactKeys(String(text || '').slice(0, PREVIEW_CHARS));
}

export async function clickByText(page, pattern, label) {
  const role = page.getByRole('button', { name: pattern, exact: false })
    .or(page.getByRole('link', { name: pattern, exact: false }))
    .filter({ visible: true })
    .first();
  if (await role.isVisible()) {
    console.log(`[google-authenticator-enrol] clicking ${label} via role`);
    await humanClickLocator(page, role);
    await humanIdlePause('deliberate');
    return true;
  }
  const textual = page.locator(CLICKABLE).filter({ hasText: pattern }).filter({ visible: true }).first();
  if (await textual.isVisible()) {
    console.log(`[google-authenticator-enrol] clicking ${label} via text`);
    await humanClickLocator(page, textual);
    await humanIdlePause('deliberate');
    return true;
  }
  return false;
}

/** Whether the page is a Google sign-in or challenge rather than the account. */
export function onSignIn(url) {
  return /accounts\.google\.com/.test(url);
}

/**
 * Reach the authenticator setup page for the signed-in account.
 * @returns {{ ok: true, url: string } | { ok: false, blocked: string, url: string, textPreview: string }}
 */
export async function openAuthenticatorSetup(page, wait, navTimeoutMs) {
  await page.goto(AUTHENTICATOR_SETUP_URL, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs });
  await wait(6);
  const url = page.url();
  if (onSignIn(url)) return { ok: false, blocked: 'google_sign_in_required', url, textPreview: '' };
  const text = await bodyText(page);
  if (/two-step-verification\/authenticator/i.test(url)
    || /Authenticator app|Set up authenticator|Change authenticator app|Your authenticator/i.test(text)) {
    return { ok: true, url };
  }
  return { ok: false, blocked: 'authenticator_setup_page_not_reached', url, textPreview: preview(text) };
}

/**
 * Start the setup and reveal the setup key. Google shows the key as groups
 * of base32 letters behind "Can't scan it?"; the text is read from the page
 * and normalised to the bare base32 secret.
 * @returns {{ ok: true, secret: string } | { ok: false, blocked: string, textPreview: string }}
 */
export async function revealSetupKey(page, wait) {
  if (/Remove anyway/i.test(await bodyText(page))) {
    await clickByText(page, /^Cancel$/i, 'cancel remove-authenticator warning');
    await wait(2);
  }
  const started = await clickByText(page, /Set up authenticator|Change authenticator app|Add authenticator/i, 'set up authenticator');
  if (!started) {
    return { ok: false, blocked: 'setup_action_not_found', textPreview: preview(await bodyText(page)) };
  }
  await wait(4);
  if (!await clickByText(page, /Can.?t scan it/i, "Can't scan it?")) {
    return { ok: false, blocked: 'setup_key_reveal_not_found', textPreview: preview(await bodyText(page)) };
  }
  await wait(3);
  const text = await bodyText(page);
  const secret = extractSetupKey(text);
  if (!secret) return { ok: false, blocked: 'setup_key_not_shown', textPreview: preview(text) };
  return { ok: true, secret };
}

/** The base32 setup key in Google's grouped rendering, as one bare secret. */
export function extractSetupKey(text) {
  const match = String(text || '').match(/\b((?:[a-z2-7]{4}\s+){7}[a-z2-7]{4})\b/i);
  if (!match) return '';
  return match[1].replace(/\s+/g, '').toUpperCase();
}

export function redactKeys(text) {
  return String(text || '').replace(/(?:[a-z2-7]{4}\s+){7}[a-z2-7]{4}/gi, '<redacted-setup-key>');
}

/** A code with at least the margin left in its period; waits for the next period otherwise. */
async function freshCode(secret, wait) {
  const elapsed = Math.floor(Date.now() / 1000) % TOTP_PERIOD_SECONDS;
  const left = TOTP_PERIOD_SECONDS - elapsed;
  if (left < CODE_MARGIN_SECONDS) await wait(left + 1);
  return generateTotp(secret);
}

/**
 * Enter the first code from `secret` and read whether Google accepted it.
 * @returns {{ ok: true, url: string } | { ok: false, blocked: string, textPreview: string }}
 */
export async function confirmSetupCode(page, wait, secret) {
  const input = page.locator('input[type="tel"], input[type="text"], input[name="totpPin"], input[aria-label*="code" i]')
    .filter({ visible: true })
    .first();
  // Whether the code field is on screen is decided by the field, never by the
  // page's prose. This page always explains that an authenticator app "gets
  // verification codes", so a text test for that phrase reported the field as
  // already shown, skipped the Next that reveals it, and refused with
  // `setup_code_input_not_found` while Google was still showing the setup key
  // — measured on 2026-09-20 in run 32d5fc5a-1d20-42e1-9d2d-752733ef86d0.
  if (!(await input.isVisible().catch(() => false))) {
    await clickByText(page, /^Next$/i, 'next');
    await wait(3);
  }
  try {
    await input.waitFor({ state: 'visible', timeout: CODE_INPUT_TIMEOUT_MS });
  } catch (error) {
    if (error?.name !== 'TimeoutError') throw error;
    return { ok: false, blocked: 'setup_code_input_not_found', textPreview: preview(await bodyText(page)) };
  }
  const code = await freshCode(secret, wait);
  await humanFill(page, input, code);
  await clickByText(page, /^(Next|Verify|Turn on|Done)$/i, 'submit setup code');
  await wait(8);
  const text = await bodyText(page);
  if (/Wrong code|Try again|Invalid code|Couldn't verify|Enter the code/i.test(text)) {
    return { ok: false, blocked: 'setup_code_rejected', textPreview: preview(text) };
  }
  return { ok: true, url: page.url() };
}
