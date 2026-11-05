// Signing an account in at accounts.google.com, for every run that signs in
// through Google: the identifier, the password (reached through whichever
// sign-in method Google offers first), and the second factor Google puts
// between them and a session.
//
// Each field is filled with trusted typing and read back; each form is sent
// with Enter in its own field, as a person sends it. A refused password, an
// untrusted browser and any refusal Google states are each named by the step
// that met them.
import { fillAndVerify } from '../../../page/confirmed-fill.mjs';
import {
  navEval,
  readAcrossNavigation,
} from '../../../page/navigation/read.mjs';
import { pageCondition, pageSettled } from '../../../page/settled.mjs';
import { clickDescribed, pageShows } from '../../../page/judged/seen.mjs';
import { logGooglePageDiag } from '../page_diagnostics.mjs';
import {
  GOOGLE_ACCOUNTS_HOST,
  googleSignInUrl,
} from '../../../profile/google_session.mjs';
import { resolveOtp } from './challenge/seed.mjs';
import { completeGooglePhoneApproval } from './challenge/phone.mjs';
import { enrolAfterApproval } from '../enrol_in_session.mjs';
import {
  requireAuthenticatorCode,
  selectAuthenticatorMethod,
  waitForGoogleChallengeExit,
} from '../../../../codex/google_sso/authenticator_code.mjs';

/** Google's own routes for a sign-in it refuses as possibly not secure. */
const REJECTED_ROUTES = ['/signin/rejected', 'deniedsigninrejected'];
const OTP_FIELD =
  'input[type="tel"][autocomplete="one-time-code"], input[name="totpPin"], input[autocomplete="one-time-code"]';

function refuseIfRejected(page) {
  const { pathname } = new URL(page.url());
  if (!REJECTED_ROUTES.some((route) => pathname.includes(route))) return;
  const error = new Error(`Google refused sign-in at ${page.url()}`);
  error.code = 'BROWSER_NOT_SECURE';
  error.fatal2fa = true;
  throw error;
}

/** Let the field's on-blur validator run; only a page replacement may cut it. */
function blurField(page, field) {
  return readAcrossNavigation(page, () =>
    field.evaluate((el) => {
      el.dispatchEvent(new Event('blur', { bubbles: true }));
      el.dispatchEvent(new Event('focusout', { bubbles: true }));
    }),
  );
}

/**
 * The password field. It may be an offered method rather than a field yet:
 * Google may list the ways to sign in, or show a passkey screen whose other
 * ways include the password. Each is answered once, by the vision model, in
 * that order; a page that leads to no password field is refused.
 */
export async function waitForGooglePassword({ page, mark }) {
  mark('google_password');
  const password = page
    .locator('input[type="password"]')
    .filter({ visible: true })
    .first();
  let selectedPassword = false;
  let openedAlternatives = false;
  for (;;) {
    await pageSettled(page);
    refuseIfRejected(page);
    if (await password.isVisible()) return password;
    if (
      !selectedPassword &&
      (await pageShows(
        page,
        'Does the page list ways to sign in that include entering the account password?',
      ))
    ) {
      selectedPassword = true;
      mark('google_password_choice');
      await clickDescribed(
        page,
        'the option to sign in by entering the account password',
      );
      continue;
    }
    if (
      !selectedPassword &&
      !openedAlternatives &&
      (await pageShows(
        page,
        'Does the page offer a control that shows other ways to sign in?',
      ))
    ) {
      openedAlternatives = true;
      mark('google_password_alternatives');
      await clickDescribed(
        page,
        'the control that shows other ways to sign in',
      );
      continue;
    }
    break;
  }
  const observed = await navEval(
    page,
    () => ({
      host: location.host,
      path: location.pathname,
      text: document.body.innerText.replace(/\s+/g, ' '),
    }),
    { state: 'page navigated before diagnosis' },
  );
  const error = new Error(
    `Google did not show the selected password challenge: ${JSON.stringify(observed)}`,
  );
  error.code = 'google_password_challenge_unavailable';
  error.fatal2fa = true;
  throw error;
}

/**
 * Google's answer to the submitted password. Staying on the password screen
 * is pending, not proof of a wrong password: Google marks a refused password
 * on the field itself (aria-invalid), refuses an untrusted sign-in on its
 * rejection route, and states any other refusal in the page's assertive live
 * region; each throws with its code. Leaving the password step resolves.
 */
export async function waitForGooglePasswordResult(page) {
  const observed = await pageCondition(
    page,
    ({ rejectedRoutes, googleHost }) => {
      if (!/^https?:$/.test(location.protocol)) return false;
      const state = { host: location.host, path: location.pathname };
      if (location.hostname !== googleHost) return state;
      const text = document.body.innerText.replace(/\s+/g, ' ');
      if (rejectedRoutes.some((route) => location.pathname.includes(route)))
        return { ...state, text, code: 'BROWSER_NOT_SECURE' };
      const alert = Array.from(
        document.querySelectorAll('[aria-live="assertive"], [role="alert"]'),
      )
        .map((region) => region.innerText.trim())
        .find(Boolean);
      if (alert)
        return { ...state, text: alert, code: 'provider_challenge_refused' };
      const password = Array.from(
        document.querySelectorAll('input[type="password"]'),
      ).find((input) => input.checkVisibility({ visibilityProperty: true }));
      if (password?.getAttribute('aria-invalid') === 'true')
        return {
          ...state,
          code: 'GOOGLE_PASSWORD_REJECTED',
          text,
          invalidInput: {
            name: password.name,
            ariaInvalid: password.getAttribute('aria-invalid'),
          },
        };
      if (password || /\/challenge\/pwd(?:\/|$)/.test(location.pathname))
        return false;
      return state;
    },
    { rejectedRoutes: REJECTED_ROUTES, googleHost: GOOGLE_ACCOUNTS_HOST },
  );
  if (observed.code) {
    const error = new Error(
      `Google password step reports a refusal: ${JSON.stringify(observed)}`,
    );
    error.code = observed.code;
    throw error;
  }
}

/**
 * The identifier, the password and the second factor. `approvalLabel` names
 * the phone approval request an operator sees, for an account with no
 * authenticator seed; with a seed, the authenticator code answers.
 */
export async function enterGoogleCredentials({
  page,
  login,
  mark,
  humanFill,
  humanClickLocator,
  humanType,
  approvalLabel,
}) {
  mark('google_email');
  // Google renders the identifier as input[type="text"] with
  // autocomplete="username webauthn" (id="identifierId"), or as type="email".
  const email = page
    .locator(
      'input[type="text"][autocomplete*="username"], input#identifierId, input[name="identifier"], input[type="email"]',
    )
    .filter({ visible: true })
    .first();
  await email.waitFor({ state: 'visible' });
  // Each step that waits on the page is its own stage, so a stall names it.
  mark('google_email_field_visible');
  await fillAndVerify(page, email, login.email, humanClickLocator, humanType);
  mark('google_email_typed');
  await blurField(page, email);
  await email.press('Enter');
  mark('google_email_submitted');

  const password = await waitForGooglePassword({ page, mark });
  await fillAndVerify(
    page,
    password,
    login.password,
    humanClickLocator,
    humanType,
  );
  await blurField(page, password);
  await password.press('Enter');
  await waitForGooglePasswordResult(page);

  mark('google_2fa_check');
  const otpField = () =>
    page.locator(OTP_FIELD).filter({ visible: true }).first();
  if (
    !resolveOtp(login) &&
    (await completeGooglePhoneApproval(
      page,
      login.email,
      `${approvalLabel} ${login.email}`,
    ))
  ) {
    mark('google_2fa_phone', { required: true, method: 'phone' });
    // The approval signed a seedless account in: its seed is enrolled and
    // stored now, so no later sign-in of it waits on the phone again.
    await enrolAfterApproval(page.context(), login.loginItem);
    return;
  }
  if (!(await otpField().isVisible())) {
    // What the page offers instead of a code field, for the run's record.
    await logGooglePageDiag(page, 'second_factor_without_code_field');
    // Google defaulted to a push or SMS (the authenticator method then forces
    // a code field), or the account has no second factor at all.
    const result = await selectAuthenticatorMethod(
      page,
      Boolean(login.totpSecret),
    );
    if (result === 'no-2fa') {
      mark('google_2fa_not_requested', { required: false, method: null });
      return;
    }
    if (result === 'stuck') {
      const error = new Error(
        'google 2FA present but could not switch to authenticator — aborting to avoid push/sms loop',
      );
      error.fatal2fa = true;
      error.code = 'google_authenticator_method_unavailable';
      error.second_factor = { required: true, method: null };
      throw error;
    }
    await otpField().waitFor({ state: 'visible' });
  }
  // A code field is showing and is answered now: going on would let the
  // caller's flow submit the password again and send another prompt.
  mark('google_2fa_authenticator', { required: true, method: 'authenticator' });
  const otp = await requireAuthenticatorCode(page, resolveOtp(login));
  await humanFill(page, otpField(), otp);
  await otpField().press('Enter');
  await waitForGoogleChallengeExit(page);
}

/**
 * A Google session in the browser before a provider's GIS handoff: GIS offers
 * only accounts Google already holds, so the run opens Google's own sign-in
 * page and enters the credentials there first, with the flow's approval label.
 */
export async function establishGoogleSession({ approvalLabel, ...entry }) {
  entry.mark('google_prelogin_goto');
  await entry.page.goto(googleSignInUrl(), { waitUntil: 'commit' });
  await enterGoogleCredentials({ ...entry, approvalLabel });
}
