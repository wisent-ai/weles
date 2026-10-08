import { pageCondition, pageSettled } from '../page/settled.mjs';
import { WSession } from '../../../../dist/session/wsession.js';
import { humanFill, humanType } from '../../../../dist/human/keyboard.js';
import { humanClickLocator } from '../../../../dist/human/mouse.js';
import {
  doGoogleSso as codexGoogle,
  establishGoogleSession,
} from '../../codex/google_sso.mjs';
import { doGoogleSso as claudeGoogle } from '../../claude/google_sso.mjs';
import { enterGoogleCredentials } from '../../codex/google_sso/google_credentials.mjs';
import {
  clickGisTarget,
  observeGisPage,
} from '../../claude/google_sso/gis_state/page_reading.mjs';
import { AuthenticationFailure } from './oauth.mjs';
import { emailCodeSignIn, grantConsent } from './email_code.mjs';
import { captureRedirect } from './redirect.mjs';

const controls = { humanFill, humanType, humanClickLocator };

// The authorization code the provider page shows, read on every animation
// frame until it appears.
async function displayedCode(page) {
  return pageCondition(page, () => {
    const pattern = /\b[A-Za-z0-9_-]{30,}#[A-Za-z0-9_-]{6,}\b/;
    for (const input of document.querySelectorAll('input,textarea')) {
      const match = String(input.value || '').match(pattern);
      if (match) return match[0];
    }
    return (document.body?.innerText || '').match(pattern)?.[0] || null;
  });
}

async function emailPassword(session, login) {
  const page = session.page;
  const email = page
    .locator('input[type="email"],input[autocomplete="username"]')
    .filter({ visible: true })
    .first();
  await humanFill(page, email, login.email);
  await session.press('Enter');
  const password = page
    .locator('input[type="password"]')
    .filter({ visible: true })
    .first();
  await password.waitFor({ state: 'visible' });
  await humanFill(page, password, login.password);
  await session.press('Enter');
}

async function approveDevice(session, transaction, login, mark) {
  const context = session.page.context();
  let codeSubmitted = false;
  const googleDispatches = new WeakMap();
  // The provider ends this walk: consent granted, a success page, or a refusal
  // (including an expired device code) that it states on the page.
  for (;;) {
    for (const page of context.pages()) {
      if (page.isClosed()) continue;
      const url = new URL(page.url());
      if (url.hostname === 'accounts.google.com') {
        const emailField = page
          .locator('input[name="identifier"],input[type="email"]')
          .filter({ visible: true })
          .first();
        if (await emailField.isVisible()) {
          await enterGoogleCredentials({
            page,
            login,
            mark,
            humanFill,
            humanClickLocator,
            humanType,
          });
        } else {
          const view = await observeGisPage(page, login.email);
          if (view?.host === 'accounts.google.com' && view.accountRow) {
            const hit = await clickGisTarget(page, 'account_row');
            if (!hit.clicked) {
              throw new AuthenticationFailure(
                'gis_control_unavailable',
                'google_account_chooser',
                `The requested Google account row was not clicked: ${hit.reason}`,
              );
            }
          }
        }
        continue;
      }
      if (
        ![
          'auth.openai.com',
          'chatgpt.com',
          'www.kimi.com',
          'kimi.com',
          'auth.kimi.com',
        ].includes(url.hostname)
      )
        continue;
      const codeField = page
        .locator(
          'input[name="user_code"],input[name="usercode"],input[autocomplete="one-time-code"]',
        )
        .filter({ visible: true })
        .first();
      if (transaction.code && !codeSubmitted && (await codeField.isVisible())) {
        mark('device_code');
        await humanFill(page, codeField, transaction.code);
        codeSubmitted = true;
        await page.keyboard.press('Enter');
        await pageSettled(page);
      }
      const google = page
        .getByRole('button', {
          name: /continue with google|sign in with google|^google$/i,
        })
        .filter({ visible: true })
        .first();
      if (
        (await google.isVisible()) &&
        googleDispatches.get(page) !== page.url()
      ) {
        if (!(await google.isEnabled())) {
          throw new AuthenticationFailure(
            'gis_control_unavailable',
            'device_google_handoff',
            `The offered Google sign-in control is disabled on ${page.url()}`,
          );
        }
        const dispatchedFrom = page.url();
        await humanClickLocator(page, google);
        googleDispatches.set(page, dispatchedFrom);
        await pageSettled(page);
        continue;
      }
      const approve = page
        .getByRole('button', {
          name: /^(current login|continue|allow|authorize|approve|confirm)$/i,
        })
        .filter({ visible: true })
        .first();
      if ((await approve.isVisible()) && (await approve.isEnabled())) {
        mark('provider_consent');
        await humanClickLocator(page, approve);
        return;
      }
      const text = await page.locator('body').innerText();
      if (
        /successfully|you may close|you can close|authorized|authorization successful/i.test(
          text,
        )
      )
        return;
      if (
        /too many failed|account.*locked|incorrect.*code|invalid.*code|code.*expired|expired.*code/i.test(
          text,
        )
      ) {
        throw new AuthenticationFailure(
          'provider_challenge_refused',
          'provider_consent',
          'The provider refused authentication; the recorded DOM contains its response',
        );
      }
    }
    await pageSettled(session.page);
  }
}

/** The session is owned by Weles on its selected host; no OS browser opener runs.
 *
 * `transaction.redirectUri`, when set, is a harness's own callback listener:
 * the provider's redirect to it is caught in the browser and its URL is the
 * answer instead of the code a console page shows. `reuse` is a session an
 * acquisition already signed in; it is driven and left open for its owner. */
export async function authorizeInBrowser(
  account,
  login,
  transaction,
  mark,
  reuse = null,
) {
  const session =
    reuse ??
    (await WSession.start({
      label: `subscription-${account.subscriptionId}`,
      browser: 'chromium',
      headless: false,
    }));
  try {
    mark('browser_started');
    if (transaction.provider === 'claude') {
      const redirected = transaction.redirectUri
        ? await captureRedirect(session.page.context(), transaction.redirectUri)
        : null;
      const signedIn =
        login.loginMethod === 'google_sso'
          ? claudeGoogle({
              page: session.page,
              login,
              authorizeUrl: transaction.url,
              mark,
              ...controls,
            })
          : (async () => {
              await session.goto(transaction.url);
              if (login.loginMethod === 'email_code') {
                if (!reuse)
                  await emailCodeSignIn(session, login, 'anthropic', mark);
                await grantConsent(session.page, mark);
              } else {
                await emailPassword(session, login);
              }
              return session.page;
            })();
      if (redirected) {
        // The redirect ends the walk whichever way the page got there. A
        // sign-in step that fails after the redirect was caught is moot, and
        // one that fails before it is the failure.
        const walked = signedIn.then(
          () => ({ failed: false }),
          (error) => ({ failed: true, error }),
        );
        const url = await Promise.race([
          redirected.captured,
          walked.then((walk) =>
            walk.failed ? Promise.reject(walk.error) : redirected.captured,
          ),
        ]);
        mark('oauth_redirect');
        return url;
      }
      const page = await signedIn;
      mark('oauth_callback');
      return await displayedCode(page);
    }
    if (
      transaction.provider === 'codex' &&
      login.loginMethod === 'google_sso'
    ) {
      await codexGoogle({
        page: session.page,
        login: { ...login, code: transaction.code },
        authorizeUrl: transaction.url,
        mark,
        ...controls,
      });
    } else {
      if (login.loginMethod === 'google_sso') {
        await establishGoogleSession({
          page: session.page,
          login,
          mark,
          humanFill,
          humanClickLocator,
          humanType,
        });
      }
      await session.goto(transaction.url);
      if (login.loginMethod === 'email_password')
        await emailPassword(session, login);
    }
    await approveDevice(session, transaction, login, mark);
    return null;
  } finally {
    if (!reuse) await session.close();
  }
}
