// Signing this account in at accounts.google.com: identifier, password, and the
// 2FA prompt Google puts between them and a session.
//
// Every step here is proven against live frames rather than assumed: the field
// is filled only once WIZ has bound its handlers, the typed value is read back,
// the Next button is clicked only when it is actually enabled, and a Google
// refusal ("browser may not be secure", a password challenge that stays) is
// raised as its own named error instead of being waited out.
import { fillAndVerify, navEval, waitForEnabledThenClick } from './page_controls.mjs';
import { resolveOtp, selectAuthenticatorMethod } from './authenticator_code.mjs';

export async function establishGoogleSession({
  page, login, mark,
  humanFill, humanClickLocator, humanIdlePause, humanType,
}) {
  mark('google_prelogin_goto');
  await page.goto('https://accounts.google.com/ServiceLogin?hl=en', { waitUntil: 'commit' });
  await humanIdlePause('deliberate');
  await enterGoogleCredentials({ page, login, mark, humanFill, humanClickLocator, humanIdlePause, humanType });
}

// The password can be an offered method, not a field yet. Selecting it takes
// precedence over "Try another way", which would leave the usable choice.
export async function waitForGooglePassword({ page, mark, humanClickLocator, humanIdlePause }) {
  mark('google_password');
  const password = page.locator('input[type="password"]').filter({ visible: true }).first();
  const choiceName = /^(?:enter your password|use (?:your )?password|wpisz hasło|użyj hasła)$/i;
  const choice = page.getByRole('link', { name: choiceName })
    .or(page.getByRole('button', { name: choiceName })).filter({ visible: true }).first();
  const alternatives = page.getByText(/^(?:try another way|wypr[oó]buj inny spos[oó]b)$/i)
    .filter({ visible: true }).first();
  const passkey = page.getByText(/use your passkey|użyj klucza dostępu/i)
    .filter({ visible: true }).first();
  const refused = page.getByText(/couldn.?t sign you in|may not be secure|too many failed attempts/i)
    .filter({ visible: true }).first();
  let selectedPassword = false;
  let openedAlternatives = false;
  for (let i = 0; i < 80; i += 1) {
    if (await refused.isVisible()) {
      const detail = await refused.innerText();
      const error = new Error(`Google refused sign-in: ${detail}`);
      error.code = /may not be secure|couldn.?t sign you in/i.test(detail)
        ? 'BROWSER_NOT_SECURE' : 'provider_challenge_refused';
      error.fatal2fa = true;
      throw error;
    }
    if (await password.isVisible()) return password;
    if (!selectedPassword && await choice.isVisible() && await choice.isEnabled()) {
      selectedPassword = true;
      mark('google_password_choice');
      await humanClickLocator(page, choice);
      await humanIdlePause('deliberate');
      mark('google_password');
      continue;
    }
    if (!selectedPassword && !openedAlternatives && await passkey.isVisible()
        && await alternatives.isVisible() && await alternatives.isEnabled()) {
      openedAlternatives = true;
      mark('google_password_alternatives');
      await humanClickLocator(page, alternatives);
      await humanIdlePause('deliberate');
      mark('google_password');
      continue;
    }
    await page.waitForTimeout(500); // allow-raw-playwright: observe the selected challenge, never resubmit it
  }
  const observed = await navEval(page, () => ({
    host: location.host, path: location.pathname,
    text: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 500),
  }), { state: 'page navigated before diagnosis' });
  const error = new Error(`Google did not show the selected password challenge: ${JSON.stringify(observed)}`);
  error.code = 'google_password_challenge_unavailable';
  error.fatal2fa = true;
  throw error;
}

// Email -> password -> 2FA entry on accounts.google.com. Extracted verbatim
// from establishGoogleSession so it can be reused when a first-time account is
// entered via "Use another account" on the authorize chooser.
export async function enterGoogleCredentials({
  page, login, mark,
  humanFill, humanClickLocator, humanIdlePause, humanType,
}) {
  mark('google_email');
  // Video evidence (2026-05-17): visible-wait passed the moment the
  // input rendered, but Google's WIZ controller binds the keydown
  // handlers a tick later, so humanFill's CDP keystrokes landed in a
  // not-yet-live field and the value stayed empty across the whole run.
  // Gate on editable+enabled (Playwright's `editable` waits past WIZ
  // hydration) and then verify the typed value actually landed; retype
  // up to 3 times if Google ate the keys.
  // Google sign-in v2 renders the identifier field as input[type="text"]
  // with autocomplete="username webauthn" (id="identifierId") rather than
  // type="email". Match either variant so the locator survives A/B changes.
  const gEmailIn = page.locator(
    'input[type="text"][autocomplete*="username"], input#identifierId, input[name="identifier"], input[type="email"]'
  ).filter({ visible: true }).first();
  await gEmailIn.waitFor({ state: 'visible' });
  await fillAndVerify(page, gEmailIn, login.email, humanClickLocator, humanType);
  // Google's WIZ Next button enables only after the input's blur+change
  // event chain runs through their validator. fillAndVerify's
  // native-setter path dispatches input+change, but blur is needed for
  // the on-blur validator. Dispatch a focusout/blur, then verify the
  // button is actually enabled before clicking — otherwise the click
  // is a no-op against a disabled control.
  // best-effort blur — if the page has already navigated (Google
  // auto-submits some flows), the evaluate fails with
  // "Execution context was destroyed" which is HARMLESS; the
  // navigation we wanted is already happening. Catch and continue.
  try {
    await gEmailIn.evaluate((el) => {
      el.dispatchEvent(new Event('blur', { bubbles: true }));
      el.dispatchEvent(new Event('focusout', { bubbles: true }));
    });
  } catch (e) {
    if (!e.message.includes('Execution context was destroyed')) throw e;
  }
  await humanIdlePause('short');
  await waitForEnabledThenClick(page, /next|continue|dalej/i);
  await humanIdlePause('deliberate');

  const gPwIn = await waitForGooglePassword({ page, mark, humanClickLocator, humanIdlePause });
  await fillAndVerify(page, gPwIn, login.password, humanClickLocator, humanType);
  try {
    await gPwIn.evaluate((el) => {
      el.dispatchEvent(new Event('blur', { bubbles: true }));
      el.dispatchEvent(new Event('focusout', { bubbles: true }));
    });
  } catch (e) {
    if (!e.message.includes('Execution context was destroyed')) throw e;
  }
  await humanIdlePause('short');
  await waitForEnabledThenClick(page, /next|sign in|continue|dalej/i);
  await humanIdlePause('long');
  const passwordRejected = await navEval(page, () => {
    const visiblePassword = Array.from(document.querySelectorAll('input[type="password"]'))
      .some((input) => {
        const box = input.getBoundingClientRect();
        return box.width > 4 && box.height > 4;
      });
    return visiblePassword && /\/challenge\/pwd/.test(location.pathname);
  }, false);
  if (passwordRejected) {
    const error = new Error('GOOGLE_PASSWORD_REJECTED: Google kept the account on its password challenge');
    error.code = 'GOOGLE_PASSWORD_REJECTED';
    throw error;
  }

  mark('google_2fa_check');
  const otpSel = 'input[type="tel"][autocomplete="one-time-code"], input[name="totpPin"], input[autocomplete="one-time-code"]';
  const gOtp = () => page.locator(otpSel).filter({ visible: true }).first();
  const waitOtp = async () => {
    try { await gOtp().waitFor({ state: 'visible' }); return true; } catch { return false; }
  };
  let otpVisible = await waitOtp();
  if (!otpVisible) {
    // DIAGNOSTIC: dump what is actually on screen so the selector can be fixed
    // without guessing. Logs the URL path + visible clickable labels (Google UI
    // chrome text — account emails/codes are not button labels, so no secrets).
    try {
      const diag = await page.evaluate(() => {
        const texts = [];
        for (const el of Array.from(document.querySelectorAll('button,[role="button"],a,li,span,div'))) {
          const t = (el.innerText || el.textContent || '').trim();
          if (!t || t.length > 45) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 8 || r.height < 8) continue;
          if (!texts.includes(t)) texts.push(t);
          if (texts.length >= 25) break;
        }
        return { path: location.pathname, host: location.host, texts };
      });
      console.log(`[google_sso] 2fa-diag host=${diag.host} path=${diag.path} clickables=${JSON.stringify(diag.texts)}`);
    } catch (e) { console.log(`[google_sso] 2fa-diag failed: ${e.message.slice(0, 80)}`); }
    // No code field yet. Either Google defaulted to push/SMS (switch to the
    // authenticator method to force a TOTP field) or this account has no 2FA
    // (no method-chooser present) — then there is nothing to answer.
    const result = await selectAuthenticatorMethod(page);
    if (result === 'no-2fa') {
      console.log('[google_sso] no 2fa challenge present — nothing to answer');
      return;
    }
    if (result === 'stuck') {
      const err = new Error('google 2FA present but could not switch to authenticator — aborting to avoid push/sms loop');
      err.fatal2fa = true;
      throw err;
    }
    console.log('[google_sso] selected authenticator (TOTP) method via "Try another way"');
    otpVisible = await waitOtp();
    if (!otpVisible) {
      const err = new Error('google 2FA: authenticator selected but no code field appeared');
      err.fatal2fa = true;
      throw err;
    }
  }
  // A code field is showing — it MUST be answered now. Aborting here (rather
  // than going on) prevents the authorize->chooser->re-enter loop from
  // re-submitting the password and re-triggering another push/SMS to the user.
  const otp = resolveOtp(login);
  if (!otp) {
    const err = new Error('google 2FA required but no login.totpSecret and no CODEX_2FA_CODE — aborting to avoid re-triggering push/SMS');
    err.fatal2fa = true;
    throw err;
  }
  await humanFill(page, gOtp(), otp);
  await humanClickLocator(page, page.locator('#totpNext button, button:has-text("Next"), button[type="submit"]').filter({ visible: true }).first());
  await humanIdlePause('long');
}
