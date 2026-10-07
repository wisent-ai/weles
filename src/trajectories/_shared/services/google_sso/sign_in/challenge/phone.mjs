// A Google device prompt is a live challenge, not a missing authenticator.
// Select an offered phone method once, ask the account owner for approval,
// and observe Google's response without sending page contents to alert channels.
import { humanClickLocator } from '../../../../../../../dist/human/mouse.js';
import { pageCondition, pageSettled } from '../../../../page/settled.mjs';
import { closeOperatorRequest, nextOperatorAnswer, noteOperatorRequest, openOperatorRequest } from '#operator-request';

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

/** Google's own control for sending the device prompt again. */
function resendControl(page) {
  return page.getByRole('button', { name: /^Resend it$/i })
    .or(page.getByRole('link', { name: /^Resend it$/i })).filter({ visible: true }).first();
}

function failure(message, code) {
  const error = new Error(message);
  error.code = code;
  error.fatal2fa = true;
  return error;
}

// Returns false only when Google offers no phone prompt. A rejected or
// interrupted approval is an explicit failure. The run sends the prompt again
// only when the operator says it never reached him.
//
// The wait ends on whichever comes first: Google's page leaving the device
// prompt, or the operator answering the run (`weles runs answer`, Weles
// Desktop's Running screen). `not_received` presses Google's "Resend it", or
// ends the run saying Google offers no second send; `approved` while Google
// still shows the prompt is recorded with what the page shows. Ending the
// wait is `weles runs cancel`, which ends the run.
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
  let seen = Array.isArray(request.answers) ? request.answers.length : 0;
  try {
    // Google's device prompt carries its own live regions: the heading block
    // ("2-Step Verification … wants to make sure it's really you") is
    // aria-live, so a read of every live region took the prompt itself for a
    // refusal two seconds after it was shown and ended every phone approval
    // before the operator could tap. What the page already announced when the
    // wait began is the prompt; only an alert it shows afterwards is an answer.
    const shownBefore = await page.evaluate(() => [...document.querySelectorAll('[role="alert"], [aria-live="assertive"]')]
      .map((alert) => alert.innerText?.trim())
      .filter(Boolean));
    const pageAnswer = pageCondition(page, (announced) => {
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
        if (box.width > 0 && box.height > 0 && text && !announced.includes(text)) {
          return { refused: true, detail: `Google displayed an alert: ${text}` };
        }
      }
      return false;
    }, shownBefore).then((answer) => ({ page: answer }));
    // An operator answer can end the wait while this page read is pending;
    // its later rejection (the page closing) is then nobody's to handle.
    pageAnswer.catch(() => {});
    let answer = null;
    while (!answer) {
      const listening = new AbortController();
      const outcome = await Promise.race([
        pageAnswer,
        nextOperatorAnswer(request.id, seen, listening.signal).then((said) => ({ operator: said })),
      ]);
      listening.abort();
      if (outcome.page) {
        answer = outcome.page;
        break;
      }
      seen += 1;
      const said = outcome.operator;
      if (said.answer === 'not_received') {
        const resend = resendControl(page);
        if (!await resend.isVisible()) {
          throw failure(`the operator received no Google prompt, and Google offers no "Resend it" on ${page.url()}`, 'google_prompt_not_received');
        }
        await humanClickLocator(page, resend);
        noteOperatorRequest(request.id, 'The operator received no prompt; the run pressed Google\'s "Resend it" and waits again');
        console.log(`[google_sso] operator request ${request.id}: prompt not received, Google asked to resend it`);
        continue;
      }
      const shown = (await page.locator('body').innerText()).replace(/\s+/g, ' ').trim();
      noteOperatorRequest(request.id, `The operator approved on the phone, and Google still shows ${page.url()}: ${shown}`);
      console.log(`[google_sso] operator request ${request.id}: operator approved, Google still on the device prompt`);
    }
    await pageSettled(page);
    if (answer.refused) {
      throw failure(`Google did not complete the device prompt: ${answer.detail}`, 'google_push_not_approved');
    }
    closeOperatorRequest(request.id, true, 'Google completed the device prompt; the sign-in flow continues');
    return true;
  } catch (error) {
    if (error && typeof error === 'object') error.second_factor = { required: true, method: 'phone' };
    closeOperatorRequest(request.id, false, `Google phone approval did not complete: ${String(error?.message || error)}`);
    throw error;
  }
}
