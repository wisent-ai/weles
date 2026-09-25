// The App passwords page of a signed-in Google account: reaching it, creating
// one password under a name, and reading the password from the dialog Google
// shows exactly once.
//
// Page-level helpers only: they take the page and return what they saw, so this
// module can be imported and its parsing tested without a browser or a secret.
import { humanFill } from '../../../../dist/human/keyboard.js';
import { bodyText, clickByText, onSignIn } from '../../_shared/services/google_sso/authenticator_enrol.mjs';
import { APP_PASSWORDS_URL, PAGE_SETTLE_SECONDS, PREVIEW_CHARS } from './constants.mjs';

/** Google renders an app password as four groups of four lowercase letters. */
const APP_PASSWORD_GROUPS = /\b([a-z]{4})\s+([a-z]{4})\s+([a-z]{4})\s+([a-z]{4})\b/;
const APP_PASSWORD_ANYWHERE = /\b[a-z]{4}\s+[a-z]{4}\s+[a-z]{4}\s+[a-z]{4}\b/g;

/** The app password in Google's grouped rendering, as the bare 16 letters, or ''. */
export function extractAppPassword(text) {
  const match = String(text || '').match(APP_PASSWORD_GROUPS);
  return match ? match.slice(1).join('') : '';
}

/** `text` with anything shaped like an app password replaced. */
export function redactAppPasswords(text) {
  return String(text || '').replace(APP_PASSWORD_ANYWHERE, '<redacted-app-password>');
}

function preview(text) {
  return redactAppPasswords(String(text || '').slice(0, PREVIEW_CHARS));
}

/**
 * Why the account offers no App passwords page, read from what Google shows
 * instead of it, or '' when the page is the real one. Google shows the same
 * sentence when two-step verification is off, when a Workspace administrator
 * turned app passwords off, and under Advanced Protection.
 */
export function unavailableReason(text) {
  return /setting you are looking for is not available/i.test(String(text || ''))
    ? 'google_app_passwords_unavailable'
    : '';
}

/**
 * Open the App passwords page.
 * @returns {Promise<{ ok: true } | { ok: false, blocked: string, url: string, textPreview: string }>}
 */
export async function openAppPasswords(page, wait) {
  await page.goto(APP_PASSWORDS_URL, { waitUntil: 'domcontentloaded' });
  await wait(PAGE_SETTLE_SECONDS);
  const url = page.url();
  if (onSignIn(url)) return { ok: false, blocked: 'google_sign_in_required', url, textPreview: '' };
  const text = await bodyText(page);
  const unavailable = unavailableReason(text);
  if (unavailable) return { ok: false, blocked: unavailable, url, textPreview: preview(text) };
  if (!/apppasswords/i.test(url)) {
    return { ok: false, blocked: 'app_passwords_page_not_reached', url, textPreview: preview(text) };
  }
  return { ok: true };
}

/**
 * Create one app password named `appName` and read it from Google's dialog.
 * @returns {Promise<{ ok: true, password: string } | { ok: false, blocked: string, url: string, textPreview: string }>}
 */
export async function createAppPassword(page, wait, appName) {
  const field = page.getByRole('textbox', { name: /app name/i })
    .or(page.locator('input[type="text"]'))
    .filter({ visible: true })
    .first();
  if (!await field.isVisible()) {
    return { ok: false, blocked: 'app_name_field_not_found', url: page.url(), textPreview: preview(await bodyText(page)) };
  }
  await humanFill(page, field, appName);
  if (!await clickByText(page, /^Create$/i, 'create app password')) {
    return { ok: false, blocked: 'create_action_not_found', url: page.url(), textPreview: preview(await bodyText(page)) };
  }
  await wait(PAGE_SETTLE_SECONDS);
  if (onSignIn(page.url())) return { ok: false, blocked: 'google_sign_in_required', url: page.url(), textPreview: '' };
  const dialog = page.getByRole('dialog').filter({ visible: true }).first();
  const text = await dialog.isVisible() ? await dialog.innerText() : await bodyText(page);
  const password = extractAppPassword(text);
  if (!password) {
    return { ok: false, blocked: 'app_password_not_shown', url: page.url(), textPreview: preview(text) };
  }
  await clickByText(page, /^Done$/i, 'close generated app password');
  return { ok: true, password };
}
