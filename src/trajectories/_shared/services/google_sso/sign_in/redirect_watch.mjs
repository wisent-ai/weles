// After the password: watching for the redirect back to the caller's site, and
// answering whatever Google puts in the way first.
//
// A submitted password does not end the sign-in. Google may hand the run to a
// second factor, to a device prompt, to an OAuth consent screen, or to a
// security challenge this driver does not answer; the popup that carried the
// flow may also close and leave the main page to finish. Each of those is a
// state of a live page, so the step reads the settled page, answers the state
// it shows once, and names the state it cannot leave.
import { humanClickLocator } from '../../../../../../dist/human/mouse.js';
import { pageSettled, urlMatching } from '../../../page/settled.mjs';
import { collectGoogleAuthMethods, logGooglePageDiag } from '../page_diagnostics.mjs';
import { resolveTotpSecret } from '../totp_secret.mjs';
import { clickTryAnotherWay, handleGoogleAuthenticatorTotp } from '../authenticator_challenge.mjs';

// Settles `page`, or resolves when it closes first.
async function settledOrClosed(page) {
  await Promise.any([page.waitForEvent('close'), pageSettled(page)]);
}

// true when the browser reached the caller's own site (or left Google for it);
// false when Google kept the run, with the page state captured for the reason.
export async function watchGoogleRedirect(page, session, creds, opts) {
  const originHost = opts.originHost;
  const isPopup = page !== session.page;
  let totpAttempted = false;
  let phonePromptChosen = false;
  const consentAnswered = new Set();
  for (;;) {
    if (!(isPopup && page.isClosed?.())) await settledOrClosed(page);
    if (isPopup && page.isClosed?.()) {
      console.log('[google_sso] OAuth popup closed; checking main page');
      await pageSettled(session.page);
      const u = session.page.url();
      if (originHost && u.includes(originHost) && !/login|signin/i.test(u.split('?')[0])) console.log(`[google_sso] returned to ${originHost}`);
      else console.log(`[google_sso] popup closed; main page=${u}`);
      return true;
    }
    const u = page.url();
    if (originHost && u.includes(originHost) && !/login|signin/i.test(u.split('?')[0])) {
      console.log(`[google_sso] main page returned to ${originHost}`);
      return true;
    }
    // One authenticator code per sign-in: a rejected code is answered by name,
    // not by typing the next one into the same challenge.
    if (!totpAttempted && /signin\/challenge\/selection/.test(u) && resolveTotpSecret(creds)) {
      if (await handleGoogleAuthenticatorTotp(page, creds)) {
        totpAttempted = true;
        continue;
      }
      const phonePrompt = page.locator('li, div[role="option"], div[role="button"], button, a')
        .filter({ hasText: /Tap Yes on your phone or tablet|Gmail app|phone or tablet/i })
        .filter({ visible: true })
        .first();
      if (!phonePromptChosen && await phonePrompt.isVisible().catch(() => false)) {
        phonePromptChosen = true;
        console.log('[google_sso] selecting phone prompt before alternate-method menu');
        await humanClickLocator(page, phonePrompt).catch(() => phonePrompt.click({ force: true }));
        continue;
      }
    }
    if (!totpAttempted && await handleGoogleAuthenticatorTotp(page, creds)) {
      totpAttempted = true;
      continue;
    }
    if (/signin\/challenge\/totp/.test(u) && totpAttempted) {
      await logGooglePageDiag(page, 'authenticator_wrong_code');
      console.log('[google_sso] FAIL: Google Authenticator TOTP code was rejected');
      return false;
    }
    if (/signin\/challenge\/dp/.test(u)) {
      await logGooglePageDiag(page, 'device_prompt_waiting');
      if (resolveTotpSecret(creds)) {
        const switchedMethod = await clickTryAnotherWay(page);
        if (switchedMethod) {
          await logGooglePageDiag(page, 'device_prompt_try_another_after_click');
          if (!totpAttempted && await handleGoogleAuthenticatorTotp(page, creds)) {
            totpAttempted = true;
            continue;
          }
        }
        await logGooglePageDiag(page, 'authenticator_method_not_reached');
        console.log('[google_sso] FAIL: Google Authenticator method not reached from device prompt');
        return false;
      }
      // The approval happens on the account owner's phone; Google moves the
      // page off the prompt when it arrives (or when the prompt is declined).
      console.log('[google_sso] waiting for Google device prompt approval');
      const promptUrl = await urlMatching(page, (next) => !/signin\/challenge\/dp/.test(next));
      if (!/accounts\.google\.com/.test(promptUrl)) {
        console.log(`[google_sso] device prompt approved; redirected to ${promptUrl}`);
        return true;
      }
      if (/signin\/challenge\/dp|challenge\/selection/.test(promptUrl)) {
        await logGooglePageDiag(page, 'device_prompt_not_approved');
        if (await clickTryAnotherWay(page)) {
          const methods = await collectGoogleAuthMethods(page);
          console.log(`[google_sso] available second-factor methods=${JSON.stringify(methods)}`);
        }
        console.log(`[google_sso] FAIL: Google device prompt was not approved (${page.url()})`);
        return false;
      }
      continue;
    }
    // Handle OAuth consent screen — Google asks to confirm scope before redirecting back.
    if (/\/signin\/oauth\/(consent|id)/.test(u) && !consentAnswered.has(u)) {
      const continueBtn = page.locator('button:has-text("Continue"), button:has-text("Allow")').filter({ visible: true }).first();
      if (await continueBtn.isVisible().catch(() => false)) {
        consentAnswered.add(u);
        console.log('[google_sso] clicking OAuth consent Continue/Allow');
        await humanClickLocator(page, continueBtn);
        continue;
      }
    }
    // For popup mode: only return when the popup ITSELF leaves accounts.google.com (storagerelay redirect or dashboard redirect).
    if (isPopup && originHost && u.includes(originHost) && !/accounts\.google\.com/.test(u) && !/login|signin/i.test(u.split('?')[0])) { console.log(`[google_sso] popup redirected to ${originHost}`); return true; }
    if (!isPopup && originHost && u.includes(originHost) && !/login|signin/i.test(u.split('?')[0])) { console.log(`[google_sso] main page returned to ${originHost}`); return true; }
    if (!isPopup && !originHost && !/accounts\.google\.com/.test(u) && !/login|signin/i.test(u.split('?')[0])) { console.log(`[google_sso] redirected off google to ${u}`); return true; }
    if (/challenge\/(deviceauth|recaptcha|az|kpe|sk)/.test(u)) {
      await logGooglePageDiag(page, 'security_challenge');
      console.log(`[google_sso] FAIL: hit Google challenge ${u}`);
      return false;
    }
    // Still on the password step: Google is checking the password. It answers
    // by moving the page on, or by saying in place why it will not.
    if (/challenge\/pwd/.test(u)) {
      const message = page.locator('[aria-live="assertive"]').filter({ hasText: /\S/ }).filter({ visible: true }).first();
      await Promise.any([urlMatching(page, (next) => next !== u), message.waitFor({ state: 'visible' })]);
      if (page.url() === u) {
        await logGooglePageDiag(page, 'password_refused');
        console.log(`[google_sso] FAIL: google_password_refused — ${(await message.innerText())}`);
        return false;
      }
      continue;
    }
    // Nothing on the settled page is a state this step answers.
    await logGooglePageDiag(page, 'still_on_google');
    console.log(`[google_sso] FAIL: google_sign_in_state_unanswered — the settled page is not one this step drives (${u})`);
    return false;
  }
}
