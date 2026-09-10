// Google-SSO sub-flow for the OpenAI/Codex device-auth login trajectory.
//
// ROOT CAUSE: auth.openai.com's "Continue with Google" is a Google Identity
// Services (GIS) button. Clicking it with no Google session logs "Provider's
// accounts list is empty." and does nothing. So we establish a Google session
// at accounts.google.com FIRST, then reload the OpenAI device-auth URL — GIS
// then has an account and the handoff completes.
//
// This file holds that handoff. The controls it clicks, the Google credential
// entry it starts from, the authenticator code that entry answers 2FA with, the
// two mailbox steps OpenAI demands of a new identity, and the Codex consent page
// are modules beside it.
import { clickEmailRow, clickUseAnotherAccount, fillAndVerify, navEval, waitForEnabledThenClick } from './google_sso/page_controls.mjs';
import { enterGoogleCredentials, establishGoogleSession } from './google_sso/google_credentials.mjs';
import { acceptPendingWorkspaceInvite, completeEmailVerification } from './google_sso/openai_mailbox.mjs';
import { handleCodexConsentPage, isTerminalHost } from './google_sso/openai_consent.mjs';

export { establishGoogleSession } from './google_sso/google_credentials.mjs';
export { waitForEnabledThenClick } from './google_sso/page_controls.mjs';

export async function doGoogleSso({
  page, login, authorizeUrl, mark,
  humanFill, humanClickLocator, humanIdlePause, humanType,
}) {
  // WSession may reuse a provider profile. A pre-existing Google session can
  // make GIS silently authorize its default account even after we authenticated
  // the requested email in another tab. Start with no provider cookies so the
  // only Google identity available to the handoff is `login.email`.
  await page.context().clearCookies();
  mark('google_session_cleared');
  await establishGoogleSession({ page, login, mark, humanFill, humanClickLocator, humanIdlePause, humanType });

  mark('goto_authorize');
  await page.goto(authorizeUrl, { waitUntil: 'commit' });
  await humanIdlePause('deliberate');

  mark('gis_continue');
  // GIS handoff is non-deterministic (popup | in-page consent |
  // Loading | blank). Bounded state machine: poll for a terminal
  // marker; if none, reload authorizeUrl and retry.
  // retry-allowed: bounded recovery for the non-deterministic claude.ai GIS handoff, not a flaky retry.
  let popupPage = null;
  let chooserFreshTried = false;
  let inviteTried = false;
  const onPopup = (p) => { if (!popupPage) popupPage = p; };
  page.context().on('page', onPopup);
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      // "Continue with Google" is a GIS button: when it has no usable session
      // in this context it silently does nothing, and reloading the authorize
      // URL repeats that. Naming the account in OpenAI's own email field makes
      // the handoff explicit, and the Google session established above then
      // completes it without a chooser.
      if (attempt > 0) {
        const emailField = page
          .locator('input[type="email"], input[name="username"], input[name="email"], input[autocomplete="username"]')
          .filter({ visible: true })
          .first();
        if (await emailField.count() > 0 && await emailField.isVisible().catch(() => false)) {
          mark('openai_email_first');
          try {
            await fillAndVerify(page, emailField, login.email, humanClickLocator, humanType);
            await waitForEnabledThenClick(page, /^(continue|next|dalej)$/i);
            await humanIdlePause('long');
          } catch (e) {
            console.log(`[google_sso] email-first entry failed: ${e.message.slice(0, 120)}`);
          }
        }
      }
      try { await waitForEnabledThenClick(page, /continue with google|^google$/i); }
      catch (e) { console.log(`[google_sso] no continue-with-google a${attempt}: ${e.message.slice(0, 50)}`); }
      let popupHandled = false;
      for (let i = 0; i < 200; i += 1) {
        if (popupPage && !popupHandled) {
          popupHandled = true;
          console.log(`[google_sso] GIS popup: ${popupPage.url()}`);
          await popupPage.waitForLoadState('domcontentloaded');
          mark('gis_account_chooser_popup');
          await clickEmailRow(popupPage, login.email);
          await humanIdlePause('long');
          try { await waitForEnabledThenClick(popupPage, /^(continue|dalej|next)$/i); }
          catch (e) { console.log(`[google_sso] no popup consent: ${e.message.slice(0, 50)}`); }
        }
        const st = await navEval(page, () => {
          const b = Array.from(document.querySelectorAll('button,[role="button"]'));
          const c = b.find((x) => /^(authorize|allow)$/i.test((x.innerText || x.textContent || '').trim())
            && !(x.disabled || x.getAttribute('aria-disabled') === 'true'));
          return { host: location.host, pathname: location.pathname, href: location.href, consent: !!c };
        }, { host: '', pathname: '', href: '', consent: false });
        if (login.code && st.host === 'auth.openai.com' && st.pathname.startsWith('/codex/device')) {
          const codeField = page.locator('input[name="user_code"],input[name="usercode"],input[autocomplete="one-time-code"]')
            .filter({ visible: true }).first();
          if (await codeField.isVisible()) { mark('device_code_ready'); return page; }
        }
        if (await handleCodexConsentPage(page, mark)) { mark('openai_callback'); return page; }
        if (isTerminalHost(st.host, st.href)) { mark('openai_callback'); return page; }
        // OpenAI issues Codex credentials only to an identity that already has a
        // ChatGPT account, and says otherwise by parking on personal signup:
        // /add-phone, an account-creation page, or a password page for a
        // password this account never had. An invited seat gets its account by
        // accepting the invitation, so accept it once and retry the authorize
        // URL instead of reloading a page that cannot proceed.
        if (!inviteTried
            && st.host === 'auth.openai.com'
            && /\/add-phone|\/create-account|\/log-in\/password/.test(st.pathname)) {
          inviteTried = true;
          const landed = await acceptPendingWorkspaceInvite(page, login, mark);
          if (typeof landed === 'string' && /email-verification|verify-email/i.test(landed)) {
            await completeEmailVerification(page, login, mark);
          }
          await page.goto(authorizeUrl, { waitUntil: 'commit' });
          await humanIdlePause('deliberate');
          continue;
        }
        // In-page Google account chooser (happens when GIS has a session but
        // needs the user to pick the account). Select the configured email,
        // then click Continue to reach the OAuth consent page.
        if (st.host === 'accounts.google.com' && /accountchooser|identifier/.test(st.pathname)) {
          try {
            await clickEmailRow(page, login.email);
            mark('gis_account_chooser');
            await humanIdlePause('long');
            await waitForEnabledThenClick(page, /^(continue|dalej|next)$/i);
            await humanIdlePause('long');
          } catch (e) {
            console.log(`[google_sso] accountchooser handling (path=${st.pathname}): ${e.message.slice(0, 120)}`);
            // First-time account: no matching chooser row. Two page shapes are
            // possible: (a) a row chooser needing "Use another account", or (b)
            // the identifier (email-input) page with no rows at all. Try the
            // button (harmless no-op on shape b), then always try entering the
            // account fresh (fills the email input on either shape). Once only.
            if (!chooserFreshTried) {
              chooserFreshTried = true;
              try { await clickUseAnotherAccount(page); mark('gis_use_another_account'); await humanIdlePause('long'); }
              catch (e2) { console.log(`[google_sso] no use-another-account (path=${st.pathname}): ${e2.message.slice(0, 80)}`); }
              try {
                await enterGoogleCredentials({ page, login, mark, humanFill, humanClickLocator, humanIdlePause, humanType });
                await humanIdlePause('long');
              } catch (e3) {
                if (e3 && e3.fatal2fa) throw e3; // abort — do not loop back and re-trigger push/SMS
                console.log(`[google_sso] fresh-entry failed (path=${st.pathname}): ${e3.message.slice(0, 120)}`);
              }
            }
          }
          continue;
        }
        if (st.consent) {
          mark('oauth_consent_click');
          await waitForEnabledThenClick(page, /^(authorize|allow|continue|dalej|next)$/i);
          // Consent granted: Google redirects to auth.openai.com, which then
          // redirects to platform.openai.com/chatgpt.com. Wait for any OpenAI
          // terminal host; do NOT reload authorizeUrl (it would re-trigger the
          // consent flow). Single bounded wait.
          for (let k = 0; k < 1800; k += 1) {
            const h = await navEval(page, () => location.host, '');
            if (isTerminalHost(h, '')) { mark('openai_callback'); return page; }
            await page.waitForTimeout(100); // allow-raw-playwright: post-consent redirect poll
          }
          throw new Error('post-consent: no OpenAI redirect in 180s');
        }
        await page.waitForTimeout(100); // allow-raw-playwright: terminal-state poll
      }
      const where = await navEval(page, () => location.href, '?');
      console.log(`[google_sso] no terminal state a${attempt} at ${where}; reloading authorizeUrl`);
      await page.goto(authorizeUrl, { waitUntil: 'commit' });
      await humanIdlePause('deliberate');
    }
    const d = await navEval(page, () => ({ url: location.href, body: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 220) }), { url: '?', body: 'context destroyed' });
    throw new Error(`gis_continue: no consent/code after 4 attempts diag=${JSON.stringify(d)}`);
  } finally {
    page.context().off('page', onPopup);
  }
}
