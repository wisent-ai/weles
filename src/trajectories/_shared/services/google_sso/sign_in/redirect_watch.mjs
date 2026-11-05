// After the password: watching for the redirect back to the caller's site, and
// answering whatever Google puts in the way first.
//
// A submitted password does not end the sign-in. Google may hand the run to a
// second factor, to a device prompt, to an OAuth consent screen, or to a
// security challenge this driver does not answer; the popup that carried the
// flow may also close and leave the main page to finish. Each of those is a
// state of a live page, so the step reads the settled page, answers the state
// it shows once, and names the state it cannot leave.
import {
  pageSettled,
  submitAnswered,
  urlMatching,
} from '../../../page/settled.mjs';
import { clickDescribed, pageShows } from '../../../page/judged/seen.mjs';
import {
  collectGoogleAuthMethods,
  logGooglePageDiag,
} from '../page_diagnostics.mjs';
import { resolveTotpSecret } from '../totp_secret.mjs';
import {
  clickTryAnotherWay,
  handleGoogleAuthenticatorTotp,
} from '../authenticator_challenge.mjs';
import { onGoogleSignIn } from '../../../profile/google_session.mjs';
import { enrolAfterApproval } from '../enrol_in_session.mjs';

/** Google's device prompt: approval on the account owner's phone. */
const DEVICE_PROMPT_ROUTE = '/signin/challenge/dp';
/** Google's list of second-factor methods. */
const METHOD_SELECTION_ROUTE = '/signin/challenge/selection';
/** Google's OAuth consent screens. */
const CONSENT_ROUTES = ['/signin/oauth/consent', '/signin/oauth/id'];
/** Google's security challenges this driver does not answer. */
const UNANSWERED_CHALLENGES = [
  '/challenge/deviceauth',
  '/challenge/recaptcha',
  '/challenge/az',
  '/challenge/kpe',
  '/challenge/sk',
];

function onRoute(url, routes) {
  const { pathname } = new URL(url);
  return routes.some((route) => pathname.includes(route));
}

// The caller's site is reached once the page is on its host; whether that
// site then holds a session is the caller's own check.
function onOrigin(url, originHost) {
  return Boolean(originHost) && new URL(url).host.endsWith(originHost);
}

// Only closure of the owned OAuth popup can replace page readiness.
async function settledOrClosed(page, isPopup) {
  try {
    await pageSettled(page);
  } catch (error) {
    if (!isPopup || !page.isClosed()) throw error;
  }
}

// true when the browser reached the caller's own site (or left Google for it);
// false when Google kept the run, with the page state captured for the reason.
export async function watchGoogleRedirect(page, session, creds, opts) {
  const originHost = opts.originHost;
  const isPopup = page !== session.page;
  let totpAttempted = false;
  let phonePromptChosen = false;
  const consentAnswered = new Set();
  for (;;) {
    if (!(isPopup && page.isClosed?.())) await settledOrClosed(page, isPopup);
    if (isPopup && page.isClosed?.()) {
      console.log('[google_sso] OAuth popup closed; checking main page');
      await pageSettled(session.page);
      const u = session.page.url();
      if (onOrigin(u, originHost))
        console.log(`[google_sso] returned to ${originHost}`);
      else console.log(`[google_sso] popup closed; main page=${u}`);
      return true;
    }
    const u = page.url();
    if (onOrigin(u, originHost)) {
      console.log(`[google_sso] main page returned to ${originHost}`);
      return true;
    }
    // One authenticator code per sign-in: a rejected code is answered by name,
    // not by typing the next one into the same challenge.
    if (
      !totpAttempted &&
      onRoute(u, [METHOD_SELECTION_ROUTE]) &&
      resolveTotpSecret(creds)
    ) {
      if (await handleGoogleAuthenticatorTotp(page, creds)) {
        totpAttempted = true;
        continue;
      }
      if (
        !phonePromptChosen &&
        (await pageShows(
          page,
          'Does the page offer approving the sign-in with a prompt on the phone or tablet?',
        ))
      ) {
        phonePromptChosen = true;
        console.log(
          '[google_sso] selecting phone prompt before alternate-method menu',
        );
        await clickDescribed(
          page,
          'the option to approve the sign-in with a prompt on the phone or tablet',
        );
        continue;
      }
    }
    if (!totpAttempted && (await handleGoogleAuthenticatorTotp(page, creds))) {
      totpAttempted = true;
      continue;
    }
    if (/signin\/challenge\/totp/.test(u) && totpAttempted) {
      await logGooglePageDiag(page, 'authenticator_wrong_code');
      console.log(
        '[google_sso] FAIL: Google Authenticator TOTP code was rejected',
      );
      return false;
    }
    if (onRoute(u, [DEVICE_PROMPT_ROUTE])) {
      await logGooglePageDiag(page, 'device_prompt_waiting');
      if (resolveTotpSecret(creds)) {
        const switchedMethod = await clickTryAnotherWay(page);
        if (switchedMethod) {
          await logGooglePageDiag(
            page,
            'device_prompt_try_another_after_click',
          );
          if (
            !totpAttempted &&
            (await handleGoogleAuthenticatorTotp(page, creds))
          ) {
            totpAttempted = true;
            continue;
          }
        }
        await logGooglePageDiag(page, 'authenticator_method_not_reached');
        console.log(
          '[google_sso] FAIL: Google Authenticator method not reached from device prompt',
        );
        return false;
      }
      // The approval happens on the account owner's phone; Google moves the
      // page off the prompt when it arrives (or when the prompt is declined).
      console.log('[google_sso] waiting for Google device prompt approval');
      const promptUrl = await urlMatching(
        page,
        (next) => !onRoute(next, [DEVICE_PROMPT_ROUTE]),
      );
      if (!onGoogleSignIn(promptUrl)) {
        console.log(
          `[google_sso] device prompt approved; redirected to ${promptUrl}`,
        );
        // The approval is the one moment a seedless account is signed in:
        // its seed is enrolled and stored now, so no later sign-in waits on
        // the phone again.
        await enrolAfterApproval(page.context(), creds.loginItem);
        return true;
      }
      if (onRoute(promptUrl, [DEVICE_PROMPT_ROUTE, METHOD_SELECTION_ROUTE])) {
        await logGooglePageDiag(page, 'device_prompt_not_approved');
        if (await clickTryAnotherWay(page)) {
          const methods = await collectGoogleAuthMethods(page);
          console.log(
            `[google_sso] available second-factor methods=${JSON.stringify(methods)}`,
          );
        }
        console.log(
          `[google_sso] FAIL: Google device prompt was not approved (${page.url()})`,
        );
        return false;
      }
      continue;
    }
    // Handle OAuth consent screen — Google asks to confirm scope before redirecting back.
    if (onRoute(u, CONSENT_ROUTES) && !consentAnswered.has(u)) {
      consentAnswered.add(u);
      console.log('[google_sso] allowing the OAuth consent');
      await clickDescribed(
        page,
        'the button on the Google consent screen that allows the sign-in and continues',
      );
      continue;
    }
    // Off Google and on the caller's host: the popup or page came back.
    if (!onGoogleSignIn(u) && onOrigin(u, originHost)) {
      console.log(
        `[google_sso] ${isPopup ? 'popup' : 'main page'} reached ${originHost}`,
      );
      return true;
    }
    if (!isPopup && !originHost && !onGoogleSignIn(u)) {
      console.log(`[google_sso] redirected off google to ${u}`);
      return true;
    }
    if (onRoute(u, UNANSWERED_CHALLENGES)) {
      await logGooglePageDiag(page, 'security_challenge');
      console.log(`[google_sso] FAIL: hit Google challenge ${u}`);
      return false;
    }
    // Still on the password step: Google is checking the password. It answers
    // by moving the page on, or by saying in place why it will not.
    if (/challenge\/pwd/.test(u)) {
      const message = page
        .locator('[aria-live="assertive"]')
        .filter({ hasText: /\S/ })
        .filter({ visible: true })
        .first();
      await submitAnswered(page, (next) => next === u, message);
      if (page.url() === u) {
        await logGooglePageDiag(page, 'password_refused');
        console.log(
          `[google_sso] FAIL: google_password_refused — ${await message.innerText()}`,
        );
        return false;
      }
      continue;
    }
    // Nothing on the settled page is a state this step answers.
    await logGooglePageDiag(page, 'still_on_google');
    console.log(
      `[google_sso] FAIL: google_sign_in_state_unanswered — the settled page is not one this step drives (${u})`,
    );
    return false;
  }
}

// Answer an offered post-login dismissal once, then observe the resulting page.
// A repeated control is an unresolved transition, not permission to click again.
export async function dismissGooglePostLogin(page) {
  const dismissed = new Set();
  for (;;) {
    await pageSettled(page);
    const url = page.url();
    if (!onGoogleSignIn(url)) return;
    if (dismissed.has(url)) {
      throw new Error(
        `GOOGLE_POST_LOGIN_STATE_REPEATED: the dismissed offer remained at ${url}`,
      );
    }
    if (
      !(await pageShows(
        page,
        'Does the page make an offer after sign-in (such as adding a recovery phone or a passkey) with a control to decline or skip it?',
      ))
    ) {
      throw new Error(
        `GOOGLE_POST_LOGIN_CONTROL_UNAVAILABLE: no offered dismissal control at ${url}`,
      );
    }
    dismissed.add(url);
    console.log('[google_sso] dismissing post-login prompt');
    await clickDescribed(
      page,
      'the control that declines or skips the offer for now',
    );
  }
}
