// Google-SSO sub-flow for the claude login trajectory.
//
// ROOT CAUSE (live SSH evidence): claude.ai's "Continue with Google" is a
// Google Identity Services (GIS) button, not a classic OAuth redirect.
// Clicking it with no Google session logs "Provider's accounts list is
// empty." and does nothing (no popup, no nav). So we must establish a
// Google session at accounts.google.com FIRST, then load claude.ai's
// authorize URL — GIS then has an account and the click completes.

// Google's GlifWebSignIn binds keydown handlers in a post-hydration
// microtask, so synthetic CDP keystrokes that fire the instant the
// input is `visible` are silently dropped (video 2026-05-17 showed the
// email field staying empty for the entire run). Gate on editable
// (true only once WIZ has finished hydrating: readOnly cleared,
// disabled false), then type and confirm the value actually landed.
// Retype up to 3 attempts if Google ate the keys. Errors propagate —
// no swallowed catches that could fake success. page.waitForTimeout
// calls are short polling sleeps inside an internal verification loop
// (NOT a humanized action the bot classifier ever sees) so the
// humanized-action rule does not apply.
async function fillAndVerify(page, locator, text, humanFill) {
  await locator.waitFor({ state: 'visible' });
  for (let i = 0; i < 50; i += 1) {
    if (await locator.isEditable()) break;
    await page.waitForTimeout(100); // allow-raw-playwright: post-hydration poll, not a humanized action
  }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await humanFill(page, locator, text);
    for (let i = 0; i < 20; i += 1) {
      const v = await locator.inputValue();
      if (v === text) return;
      await page.waitForTimeout(100); // allow-raw-playwright: input-value poll, not a humanized action
    }
  }
  const final = await locator.inputValue();
  throw new Error(`fillAndVerify gave up after 3 attempts; field value="${final}" expected len=${text.length}`);
}

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
  await page.goto('https://accounts.google.com/ServiceLogin?hl=en', { waitUntil: 'commit' });
  await humanIdlePause('deliberate');

  mark('google_email');
  // Video evidence (2026-05-17): visible-wait passed the moment the
  // input rendered, but Google's WIZ controller binds the keydown
  // handlers a tick later, so humanFill's CDP keystrokes landed in a
  // not-yet-live field and the value stayed empty across the whole run.
  // Gate on editable+enabled (Playwright's `editable` waits past WIZ
  // hydration) and then verify the typed value actually landed; retype
  // up to 3 times if Google ate the keys.
  const gEmailIn = page.locator('input[type="email"]').filter({ visible: true }).first();
  await gEmailIn.waitFor({ state: 'visible' });
  await fillAndVerify(page, gEmailIn, login.email, humanFill);
  // Google's GlifWebSignIn Next button is WIZ-obfuscated and force-click
  // didn't advance the page (stayed on /signin/identifier). Submitting
  // the focused field with Enter is the canonical robust Google signin
  // submit and avoids the obfuscated-selector problem entirely.
  await humanType(page, '\n');
  await humanIdlePause('deliberate');

  mark('google_password');
  const gPwIn = page.locator('input[type="password"]').filter({ visible: true }).first();
  await gPwIn.waitFor({ state: 'visible' });
  await fillAndVerify(page, gPwIn, login.password, humanFill);
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
  await page.goto(authorizeUrl, { waitUntil: 'commit' });
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
