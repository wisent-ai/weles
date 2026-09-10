// After the password: watching for the redirect back to the caller's site, and
// answering whatever Google puts in the way first.
//
// A submitted password does not end the sign-in. Google may hand the run to a
// second factor, to a device prompt, to an OAuth consent screen, or to a
// security challenge this driver does not answer; the popup that carried the
// flow may also close and leave the main page to finish. Each of those is a
// state of a live page, so the step polls the page and names what it found.
import { humanClickLocator, humanIdlePause } from '../../../../../../dist/human/mouse.js';
import { collectGoogleAuthMethods, logGooglePageDiag } from '../page_diagnostics.mjs';
import { resolveTotpSecret } from '../totp_secret.mjs';
import { clickTryAnotherWay, handleGoogleAuthenticatorTotp } from '../authenticator_challenge.mjs';

// true when the browser reached the caller's own site (or left Google for it);
// false when Google kept the run, with the page state captured for the reason.
export async function watchGoogleRedirect(page, session, creds, opts) {
  const originHost = opts.originHost;
  const isPopup = page !== session.page;
  const defaultPostPasswordPolls = Number(process.env.GOOGLE_SSO_POST_PASSWORD_POLLS || '90');
  const devicePromptPolls = Number(process.env.GOOGLE_SSO_DEVICE_PROMPT_POLLS || '900');
  let devicePromptLogged = false;
  let totpAttempts = 0;
  for (let i = 0; i < defaultPostPasswordPolls; i++) {
    if (isPopup && page.isClosed?.()) {
      console.log('[google_sso] OAuth popup closed; checking main page');
      for (let j = 0; j < 30; j++) {
        await humanIdlePause('short');
        const u = session.page.url();
        if (originHost && u.includes(originHost) && !/login|signin/i.test(u.split('?')[0])) { console.log(`[google_sso] returned to ${originHost}`); return true; }
      }
      console.log(`[google_sso] popup closed; main page=${session.page.url()}`);
      return true;
    }
    await humanIdlePause('short');
    if (isPopup && page.isClosed?.()) {
      console.log('[google_sso] OAuth popup closed; checking main page');
      for (let j = 0; j < 20; j++) {
        await humanIdlePause('short');
        const u = session.page.url();
        if (originHost && u.includes(originHost) && !/login|signin/i.test(u.split('?')[0])) { console.log(`[google_sso] returned to ${originHost}`); return true; }
      }
      console.log(`[google_sso] popup closed; main page=${session.page.url()}`);
      return true;
    }
    const u = page.url();
    if (originHost && u.includes(originHost) && !/login|signin/i.test(u.split('?')[0])) {
      console.log(`[google_sso] main page returned to ${originHost}`);
      return true;
    }
    if (/signin\/challenge\/selection/.test(u) && resolveTotpSecret(creds)) {
      if (await handleGoogleAuthenticatorTotp(page, creds)) {
        totpAttempts += 1;
        continue;
      }
      const phonePrompt = page.locator('li, div[role="option"], div[role="button"], button, a')
        .filter({ hasText: /Tap Yes on your phone or tablet|Gmail app|phone or tablet/i })
        .filter({ visible: true })
        .first();
      if (await phonePrompt.isVisible().catch(() => false)) {
        console.log('[google_sso] selecting phone prompt before alternate-method menu');
        await humanClickLocator(page, phonePrompt).catch(() => phonePrompt.click({ force: true }));
        await humanIdlePause('deliberate');
        continue;
      }
    }
    if (totpAttempts < 3 && await handleGoogleAuthenticatorTotp(page, creds)) {
      totpAttempts += 1;
      continue;
    }
    if (/signin\/challenge\/totp/.test(u) && totpAttempts >= 3) {
      await logGooglePageDiag(page, 'authenticator_wrong_code_after_retries');
      console.log('[google_sso] FAIL: Google Authenticator TOTP code was rejected after retries');
      return false;
    }
    if (/signin\/challenge\/dp/.test(u)) {
      if (!devicePromptLogged) {
        devicePromptLogged = true;
        await logGooglePageDiag(page, 'device_prompt_waiting');
        console.log('[google_sso] waiting for Google device prompt approval');
      }
      if (resolveTotpSecret(creds)) {
        const switchedMethod = await clickTryAnotherWay(page);
        await humanIdlePause('deliberate');
        if (switchedMethod) {
          await logGooglePageDiag(page, 'device_prompt_try_another_after_click');
          if (totpAttempts < 3 && await handleGoogleAuthenticatorTotp(page, creds)) {
            totpAttempts += 1;
            continue;
          }
        }
        await logGooglePageDiag(page, 'authenticator_method_not_reached');
        console.log('[google_sso] FAIL: Google Authenticator method not reached from device prompt');
        return false;
      }
      for (let j = 0; j < devicePromptPolls; j++) {
        await humanIdlePause('short');
        const promptUrl = page.url();
        if (!/accounts\.google\.com/.test(promptUrl)) {
          console.log(`[google_sso] device prompt approved; redirected to ${promptUrl}`);
          return true;
        }
        if (!/signin\/challenge\/dp/.test(promptUrl)) break;
      }
      await logGooglePageDiag(page, 'device_prompt_not_approved');
      if (await clickTryAnotherWay(page)) {
        await logGooglePageDiag(page, 'device_prompt_try_another_methods');
        const methods = await collectGoogleAuthMethods(page);
        console.log(`[google_sso] available second-factor methods=${JSON.stringify(methods).slice(0, 3000)}`);
      }
      console.log(`[google_sso] FAIL: Google device prompt was not approved (${page.url()})`);
      return false;
    }
    // Handle OAuth consent screen — Google asks to confirm scope before redirecting back.
    if (/\/signin\/oauth\/(consent|id)/.test(u)) {
      const continueBtn = page.locator('button:has-text("Continue"), button:has-text("Allow")').filter({ visible: true }).first();
      if (await continueBtn.isVisible().catch(() => false)) {
        console.log('[google_sso] clicking OAuth consent Continue/Allow');
        await humanClickLocator(page, continueBtn);
        await humanIdlePause('deliberate');
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
  }
  await logGooglePageDiag(page, 'still_on_google');
  console.log(`[google_sso] FAIL: still on google after 90s (${page.url()})`);
  return false;
}
