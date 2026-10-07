// A Google device prompt is a live challenge, not a missing authenticator.
// Select an offered phone method once, ask the account owner for approval,
// and observe Google's response without sending page contents to alert channels.
import { humanClickLocator } from '../../../../../../../dist/human/mouse.js';
import { pageCondition, pageSettled } from '../../../../page/settled.mjs';
import {
  closeOperatorRequest, nextOperatorAnswer, noteOperatorRequest, openOperatorRequest, repageOperatorRequest,
} from '#operator-request';

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

/**
 * Google's phone method on the current challenge, without sending anything:
 * `{ shown: true }` when Google already shows its device prompt (it sent it on
 * its own), `{ option }` for the method a click would send, or null when
 * Google offers no phone prompt. "Try another way" only lists the methods.
 */
async function offeredPhonePrompt(page) {
  const url = location(page);
  if (url.hostname !== GOOGLE_HOST || !CHALLENGE_PATH.test(url.pathname)) return null;
  if (isDevicePrompt(page)) return { shown: true };
  const alternate = page.getByRole('button', { name: /^Try another way$/i })
    .or(page.getByRole('link', { name: /^Try another way$/i })).filter({ visible: true }).first();
  if (await alternate.isVisible()) {
    await humanClickLocator(page, alternate);
    await pageSettled(page);
  }
  const option = page.locator('li, div[role="option"], div[role="button"], button, a')
    .filter({ hasText: /Tap Yes on your phone or tablet|Gmail app|phone or tablet/i })
    .filter({ visible: true }).first();
  return await option.isVisible() ? { option } : null;
}

/** Whether Google offers a phone prompt here; nothing is sent to the phone. */
export async function googlePhonePromptOffered(page) {
  return Boolean(await offeredPhonePrompt(page));
}

/** The number Google asks the phone to match, as a sentence, or ''. */
async function numberToMatch(page) {
  const text = await page.locator('body').innerText();
  const [, number] = text.match(/\b(?:tap|choose|select)\s+(\d+)\b/i) ?? [];
  return number ? ` Choose ${number} if the phone asks you to match the number.` : '';
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
// interrupted approval is an explicit failure.
//
// No prompt is sent before the operator is ready: a prompt sent while he is
// away expires unseen. The run asks him first (`weles runs answer <run>
// --ready`, Weles Desktop's Running screen, every channel he chose) and
// chooses Google's phone method only on that answer, then asks him to
// approve, with the number to match. Only when Google already shows its
// device prompt on its own is there nothing to hold back.
//
// The approval wait ends on whichever comes first: Google's page leaving the
// device prompt, or the operator answering. `not_received` presses Google's
// "Resend it", or ends the run saying Google offers no second send;
// `approved` while Google still shows the prompt is recorded with what the
// page shows. Ending the wait is `weles runs cancel`, which ends the run.
export async function completeGooglePhoneApproval(page, account, run) {
  const offered = await offeredPhonePrompt(page);
  if (!offered) return false;
  const request = openOperatorRequest({
    kind: 'google-push-approval', account, run,
    instruction: offered.shown
      ? `Approve the Google sign-in for ${account} on your phone.${await numberToMatch(page)}`
      : `Weles will send a Google sign-in prompt for ${account} to your phone when you answer ready; nothing is sent before. Then approve it on the phone.`,
  });
  console.log(`[google_sso] operator request ${request.id}; notification delivered=${request.pages.some((attempt) => attempt.ok)}`);
  let seen = Array.isArray(request.answers) ? request.answers.length : 0;
  const [firstRun] = Array.isArray(request.run_ids) ? request.run_ids : [];
  try {
    if (offered.option) {
      seen = await untilReady(page, request, seen);
      await humanClickLocator(page, offered.option);
      await pageSettled(page);
      if (!isDevicePrompt(page)) {
        throw failure(`the operator was ready, and choosing Google's phone method showed ${page.url()} instead of the device prompt`, 'google_phone_prompt_not_shown');
      }
      repageOperatorRequest(request.id,
        `Google's prompt was sent at ${new Date().toISOString()}: approve it on your phone now.${await numberToMatch(page)}`);
    }
    // Google's device prompt carries its own live regions: the heading block
    // ("2-Step Verification … wants to make sure it's really you") is
    // aria-live, so a read of every live region took the prompt itself for a
    // refusal two seconds after it was shown and ended every phone approval
    // before the operator could tap. What the page already announced when the
    // wait began is the prompt; only an alert it shows afterwards is an answer.
    const announcedNow = () => page.evaluate(() => [...document.querySelectorAll('[role="alert"], [aria-live="assertive"]')]
      .map((alert) => alert.innerText?.trim())
      .filter(Boolean));
    // A new alert beside Google's own "Resend it" is the prompt expiring, not
    // a refusal: the operator was not there in time, and nothing about the
    // account changed. It is recorded on the request with its time, the
    // operator is asked again through the channels he chose, and the run
    // keeps waiting for his answer (not-received sends a new prompt).
    const watchPage = (announced) => {
      const watched = pageCondition(page, (before) => {
        const google = location.hostname === 'accounts.google.com';
        const device = /\/signin\/challenge\/dp(?:\/|$)/.test(location.pathname);
        if (!google || !device) {
          // Google's /info/ pages (sessionexpired among them) end the sign-in
          // itself: leaving the prompt for one is not an approval, and the run
          // that read it as one closed the request as completed and then
          // failed as `google_sign_in_requires_action` with no cause.
          if (google && /^\/info\//.test(location.pathname)) {
            return { ended: true, detail: `${location.origin}${location.pathname}` };
          }
          return { refused: google && /\/signin\/challenge(?:\/|$)/.test(location.pathname),
            detail: `${location.origin}${location.pathname}` };
        }
        const rendered = (element) => {
          const box = element.getBoundingClientRect();
          return Boolean(box.width && box.height);
        };
        const resend = [...document.querySelectorAll('button, [role="button"], a, [role="link"]')]
          .some((control) => /^Resend it$/i.test((control.innerText || control.textContent || '').trim()) && rendered(control));
        // An assertive provider alert is observable even if the URL stays put.
        for (const alert of document.querySelectorAll('[role="alert"], [aria-live="assertive"]')) {
          const text = alert.innerText?.trim();
          if (rendered(alert) && text && !before.includes(text)) {
            return resend
              ? { expired: true, detail: `Google displayed: ${text}` }
              : { refused: true, detail: `Google displayed an alert: ${text}` };
          }
        }
        return false;
      }, announced).then((answer) => ({ page: answer }));
      // An operator answer can end the wait while this page read is pending;
      // its later rejection (the page closing) is then nobody's to handle.
      watched.catch(() => {});
      return watched;
    };
    let pageAnswer = watchPage(await announcedNow());
    let answer = null;
    while (!answer) {
      const listening = new AbortController();
      const outcome = await Promise.race([
        pageAnswer,
        nextOperatorAnswer(request.id, seen, listening.signal).then((said) => ({ operator: said })),
      ]);
      listening.abort();
      if (outcome.page?.expired) {
        const at = new Date().toISOString();
        const how = `weles runs answer ${firstRun ?? '<run>'} --not-received`;
        repageOperatorRequest(request.id,
          `Google's prompt expired at ${at} before it was approved (${outcome.page.detail}); answer not-received for a new one: ${how}, or Weles Desktop > Running.`);
        console.log(`[google_sso] operator request ${request.id}: Google's prompt expired at ${at}; the operator is asked again`);
        pageAnswer = watchPage(await announcedNow());
        continue;
      }
      if (outcome.page) {
        answer = outcome.page;
        break;
      }
      seen += 1;
      const said = outcome.operator;
      if (said.answer === 'ready') {
        noteOperatorRequest(request.id, 'The operator answered ready while Google already shows its prompt; approve it on the phone, or answer not-received for a new one');
        continue;
      }
      if (said.answer === 'not_received') {
        const resend = resendControl(page);
        if (!await resend.isVisible()) {
          throw failure(`the operator received no Google prompt, and Google offers no "Resend it" on ${page.url()}`, 'google_prompt_not_received');
        }
        await humanClickLocator(page, resend);
        noteOperatorRequest(request.id, 'The operator asked for a new prompt; the run pressed Google\'s "Resend it" and waits again');
        console.log(`[google_sso] operator request ${request.id}: Google asked to resend the prompt`);
        pageAnswer = watchPage(await announcedNow());
        continue;
      }
      const shown = (await page.locator('body').innerText()).replace(/\s+/g, ' ').trim();
      noteOperatorRequest(request.id, `The operator approved on the phone, and Google still shows ${page.url()}: ${shown}`);
      console.log(`[google_sso] operator request ${request.id}: operator approved, Google still on the device prompt`);
    }
    await pageSettled(page);
    if (answer.ended) {
      throw failure(
        `Google ended the sign-in on ${answer.detail} while it waited for the phone approval asked at ${request.opened_at}; nothing about the account changed, and a new run of the same action starts the sign-in again`,
        'google_sign_in_ended_during_approval',
      );
    }
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

/**
 * Wait until the operator answers ready, before anything is sent to his
 * phone; returns the answers seen. Another answer is recorded and the wait
 * goes on. Google's page leaving the challenge while it waits ends the
 * sign-in by name: Google ended it, and no prompt was sent.
 */
async function untilReady(page, request, seen) {
  const left = pageCondition(page, () => {
    const google = location.hostname === 'accounts.google.com';
    return google && /\/signin\/challenge(?:\/|$)/.test(location.pathname)
      ? false : { detail: `${location.origin}${location.pathname}` };
  }).then((moved) => ({ page: moved }));
  left.catch(() => {});
  let answered = seen;
  for (;;) {
    const listening = new AbortController();
    const outcome = await Promise.race([
      left,
      nextOperatorAnswer(request.id, answered, listening.signal).then((said) => ({ operator: said })),
    ]);
    listening.abort();
    if (outcome.page) {
      throw failure(
        `Google left its challenge for ${outcome.page.detail} while the run waited for the operator to be ready (asked at ${request.opened_at}); no prompt was sent, and a new run of the same action starts the sign-in again`,
        'google_sign_in_ended_during_approval',
      );
    }
    answered++;
    if (outcome.operator.answer === 'ready') {
      noteOperatorRequest(request.id, 'The operator is ready; the run chooses Google\'s phone method, which sends the prompt');
      return answered;
    }
    noteOperatorRequest(request.id,
      `The operator answered ${outcome.operator.answer} before any prompt was sent; the run sends Google's prompt only after he answers ready`);
  }
}
