// Google-SSO sub-flow for the claude login trajectory.
//
// ROOT CAUSE (live SSH evidence): claude.ai's "Continue with Google" is a
// Google Identity Services (GIS) button, not a classic OAuth redirect.
// Clicking it with no Google session logs "Provider's accounts list is
// empty." and does nothing (no popup, no nav). So we must establish a
// Google session at accounts.google.com FIRST, then load claude.ai's
// authorize URL — GIS then has an account and the click completes.

// Root cause of the email-field-stays-empty bug: humanType uses CDP
// Input.dispatchKeyEvent with key=char which is wrong for chars
// requiring shift (@ . uppercase) — the synthetic event's
// KeyboardEvent.key doesn't match a real key, and WIZ's beforeinput
// validator rejects the keystroke. Input.insertText is the CDP
// method designed for inserting text into a focused input; it fires
// the same input event sequence as IME composition, which WIZ
// accepts as legitimate. Click to focus, insertText, verify.
async function fillAndVerify(page, locator, text, humanClickLocator) {
  await locator.waitFor({ state: 'visible' });
  for (let i = 0; i < 50; i += 1) {
    if (await locator.isEditable()) break;
    await page.waitForTimeout(100); // allow-raw-playwright: post-hydration poll, not a humanized action
  }
  await humanClickLocator(page, locator);
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Input.insertText', { text });
    for (let i = 0; i < 20; i += 1) {
      const v = await locator.inputValue();
      if (v === text) return;
      await page.waitForTimeout(100); // allow-raw-playwright: input-value poll, not a humanized action
    }
    const final = await locator.inputValue();
    throw new Error(`fillAndVerify Input.insertText didn't land; field value="${final}" expected len=${text.length}`);
  } finally {
    await cdp.detach();
  }
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

// Wait for the button to be ENABLED then click via CDP
// Input.dispatchMouseEvent. WIZ's submit handler checks event
// trust; Playwright's page.mouse.click goes through the browser
// API and produces real-trusted events for ordinary pages, but
// the weles-patched Chromium has shown WIZ rejecting them in
// previous runs (video 22:14:57+ rendered the click as no-op).
// CDP Input.dispatchMouseEvent is the protocol-level equivalent
// of Input.insertText that just fixed the typing — same trust
// model. Throws with the full button-state diagnostic on
// timeout so the failure mode stays diagnosable.
async function waitForEnabledThenClick(page, namePattern) {
  const patternSrc = namePattern.source;
  let lastState = null;
  const cdp = await page.context().newCDPSession(page);
  try {
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
        const x = Math.round(lastState.x);
        const y = Math.round(lastState.y);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
        return;
      }
      await page.waitForTimeout(100); // allow-raw-playwright: enable-state poll, not a humanized action
    }
    throw new Error(`waitForEnabledThenClick: button stuck unclickable for /${patternSrc}/i, lastState=${JSON.stringify(lastState)}`);
  } finally {
    await cdp.detach();
  }
}

export async function doGoogleSso({
  page, login, authorizeUrl, mark,
  humanFill, humanClickLocator, humanIdlePause, humanType,
}) {
  mark('google_prelogin_goto');
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
  await fillAndVerify(page, gEmailIn, login.email, humanClickLocator);
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
  await waitForEnabledThenClick(page,/next|continue/i);
  await humanIdlePause('deliberate');

  mark('google_password');
  const gPwIn = page.locator('input[type="password"]').filter({ visible: true }).first();
  await gPwIn.waitFor({ state: 'visible' });
  await fillAndVerify(page, gPwIn, login.password, humanClickLocator);
  try {
    await gPwIn.evaluate((el) => {
      el.dispatchEvent(new Event('blur', { bubbles: true }));
      el.dispatchEvent(new Event('focusout', { bubbles: true }));
    });
  } catch (e) {
    if (!e.message.includes('Execution context was destroyed')) throw e;
  }
  await humanIdlePause('short');
  await waitForEnabledThenClick(page,/next|sign in|continue/i);
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
  // claude.ai's "Continue with Google" uses Google Identity
  // Services in popup mode — the popup runs Google's GIS UI and
  // posts the credential back to claude.ai (the opener) via
  // postMessage. The earlier window.open hijack (run 04:27Z)
  // navigated the main page to Google instead — that broke the
  // opener relationship, so when GIS completed at
  // accounts.google.com/gsi/transform there was no claude.ai
  // tab to receive the postMessage, the JS bundle aborted, and
  // the OAuth callback never fired (run 05:31Z FAIL diag:
  // "callback not received within 180s, url=.../gsi/transform").
  // The popup MUST be a real popup so the opener relationship
  // exists. Browser launched with --disable-popup-blocking
  // (async_api.ts) allows the popup.
  const popupP = page.context().waitForEvent('page');
  await waitForEnabledThenClick(page, /continue with google|^google$/i);
  const popup = await popupP;
  console.log(`[google_sso] GIS popup opened: ${popup.url()}`);
  await popup.waitForLoadState('domcontentloaded');

  // The popup shows account chooser then consent — handle both
  // in the popup, then it auto-closes and the opener (claude.ai)
  // receives the credential and completes OAuth.
  mark('gis_account_chooser_popup');
  await clickEmailRow(popup, login.email);
  await humanIdlePause('long');
  // Some flows show a consent step in the popup too.
  try {
    await waitForEnabledThenClick(popup, /^continue$/i);
  } catch (e) {
    console.log(`[google_sso] no consent button in popup (may have auto-confirmed): ${e.message.slice(0, 80)}`);
  }
  await humanIdlePause('long');
  return page;
}

// Click the Google account-chooser row matching the given email.
// The row is a div, not a button, so waitForEnabledThenClick won't
// find it. DOM-walk for any element whose visible text contains
// the email, take its bounding-box center, CDP-click.
async function clickEmailRow(page, email) {
  const cdp = await page.context().newCDPSession(page);
  try {
    let hit = null;
    for (let i = 0; i < 100; i += 1) {
      hit = await page.evaluate((e) => {
        const els = Array.from(document.querySelectorAll('*'));
        for (const el of els) {
          const txt = (el.innerText || el.textContent || '').trim();
          if (!txt.includes(e)) continue;
          if (el.children.length > 0) {
            const childMatches = Array.from(el.children).some((c) => (c.innerText || c.textContent || '').includes(e));
            if (childMatches) continue;
          }
          const r = el.getBoundingClientRect();
          if (r.width < 20 || r.height < 20) continue;
          let target = el;
          for (let p = el; p; p = p.parentElement) {
            if (p.getAttribute && (p.getAttribute('role') === 'link' || p.tagName === 'A' || p.tagName === 'LI' || p.tagName === 'BUTTON' || p.getAttribute('data-identifier'))) { target = p; break; }
          }
          const tr = target.getBoundingClientRect();
          return { x: tr.x + tr.width / 2, y: tr.y + tr.height / 2, txt: txt.slice(0, 80) };
        }
        return null;
      }, email);
      if (hit) break;
      await page.waitForTimeout(100); // allow-raw-playwright: account-row appearance poll
    }
    if (!hit) throw new Error(`clickEmailRow: no row matching ${email} found`);
    const x = Math.round(hit.x), y = Math.round(hit.y);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  } finally {
    await cdp.detach();
  }
}
