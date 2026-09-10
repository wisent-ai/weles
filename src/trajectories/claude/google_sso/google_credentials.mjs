// Signing this account in at accounts.google.com: identifier, password, and the
// 2FA prompt Google puts between them and a session.
//
// The step is driven by what the page shows rather than by waiting: the field is
// filled only once WIZ has bound its handlers, the typed value is read back, the
// Next button is clicked only when it is genuinely enabled, and Google's
// "browser may not be secure" block is raised as its own named error instead of
// being waited out against a password field that will never render.
import { fillAndVerify, waitForEnabledThenClick } from './page_controls.mjs';
import { resolveOtp, selectAuthenticatorMethod } from './authenticator_code.mjs';
import { waitForGooglePassword } from '../../codex/google_sso/google_credentials.mjs';

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
  await waitForEnabledThenClick(page,/next|continue|dalej/i);
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
  await waitForEnabledThenClick(page,/next|sign in|continue|dalej|zaloguj/i);
  await humanIdlePause('long');

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
  const otp = resolveOtp(login);
  if (!otp) {
    const err = new Error('google 2FA required but no login.totpSecret and no CLAUDE_2FA_CODE — aborting to avoid re-triggering push/SMS');
    err.fatal2fa = true;
    throw err;
  }
  await humanFill(page, gOtp(), otp);
  await humanClickLocator(page, page.locator('#totpNext button, button:has-text("Next"), button[type="submit"]').filter({ visible: true }).first());
  await humanIdlePause('long');
}
