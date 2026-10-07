// Getting from the provider's "Sign in with Google" click to Google's password
// step — or discovering that no password is needed.
//
// Three things can happen on the way: Google recognises the account and sends
// the browser straight back to the caller's site, Google asks which account and
// then does the same, or Google asks for the identifier. The step therefore
// answers with where the run now stands, not with a boolean that cannot tell
// "already signed in" from "cannot sign in".
import { humanFill } from '../../../../../../dist/human/keyboard.js';
import { humanClickLocator } from '../../../../../../dist/human/mouse.js';
import { pageSettled, submitAnswered } from '../../../page/settled.mjs';
import { logGooglePageDiag } from '../page_diagnostics.mjs';

// A click on a Google sign-in control either moves the page to another URL or
// makes Google show its own message in place; whichever happens first ends the
// wait, and the page then settles before it is read.
async function googleAnswered(page, beforeUrl) {
  const message = page
    .locator('[aria-live="assertive"]')
    .filter({ hasText: /\S/ })
    .filter({ visible: true })
    .first();
  await submitAnswered(page, (url) => url === beforeUrl, message);
}

// { at: 'caller_site' }  Google finished and the browser is back on the caller's
//                        own host; there is nothing left to type.
// { at: 'password_step', passwordFieldCount }  Google wants the password next.
// { at: 'refused' }      Google never offered a way in; the reason is logged.
export async function reachGooglePasswordStep(page, creds) {
  // The provider's redirect chain has finished once the page has settled.
  await pageSettled(page);
  if (!/accounts\.google\.com/.test(page.url())) {
    console.log(
      `[google_sso] FAIL: never reached accounts.google.com (url=${page.url()})`,
    );
    return { at: 'refused' };
  }

  if (/signin\/accountchooser/.test(page.url())) {
    // The chooser lists an account as a row whose text is the display name and
    // the address. Older markup carried `data-identifier` on that row; the
    // current one carries `data-email` or no attribute at all. The page reads
    // "Choose an account to continue to <app> <display name> <address> Use
    // another account", exposes no input and one button, and a locator bound
    // to `data-identifier` matches nothing, so this step would walk on to the
    // identifier field that the chooser does not have. Match the row by the
    // address it shows, whatever wraps it, and take the innermost match rather
    // than the container that also contains it.
    const address = creds.email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const accountOption = page
      .locator(
        '[data-identifier], [data-email], li, [role="link"], [role="button"], div',
      )
      .filter({ hasText: new RegExp(`^\\s*[^\\n]{0,120}${address}\\s*$`, 'i') })
      .filter({ visible: true })
      .last()
      .or(
        page
          .getByText(creds.email, { exact: true })
          .filter({ visible: true })
          .first(),
      );
    if (await accountOption.isVisible()) {
      console.log(`[google_sso] selecting known account (${creds.email})`);
      const beforeUrl = page.url();
      await humanClickLocator(page, accountOption);
      await googleAnswered(page, beforeUrl);
    } else {
      // The declared account is not on the list. "Use another account" leads to
      // the identifier step; without it, the chooser offers no fresh entry.
      const another = page
        .getByText(/use another account/i)
        .filter({ visible: true })
        .first();
      if (await another.isVisible()) {
        console.log(
          '[google_sso] account not listed on the chooser; choosing another account',
        );
        const beforeUrl = page.url();
        await humanClickLocator(page, another);
        await googleAnswered(page, beforeUrl);
      }
    }
  }
  if (!/accounts\.google\.com/.test(page.url())) {
    console.log(`[google_sso] known account returned to ${page.url()}`);
    return { at: 'caller_site' };
  }
  if (/\/signin\/oauth\/(consent|id)/.test(page.url())) {
    const continueButton = page
      .getByRole('button', { name: /^(Continue|Allow)$/i })
      .filter({ visible: true })
      .first();
    if (await continueButton.isVisible()) {
      const beforeUrl = page.url();
      await humanClickLocator(page, continueButton);
      await googleAnswered(page, beforeUrl);
      if (!/accounts\.google\.com/.test(page.url())) {
        console.log(`[google_sso] consent returned to ${page.url()}`);
        return { at: 'caller_site' };
      }
    }
  }

  const emailIn = page
    .locator(
      'input[type="email"], input[name="identifier"], input#identifierId',
    )
    .filter({ visible: true })
    .first();
  let pwInVisible = await page
    .locator('input[type="password"], input[name="Passwd"]')
    .filter({ visible: true })
    .count();
  if (!(await emailIn.isVisible()) && pwInVisible === 0) {
    await pageSettled(page);
    if (!/accounts\.google\.com/.test(page.url())) {
      console.log(`[google_sso] account selection returned to ${page.url()}`);
      return { at: 'caller_site' };
    }
    pwInVisible = await page
      .locator('input[type="password"], input[name="Passwd"]')
      .filter({ visible: true })
      .count();
  }
  if (await emailIn.isVisible()) {
    await humanFill(page, emailIn, creds.email);
    console.log(`[google_sso] identifier filled (${creds.email})`);

    const idNext = page
      .locator(
        '#identifierNext button, button:has-text("Next"), [jsname="LgbsSe"]',
      )
      .filter({ visible: true })
      .first();
    const beforeUrl = page.url();
    await humanClickLocator(page, idNext);

    // Google leaves the identifier step, or says in place why it will not.
    await googleAnswered(page, beforeUrl);
    if (/signin\/identifier/.test(page.url())) {
      await logGooglePageDiag(page, 'identifier_refused');
      console.log(
        `[google_sso] FAIL: Google kept the identifier step (url=${page.url()})`,
      );
      return { at: 'refused' };
    }
  } else if (pwInVisible > 0) {
    console.log('[google_sso] starting from visible password challenge');
  } else {
    if (!/accounts\.google\.com/.test(page.url())) {
      console.log(
        `[google_sso] delayed account selection returned to ${page.url()}`,
      );
      return { at: 'caller_site' };
    }
    await logGooglePageDiag(page, 'no_identifier_or_password_input');
    console.log(
      `[google_sso] FAIL: no identifier or password input visible (url=${page.url()})`,
    );
    return { at: 'refused' };
  }

  return { at: 'password_step', passwordFieldCount: pwInVisible };
}
