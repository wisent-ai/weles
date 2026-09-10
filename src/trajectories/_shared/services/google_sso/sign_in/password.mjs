// Reaching Google's password field and submitting the password.
//
// Google does not always show that field: a "Welcome" page may list sign-in
// methods, and a passkey-only page may hide it behind "Try another way". So the
// step walks a bounded number of transitions until a password field is on
// screen, and refuses by name when none ever is.
import { humanFill } from '../../../../../../dist/human/keyboard.js';
import { humanClickLocator, humanIdlePause } from '../../../../../../dist/human/mouse.js';
import { logGooglePageDiag } from '../page_diagnostics.mjs';
import { clickTryAnotherWay } from '../authenticator_challenge.mjs';

// true once the password has been typed and submitted; false when Google never
// offered the field, with the reason logged and its page state captured.
export async function submitGooglePassword(page, creds, passwordFieldCount) {
  // Loop: at each step, try to land on a visible password input. Click
  // "Enter your password" / "Use your password" if offered, "Try another way"
  // if we're on the passkey-only page. Up to 8 transitions before giving up.
  let pwInVisible = passwordFieldCount || 0;
  for (let step = 0; step < 8; step++) {
    for (let i = 0; i < 40; i++) {
      await humanIdlePause('short');
      pwInVisible = await page.locator('input[type="password"], input[name="Passwd"]').filter({ visible: true }).count();
      if (pwInVisible > 0) break;
    }
    if (pwInVisible > 0) break;

    // Google's "Welcome" / challenge selection page lists sign-in methods.
    // Explicitly pick "Enter your password" / "Use your password" instead of
    // looping on "Try another way". The option may be a listitem, div, or
    // button, and Playwright's visible filter can be flaky on the listitem
    // itself, so ask by semantic role first, then by text, then by the nearest
    // clickable ancestor of that text.
    if (/signin\/challenge\/(selection|pk\/presend)/.test(page.url())) {
      // The selection options can appear slightly after the page URL changes.
      // Wait for the password option text before asking by text or by ancestor.
      for (let i = 0; i < 30; i++) {
        const hasPwOption = await page.evaluate(() => /Enter your password|Use your password/i.test(document.body?.innerText || ''));
        if (hasPwOption) break;
        await humanIdlePause('short');
      }

      const pwOptionNames = [/Enter your password/i, /Use your password/i];
      let clickedChoice = false;
      for (const nameRe of pwOptionNames) {
        const semantic = page.getByRole('button', { name: nameRe, exact: false }).or(page.getByRole('link', { name: nameRe, exact: false })).filter({ visible: true }).first();
        if (await semantic.isVisible().catch(() => false)) {
          console.log(`[google_sso] clicking password option via role (${nameRe.source})`);
          await semantic.click({ force: true }).catch(() => humanClickLocator(page, semantic));
          clickedChoice = true;
          break;
        }
        const textual = page.locator('li, div[role="option"], div[role="button"], button, a').filter({ hasText: nameRe }).filter({ visible: true }).first();
        if (await textual.isVisible().catch(() => false)) {
          console.log(`[google_sso] clicking password option via text (${nameRe.source})`);
          await textual.click({ force: true }).catch(() => humanClickLocator(page, textual));
          clickedChoice = true;
          break;
        }
        // Last resort: find the text node and click its nearest clickable ancestor.
        const nearestClickable = page.locator('button, [role="button"], a, [role="link"], li, [role="option"]').filter({ hasText: nameRe }).filter({ visible: true }).first();
        const foundByJs = await humanClickLocator(page, nearestClickable).then(() => true).catch(() => false);
        if (foundByJs) {
          console.log(`[google_sso] clicked password option via JS ancestor (${nameRe.source})`);
          clickedChoice = true;
          break;
        }
      }
      if (clickedChoice) {
        await humanIdlePause('deliberate');
        // Wait for password field to appear on the next screen.
        for (let i = 0; i < 30; i++) {
          await humanIdlePause('short');
          pwInVisible = await page.locator('input[type="password"], input[name="Passwd"]').filter({ visible: true }).count();
          if (pwInVisible > 0) break;
        }
        if (pwInVisible > 0) break;
        continue;
      }
    }

    if (await clickTryAnotherWay(page)) {
      continue;
    }

    console.log(`[google_sso] no progress option visible (url=${page.url()})`);
    break;
  }

  if (!pwInVisible) {
    await logGooglePageDiag(page, 'no_password_input');
    console.log(`[google_sso] FAIL: never reached password input (url=${page.url()})`);
    return false;
  }

  const pwIn = page.locator('input[type="password"], input[name="Passwd"]').filter({ visible: true }).first();
  await humanFill(page, pwIn, creds.password);
  console.log('[google_sso] password filled');

  // Primary submit: press Enter while the password field still has focus.
  // Google's password form reliably submits on Enter in the input; previous
  // attempts to click the Next button hung because the button locator matched
  // a non-actionable / overlay element.
  console.log('[google_sso] pressing Enter to submit password');
  await page.keyboard.press('Enter');
  await humanIdlePause('deliberate');

  if (/challenge\/pwd/.test(page.url()) && await pwIn.isVisible().catch(() => false)) {
    console.log('[google_sso] password page still visible after Enter; clicking Next');
    const currentPasswordLength = await pwIn.evaluate((el) => String(el.value || '').length);
    if (currentPasswordLength === 0) {
      console.log('[google_sso] password input was cleared before the Next click; refilling');
      await humanFill(page, pwIn, creds.password);
    }
    const nextByRole = page.getByRole('button', { name: 'Next', exact: true }).filter({ visible: true }).last();
    const nextByText = page.locator('button, [role="button"]').filter({ hasText: /^\s*Next\s*$/i }).filter({ visible: true }).last();
    const passwordNextLegacy = page.locator('#passwordNext button').filter({ visible: true }).first();
    const genericNext = page.getByRole('button', { name: /^(Next|Sign in|Continue)$/i }).filter({ visible: true }).last();
    let nextBtn = null;
    for (const candidate of [nextByRole, nextByText, passwordNextLegacy, genericNext]) {
      if (await candidate.isVisible().catch(() => false)) { nextBtn = candidate; break; }
    }
    if (nextBtn) {
      await humanClickLocator(page, nextBtn).catch(async () => {
        console.log('[google_sso] native click failed, trying human click');
        await humanClickLocator(page, nextBtn);
      });
    }
    await humanIdlePause('deliberate');
  }

  // Dispatch blur/focusout only after attempting submit. Google auto-submits
  // some flows, and then the document this evaluate was written against is
  // already gone — that navigation is the wanted outcome, not a failure. Any
  // other error is this page refusing the events and is raised.
  try {
    await pwIn.evaluate((el) => {
      el.dispatchEvent(new Event('blur', { bubbles: true }));
      el.dispatchEvent(new Event('focusout', { bubbles: true }));
    });
  } catch (error) {
    if (!error.message.includes('Execution context was destroyed')) throw error;
  }

  return true;
}
