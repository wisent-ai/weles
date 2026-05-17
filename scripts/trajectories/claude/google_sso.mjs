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
  // Video evidence 2026-05-17T21:56:26Z: even with humanFill retried 3×
  // against an editable input, Google's WIZ-wrapped Material text-field
  // never accepted the keystrokes — field stayed empty the whole run.
  // The native React/Vue/WIZ value setter is what frameworks listen to;
  // dispatch input+change so Google's model sees the change. Last resort
  // (humanFill demonstrably failed first) — does NOT replace the
  // humanized path for selectors WIZ does not own.
  await locator.evaluate((el, value) => {
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, text);
  for (let i = 0; i < 20; i += 1) {
    const v = await locator.inputValue();
    if (v === text) return;
    await page.waitForTimeout(100); // allow-raw-playwright: input-value poll, not a humanized action
  }
  const final = await locator.inputValue();
  throw new Error(`fillAndVerify exhausted humanFill+native-setter; field value="${final}" expected len=${text.length}`);
}

// Find Google's submit button by walking the DOM directly. The
// 22:14:57Z run showed Playwright locator-based searches all
// returning isVisible=false even though the Next button is plainly
// visible — WIZ wraps it in a way Playwright's visibility heuristic
// rejects. Walk every <button> and [role=button], match by trimmed
// innerText against the pattern, take the first with a non-zero
// bounding rect, and click via humanized pointer at its center.
// Waits up to 8s for the button to appear post-hydration.
async function clickSubmit(page, humanClick, namePattern) {
  const patternSrc = namePattern.source;
  for (let i = 0; i < 80; i += 1) {
    const hit = await page.evaluate((src) => {
      const re = new RegExp(src, 'i');
      const candidates = Array.from(document.querySelectorAll('button, [role="button"]'));
      for (const el of candidates) {
        const txt = (el.innerText || el.textContent || '').trim();
        if (!re.test(txt)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, tag: el.tagName, txt: txt.slice(0, 40) };
      }
      return null;
    }, patternSrc);
    if (hit) {
      await humanClick(page, Math.round(hit.x), Math.round(hit.y));
      return;
    }
    await page.waitForTimeout(100); // allow-raw-playwright: post-hydration poll, not a humanized action
  }
  throw new Error(`clickSubmit: no button matching /${patternSrc}/i found in 8s`);
}

// Like clickSubmit but waits for the button to be ENABLED before
// clicking. Google's WIZ Next button stays disabled (aria-disabled
// or disabled attribute) until the on-blur input validator fires;
// clicking a disabled WIZ button is a silent no-op. Polls for up to
// 8s post-fill for the button to enable, then clicks. On failure
// throws with the full button-state diagnostic so we can see whether
// the issue is "button never appeared", "button appeared but never
// enabled", or "button enabled but click had no effect".
async function waitForEnabledThenClick(page, humanClick, namePattern) {
  const patternSrc = namePattern.source;
  let lastState = null;
  for (let i = 0; i < 80; i += 1) {
    lastState = await page.evaluate((src) => {
      const re = new RegExp(src, 'i');
      const candidates = Array.from(document.querySelectorAll('button, [role="button"]'));
      for (const el of candidates) {
        const txt = (el.innerText || el.textContent || '').trim();
        if (!re.test(txt)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        const disabled = el.disabled || el.getAttribute('aria-disabled') === 'true' || el.getAttribute('disabled') !== null;
        return {
          x: r.x + r.width / 2, y: r.y + r.height / 2,
          tag: el.tagName, txt: txt.slice(0, 40),
          disabled, found: true,
        };
      }
      return { found: false };
    }, patternSrc);
    if (lastState.found && !lastState.disabled) {
      await humanClick(page, Math.round(lastState.x), Math.round(lastState.y));
      return;
    }
    await page.waitForTimeout(100); // allow-raw-playwright: enable-state poll, not a humanized action
  }
  throw new Error(`waitForEnabledThenClick: button stuck unclickable for /${patternSrc}/i, lastState=${JSON.stringify(lastState)}`);
}

export async function doGoogleSso({
  page, login, authorizeUrl, mark,
  humanFill, humanClickLocator, humanIdlePause, humanType,
}) {
  const { humanClick } = await import('../../../dist/human/mouse.js');
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
  // Google's WIZ Next button enables only after the input's blur+change
  // event chain runs through their validator. fillAndVerify's
  // native-setter path dispatches input+change, but blur is needed for
  // the on-blur validator. Dispatch a focusout/blur, then verify the
  // button is actually enabled before clicking — otherwise the click
  // is a no-op against a disabled control.
  await gEmailIn.evaluate((el) => {
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    el.dispatchEvent(new Event('focusout', { bubbles: true }));
  });
  await humanIdlePause('short');
  await waitForEnabledThenClick(page, humanClick, /next|continue/i);
  await humanIdlePause('deliberate');

  mark('google_password');
  const gPwIn = page.locator('input[type="password"]').filter({ visible: true }).first();
  await gPwIn.waitFor({ state: 'visible' });
  await fillAndVerify(page, gPwIn, login.password, humanFill);
  await gPwIn.evaluate((el) => {
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    el.dispatchEvent(new Event('focusout', { bubbles: true }));
  });
  await humanIdlePause('short');
  await waitForEnabledThenClick(page, humanClick, /next|sign in|continue/i);
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
