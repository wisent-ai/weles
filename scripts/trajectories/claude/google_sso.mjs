// Google-SSO sub-flow for the claude login trajectory.
//
// ROOT CAUSE (live SSH evidence): claude.ai's "Continue with Google" is a
// Google Identity Services (GIS) button, not a classic OAuth redirect.
// Clicking it with no Google session logs "Provider's accounts list is
// empty." and does nothing (no popup, no nav). So we must establish a
// Google session at accounts.google.com FIRST, then load claude.ai's
// authorize URL — GIS then has an account and the click completes.
export async function doGoogleSso({
  page, login, authorizeUrl, mark,
  humanFill, humanClickLocator, humanIdlePause, humanType,
}) {
  mark('google_prelogin_goto');
  // waitUntil:'domcontentloaded' — accounts.google.com behind the
  // residential proxy keeps network busy and the 'load' event (Playwright
  // goto default) may never fire, hanging the navigation indefinitely.
  // domcontentloaded returns once the DOM is parsed; the email-input
  // waitFor below then gates on the form actually rendering.
  await page.goto('https://accounts.google.com/ServiceLogin?hl=en', { waitUntil: 'domcontentloaded' });
  await humanIdlePause('deliberate');

  mark('google_email');
  const gEmailIn = page.locator('input[type="email"]').filter({ visible: true }).first();
  await gEmailIn.waitFor({ state: 'visible' });
  await humanFill(page, gEmailIn, login.email);
  // Google's GlifWebSignIn Next button is WIZ-obfuscated and force-click
  // didn't advance the page (stayed on /signin/identifier). Submitting
  // the focused field with Enter is the canonical robust Google signin
  // submit and avoids the obfuscated-selector problem entirely.
  await humanType(page, '\n');
  await humanIdlePause('deliberate');

  mark('google_password');
  const gPwIn = page.locator('input[type="password"]').filter({ visible: true }).first();
  await gPwIn.waitFor({ state: 'visible' });
  await humanFill(page, gPwIn, login.password);
  await humanType(page, '\n');
  await humanIdlePause('long');

  mark('google_2fa_check');
  const gOtp = page.locator('input[type="tel"][autocomplete="one-time-code"], input[name="totpPin"], input[autocomplete="one-time-code"]').filter({ visible: true }).first();
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
    await humanFill(page, gOtp, otp);
    await humanClickLocator(page, page.locator('#totpNext button, button:has-text("Next"), button[type="submit"]').filter({ visible: true }).first());
    await humanIdlePause('long');
  }

  // Session established. Now load claude.ai's OAuth — GIS sees the account.
  mark('goto_authorize');
  await page.goto(authorizeUrl, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('deliberate');

  mark('gis_continue');
  const gBtn = page.getByRole('button', { name: /google/i })
    .or(page.locator('button:has-text("Google"), [data-provider="google" i]'))
    .first();
  await gBtn.waitFor({ state: 'visible' });
  await humanClickLocator(page, gBtn);
  await humanIdlePause('long');

  // A GIS account chooser may render; pick the row matching our email.
  mark('gis_account_chooser');
  const acct = page.locator(`text=${login.email}`).first();
  let acctVisible;
  try {
    acctVisible = await acct.isVisible();
  } catch (e) {
    acctVisible = false;
    console.log(`[google_sso] account-chooser probe threw (treated absent): ${e.message}`);
  }
  if (acctVisible) {
    await humanClickLocator(page, acct);
    await humanIdlePause('long');
  }
  return page;
}
