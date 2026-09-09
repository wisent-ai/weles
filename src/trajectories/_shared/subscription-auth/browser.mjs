import { WSession } from '../../../../dist/session/wsession.js';
import { humanFill, humanType } from '../../../../dist/human/keyboard.js';
import { humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';
import { doGoogleSso as codexGoogle, establishGoogleSession } from '../../codex/google_sso.mjs';
import { doGoogleSso as claudeGoogle } from '../../claude/google_sso.mjs';
import { enterGoogleCredentials } from '../../codex/google_sso/google_credentials.mjs';
import { clickEmailRow } from '../../codex/google_sso/page_controls.mjs';
import { AuthenticationFailure } from './oauth.mjs';

const controls = { humanFill, humanType, humanClickLocator, humanIdlePause };

async function displayedCode(page) {
  while (true) {
    const code = await page.evaluate(() => {
      const pattern = /\b[A-Za-z0-9_-]{30,}#[A-Za-z0-9_-]{6,}\b/;
      for (const input of document.querySelectorAll('input,textarea')) {
        const match = String(input.value || '').match(pattern);
        if (match) return match[0];
      }
      return (document.body?.innerText || '').match(pattern)?.[0] || null;
    });
    if (code) return code;
    await page.waitForTimeout(500);
  }
}

async function emailPassword(session, login) {
  const page = session.page;
  const email = page.locator('input[type="email"],input[autocomplete="username"]').filter({ visible: true }).first();
  await humanFill(page, email, login.email);
  await session.press('Enter');
  const password = page.locator('input[type="password"]').filter({ visible: true }).first();
  await password.waitFor({ state: 'visible' });
  await humanFill(page, password, login.password);
  await session.press('Enter');
}

async function approveDevice(session, transaction, login, mark) {
  const context = session.page.context();
  let codeSubmitted = false;
  while (Date.now() < transaction.expiresAt) {
    for (const page of context.pages()) {
      if (page.isClosed()) continue;
      const url = new URL(page.url());
      if (url.hostname === 'accounts.google.com') {
        const emailField = page.locator('input[name="identifier"],input[type="email"]').filter({ visible: true }).first();
        if (await emailField.isVisible()) {
          await enterGoogleCredentials({ page, login, mark, ...controls });
        } else {
          const account = page.locator('[data-identifier]').filter({ hasText: login.email }).first();
          if (await account.isVisible()) await clickEmailRow(page, login.email);
        }
        continue;
      }
      if (!['auth.openai.com', 'chatgpt.com', 'www.kimi.com', 'kimi.com', 'auth.kimi.com'].includes(url.hostname)) continue;
      const codeField = page.locator('input[name="user_code"],input[name="usercode"],input[autocomplete="one-time-code"]').filter({ visible: true }).first();
      if (transaction.code && !codeSubmitted && await codeField.isVisible()) {
        mark('device_code');
        await humanFill(page, codeField, transaction.code);
        codeSubmitted = true;
        await page.keyboard.press('Enter');
        await humanIdlePause('long');
      }
      const google = page.getByRole('button', { name: /continue with google|sign in with google|^google$/i }).filter({ visible: true }).first();
      if (await google.isVisible()) {
        await humanClickLocator(page, google);
        await humanIdlePause('long');
        continue;
      }
      const approve = page.getByRole('button', { name: /^(current login|continue|allow|authorize|approve|confirm)$/i }).filter({ visible: true }).first();
      if (await approve.isVisible() && await approve.isEnabled()) {
        mark('provider_consent');
        await humanClickLocator(page, approve);
        return;
      }
      const text = await page.locator('body').innerText();
      if (/successfully|you may close|you can close|authorized|authorization successful/i.test(text)) return;
      if (/too many failed|account.*locked|incorrect.*code|invalid.*code/i.test(text)) {
        throw new AuthenticationFailure('provider_challenge_refused', 'provider_consent',
          'The provider refused authentication; the recorded DOM contains its response');
      }
    }
    await session.wait(1);
  }
  throw new AuthenticationFailure('authorization_not_completed', 'provider_consent', 'The provider did not complete device authorization');
}

/** The session is owned by Weles on its selected host; no OS browser opener runs. */
export async function authorizeInBrowser(account, login, transaction, mark) {
  const session = await WSession.start({
    label: `subscription-${account.subscriptionId}`, browser: 'chromium', headless: false,
  });
  try {
    mark('browser_started');
    if (transaction.provider === 'claude') {
      const page = login.loginMethod === 'google_sso'
        ? await claudeGoogle({ page: session.page, login, authorizeUrl: transaction.url, mark, ...controls })
        : await (async () => { await session.goto(transaction.url); await emailPassword(session, login); return session.page; })();
      mark('oauth_callback');
      return await displayedCode(page);
    }
    if (transaction.provider === 'codex' && login.loginMethod === 'google_sso') {
      await codexGoogle({ page: session.page, login: { ...login, code: transaction.code },
        authorizeUrl: transaction.url, mark, ...controls });
    } else {
      if (login.loginMethod === 'google_sso') {
        await establishGoogleSession({ page: session.page, login, mark, ...controls });
      }
      await session.goto(transaction.url);
      if (login.loginMethod === 'email_password') await emailPassword(session, login);
    }
    await approveDevice(session, transaction, login, mark);
    return null;
  } finally {
    await session.close();
  }
}
