// Signing this account in at accounts.google.com: identifier, password, and the
// 2FA prompt Google puts between them and a session.
//
// Entry observes a writable field and verifies its value after trusted typing.
// Native input attributes do not prove WIZ hydration. The Next control must be
// enabled, and provider refusals are reported by the corresponding stage.
import { fillAndVerify, waitForEnabledThenClick } from './page_controls.mjs';
import { resolveOtp } from './authenticator_code.mjs';
import { selectAuthenticatorMethod, waitForGoogleChallengeExit } from '../../codex/google_sso/authenticator_code.mjs';
import { waitForGooglePassword } from '../../codex/google_sso/google_credentials.mjs';

export async function enterGoogleCredentials({
  page, login, mark,
  humanFill, humanClickLocator, humanIdlePause, humanType,
}) {
  mark('google_email');
  // Visible markup alone does not guarantee that dispatched input is retained.
  // Observe the writable state, then verify readback without blind retyping.
  // Google sign-in v2 renders the identifier field as input[type="text"]
  // with autocomplete="username webauthn" (id="identifierId") rather than
  // type="email". Match either variant so the locator survives A/B changes.
  const gEmailIn = page.locator(
    'input[type="text"][autocomplete*="username"], input#identifierId, input[name="identifier"], input[type="email"]'
  ).filter({ visible: true }).first();
  await gEmailIn.waitFor({ state: 'visible' });
  await fillAndVerify(page, gEmailIn, login.email, humanClickLocator, humanType);
  // Trusted typing delivers key/input events. Dispatch focusout/blur for the
  // field's on-blur validator before observing the Next control's enabled state.
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
  await waitForEnabledThenClick(page,/next|continue|dalej/i);

  const gPwIn = await waitForGooglePassword({ page, mark, humanClickLocator });
  await fillAndVerify(page, gPwIn, login.password, humanClickLocator, humanType);
  try {
    await gPwIn.evaluate((el) => {
      el.dispatchEvent(new Event('blur', { bubbles: true }));
      el.dispatchEvent(new Event('focusout', { bubbles: true }));
    });
  } catch (e) {
    if (!e.message.includes('Execution context was destroyed')) throw e;
  }
  await waitForEnabledThenClick(page,/next|sign in|continue|dalej|zaloguj/i);
  await humanIdlePause('long');

  mark('google_2fa_check');
  const otpSel = 'input[type="tel"][autocomplete="one-time-code"], input[name="totpPin"], input[autocomplete="one-time-code"]';
  const gOtp = () => page.locator(otpSel).filter({ visible: true }).first();
  // Inspect the offered screen before selecting a method that reveals a code field.
  if (!(await gOtp().isVisible())) {
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
    } catch (e) { console.log(`[google_sso] 2fa-diag failed: ${e.message}`); }
    const result = await selectAuthenticatorMethod(page, Boolean(login.totpSecret || process.env.CLAUDE_2FA_CODE));
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
    await gOtp().waitFor({ state: 'visible' });
  }
  const otp = resolveOtp(login);
  if (!otp) {
    const err = new Error('google 2FA required but no login.totpSecret and no CLAUDE_2FA_CODE — aborting to avoid re-triggering push/SMS');
    err.fatal2fa = true;
    throw err;
  }
  await humanFill(page, gOtp(), otp);
  await humanClickLocator(page, page.locator('#totpNext button, button:has-text("Next"), button[type="submit"]').filter({ visible: true }).first());
  await waitForGoogleChallengeExit(page);
}
