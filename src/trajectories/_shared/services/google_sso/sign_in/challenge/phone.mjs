// A Google device prompt is a live challenge, not a missing authenticator.
// Select an offered phone method once, ask the account owner for approval,
// and observe Google's response without sending page contents to alert channels.
import { humanClickLocator } from '../../../../../../../dist/human/mouse.js';
import { pageCondition, pageSettled } from '../../../../page/settled.mjs';
import { closeOperatorRequest, openOperatorRequest } from '#operator-request';

const GOOGLE_HOST = 'accounts.google.com';
const DEVICE_PROMPT = /\/signin\/challenge\/dp(?:\/|$)/;
const CHALLENGE_PATH = /\/signin\/challenge(?:\/|$)/;

function location(page) {
  return new URL(page.url());
}

function isDevicePrompt(page) {
  const url = location(page);
  return url.hostname === GOOGLE_HOST && DEVICE_PROMPT.test(url.pathname);
}

export async function selectGooglePhonePrompt(page) {
  const url = location(page);
  if (url.hostname !== GOOGLE_HOST || !CHALLENGE_PATH.test(url.pathname)) return false;
  if (isDevicePrompt(page)) return true;
  const alternate = page.getByRole('button', { name: /^Try another way$/i })
    .or(page.getByRole('link', { name: /^Try another way$/i })).filter({ visible: true }).first();
  if (await alternate.isVisible()) {
    await humanClickLocator(page, alternate);
    await pageSettled(page);
  }
  const phone = page.locator('li, div[role="option"], div[role="button"], button, a')
    .filter({ hasText: /Tap Yes on your phone or tablet|Gmail app|phone or tablet/i })
    .filter({ visible: true }).first();
  if (await phone.isVisible()) {
    await humanClickLocator(page, phone);
    await pageSettled(page);
  }
  return isDevicePrompt(page);
}

// Returns false only when Google offers no phone prompt. A rejected or
// interrupted approval is an explicit failure, never a reason to send another.
export async function completeGooglePhoneApproval(page, account, run) {
  if (!await selectGooglePhonePrompt(page)) return false;
  const text = await page.locator('body').innerText();
  const number = text.match(/\b(?:tap|choose|select)\s+(\d{1,3})\b/i);
  const matching = number ? ` Choose ${number[1]} if the phone asks you to match the number.` : '';
  const request = openOperatorRequest({
    kind: 'google-push-approval', account, run,
    instruction: `Approve the Google sign-in for ${account} on your phone.${matching}`,
  });
  console.log(`[google_sso] operator request ${request.id}; notification delivered=${request.pages.some((attempt) => attempt.ok)}`);
  try {
    const answer = await pageCondition(page, () => {
      const google = location.hostname === 'accounts.google.com';
      const device = /\/signin\/challenge\/dp(?:\/|$)/.test(location.pathname);
      if (!google || !device) {
        return { refused: google && /\/signin\/challenge(?:\/|$)/.test(location.pathname),
          detail: `${location.origin}${location.pathname}` };
      }
      // An assertive provider alert is observable even if the URL stays put.
      for (const alert of document.querySelectorAll('[role="alert"], [aria-live="assertive"]')) {
        const box = alert.getBoundingClientRect();
        const text = alert.innerText?.trim();
        if (box.width > 0 && box.height > 0 && text) {
          return { refused: true, detail: `Google displayed an alert: ${text}` };
        }
      }
      return false;
    });
    await pageSettled(page);
    if (answer.refused) {
      const error = new Error(`Google did not complete the device prompt: ${answer.detail}`);
      error.code = 'google_push_not_approved';
      error.fatal2fa = true;
      throw error;
    }
    closeOperatorRequest(request.id, true, 'Google completed the device prompt; the sign-in flow continues');
    return true;
  } catch (error) {
    if (error && typeof error === 'object') error.second_factor = { required: true, method: 'phone' };
    closeOperatorRequest(request.id, false, `Google phone approval did not complete: ${String(error?.message || error)}`);
    throw error;
  }
}
