// Google-SSO sub-flow for the claude login trajectory. claude.ai's
// "Continue with Google" opens Google OAuth in a POPUP, so the main page
// never navigates to accounts.google.com; race a popup against same-tab
// nav and bind every Google step to whichever page wins. Returns once
// the Google credentials/TOTP are submitted; the caller resumes the
// claude.ai consent + PKCE callback on the original page.
//
// The race uses two promises that only ever RESOLVE (to the winning
// page). If the popup never opens AND same-tab nav never happens the
// race stays pending and the trajectory's hardened overall watchdog
// fires at step=resolve_google_page with full page state — the correct
// owner of that failure, not a hidden sentinel here.
export async function doGoogleSso({
  page, context, googleBtn, login, mark,
  humanFill, humanClickLocator, humanIdlePause,
}) {
  mark('click_google_button');
  // Diagnostic: a prior run reported click "success" but the login page
  // stayed unchanged — log exactly which node matched and pre/post URL
  // so a wrong/non-interactive match is unambiguous in the blob.
  let btnHtml;
  try {
    btnHtml = await googleBtn.evaluate((el) => el.outerHTML.slice(0, 300));
  } catch (e) {
    btnHtml = `btn-html-error:${e.message}`;
  }
  const urlBefore = page.url();
  console.log(`[google_sso] clicking btn=${JSON.stringify(btnHtml)} urlBefore=${urlBefore}`);
  const popupWin = new Promise((resolve) => {
    context.once('page', (p) => resolve(p));
  });
  await humanClickLocator(page, googleBtn);
  await humanIdlePause('deliberate');
  console.log(`[google_sso] post-click urlAfter=${page.url()}`);

  mark('resolve_google_page');
  const sameTabWin = page.waitForURL(/accounts\.google\.com/).then(() => page);
  const gp = await Promise.race([popupWin, sameTabWin]);
  await gp.waitForLoadState('domcontentloaded');
  await humanIdlePause('deliberate');

  mark('google_email');
  const gEmailIn = gp.locator('input[type="email"]').filter({ visible: true }).first();
  await gEmailIn.waitFor({ state: 'visible' });
  await humanFill(gp, gEmailIn, login.email);
  await humanClickLocator(gp, gp.locator('#identifierNext button, button:has-text("Next")').filter({ visible: true }).first());
  await humanIdlePause('deliberate');

  mark('google_password');
  const gPwIn = gp.locator('input[type="password"]').filter({ visible: true }).first();
  await gPwIn.waitFor({ state: 'visible' });
  await humanFill(gp, gPwIn, login.password);
  await humanClickLocator(gp, gp.locator('#passwordNext button, button:has-text("Next")').filter({ visible: true }).first());
  await humanIdlePause('long');

  mark('google_2fa_check');
  const gOtp = gp.locator('input[type="tel"][autocomplete="one-time-code"], input[name="totpPin"], input[autocomplete="one-time-code"]').filter({ visible: true }).first();
  let otpVisible;
  try {
    otpVisible = await gOtp.isVisible();
  } catch (e) {
    otpVisible = false;
    console.log(`[google_sso] 2fa visibility probe threw (treated absent): ${e.message}`);
  }
  if (otpVisible) {
    const otp = process.env.CLAUDE_2FA_CODE;
    if (!otp) {
      console.log('FAIL: Google 2FA prompt visible but CLAUDE_2FA_CODE env not set');
      process.exit(1);
    }
    await humanFill(gp, gOtp, otp);
    await humanClickLocator(gp, gp.locator('#totpNext button, button:has-text("Next"), button[type="submit"]').filter({ visible: true }).first());
    await humanIdlePause('long');
  }
  return gp;
}
