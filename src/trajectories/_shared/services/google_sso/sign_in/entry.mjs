// Getting from the provider's "Sign in with Google" click to Google's password
// step — or discovering that no password is needed.
//
// Three things can happen on the way: Google recognises the account and sends
// the browser straight back to the caller's site, Google asks which account and
// then does the same, or Google asks for the identifier. The step therefore
// answers with where the run now stands, not with a boolean that cannot tell
// "already signed in" from "cannot sign in".
import { humanFill } from '../../../../../../dist/human/keyboard.js';
import { humanClickLocator, humanIdlePause } from '../../../../../../dist/human/mouse.js';
import { logGooglePageDiag } from '../page_diagnostics.mjs';

// { at: 'caller_site' }  Google finished and the browser is back on the caller's
//                        own host; there is nothing left to type.
// { at: 'password_step', passwordFieldCount }  Google wants the password next.
// { at: 'refused' }      Google never offered a way in; the reason is logged.
export async function reachGooglePasswordStep(page, creds) {
  await humanIdlePause('short');

  for (let i = 0; i < 30; i++) {
    if (/accounts\.google\.com/.test(page.url())) break;
    await humanIdlePause('short');
  }
  if (!/accounts\.google\.com/.test(page.url())) {
    console.log(`[google_sso] FAIL: never reached accounts.google.com (url=${page.url()})`);
    return { at: 'refused' };
  }

  if (/signin\/accountchooser/.test(page.url())) {
    const accountOption = page.locator('[data-identifier]')
      .filter({ hasText: new RegExp(creds.email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') })
      .or(page.getByText(creds.email, { exact: true }))
      .filter({ visible: true })
      .first();
    if (await accountOption.isVisible().catch(() => false)) {
      console.log(`[google_sso] selecting known account (${creds.email})`);
      await humanClickLocator(page, accountOption).catch(() => accountOption.click({ force: true }));
      for (let i = 0; i < 30; i++) {
        await humanIdlePause('short');
        if (!/signin\/accountchooser/.test(page.url())) break;
      }
    }
  }
  if (!/accounts\.google\.com/.test(page.url())) {
    console.log(`[google_sso] known account returned to ${page.url()}`);
    return { at: 'caller_site' };
  }
  if (/\/signin\/oauth\/(consent|id)/.test(page.url())) {
    const continueButton = page.getByRole('button', { name: /^(Continue|Allow)$/i })
      .filter({ visible: true })
      .first();
    if (await continueButton.isVisible().catch(() => false)) {
      await humanClickLocator(page, continueButton).catch(() => continueButton.click({ force: true }));
      for (let i = 0; i < 30; i++) {
        await humanIdlePause('short');
        if (!/accounts\.google\.com/.test(page.url())) {
          console.log(`[google_sso] consent returned to ${page.url()}`);
          return { at: 'caller_site' };
        }
      }
    }
  }

  const emailIn = page.locator('input[type="email"], input[name="identifier"], input#identifierId').filter({ visible: true }).first();
  let pwInVisible = await page.locator('input[type="password"], input[name="Passwd"]').filter({ visible: true }).count();
  if (!await emailIn.isVisible().catch(() => false) && pwInVisible === 0) {
    for (let i = 0; i < 30; i++) {
      await humanIdlePause('short');
      if (!/accounts\.google\.com/.test(page.url())) {
        console.log(`[google_sso] account selection returned to ${page.url()}`);
        return { at: 'caller_site' };
      }
      if (await emailIn.isVisible().catch(() => false)) break;
      pwInVisible = await page.locator('input[type="password"], input[name="Passwd"]')
        .filter({ visible: true })
        .count();
      if (pwInVisible > 0) break;
    }
  }
  if (await emailIn.isVisible().catch(() => false)) {
    await humanFill(page, emailIn, creds.email);
    console.log(`[google_sso] identifier filled (${creds.email})`);

    const idNext = page.locator('#identifierNext button, button:has-text("Next"), [jsname="LgbsSe"]').filter({ visible: true }).first();
    await humanClickLocator(page, idNext);

    // Wait for Google to leave the identifier step before probing for password/passkey.
    for (let i = 0; i < 30; i++) {
      await humanIdlePause('short');
      if (!/signin\/identifier/.test(page.url())) break;
    }
  } else if (pwInVisible > 0) {
    console.log('[google_sso] starting from visible password challenge');
  } else {
    if (!/accounts\.google\.com/.test(page.url())) {
      console.log(`[google_sso] delayed account selection returned to ${page.url()}`);
      return { at: 'caller_site' };
    }
    await logGooglePageDiag(page, 'no_identifier_or_password_input');
    console.log(`[google_sso] FAIL: no identifier or password input visible (url=${page.url()})`);
    return { at: 'refused' };
  }

  return { at: 'password_step', passwordFieldCount: pwInVisible };
}
