// Sign the active Discord account in through discord.com/login, through the
// shared login runner (../_shared/action/login.mjs): the account, its
// proxy, the kept session and the verdict are the runner's. Discord's web
// token, which it keeps in localStorage, is kept in the account beside the
// cookies.
//
// Discord answers the submitted form by landing in /channels, by blocking
// the account (which is then deactivated), or with an hCaptcha challenge,
// solved through the solving services whose keys Skarbiec holds and sent
// back through Discord's own login API. A login from an address Discord has
// not seen is authorized from the mail Discord sends for it
// (./login/new_location.mjs).
import { pageSettled } from '../_shared/page/settled.mjs';
import {
  deactivateAccount,
  deactivationClause,
} from '../../../dist/account/state.js';
import { CaptchaSolver } from '../../../dist/captcha/solver.js';
import { humanFill } from '../../../dist/human/keyboard.js';
import { detectDiscordBanSignals } from '../../../dist/platforms/discord/ban_signals.js';
import { runLogin } from '../_shared/action/login.mjs';
import {
  inboxConfigured,
  messagesTo,
} from '../../_shared/mail/skrzynka-inbox.mjs';
import {
  asksNewLocation,
  authorizeNewLocation,
} from './login/new_location.mjs';

const LOGIN_URL = 'https://discord.com/login';
const onChannels = (url) => new URL(url).pathname.startsWith('/channels');

/** One call of Discord's login API from the page, with the captcha headers. */
async function loginApi(s, formData) {
  const answer = await s.page.evaluate(
    async ({ headers, body }) => {
      const response = await fetch('/api/v9/auth/login', {
        method: 'POST',
        headers,
        body,
      });
      return {
        ok: response.ok,
        status: response.status,
        body: await response.text(),
      };
    },
    {
      headers: { 'Content-Type': 'application/json', ...s.captchaHeaders },
      body: JSON.stringify(formData),
    },
  );
  let data;
  let unreadable;
  try {
    data = JSON.parse(answer.body);
  } catch (error) {
    unreadable = error;
  }
  if (unreadable)
    throw new Error(
      `discord_login: the login API answered ${answer.status} with no JSON: ${answer.body}`,
    );
  console.log(`[discord_login] login API: ${answer.status} ${answer.body}`);
  return { ...answer, data };
}

/** Solve the login's hCaptcha, answer it through the login API, keep the token. */
async function answerCaptcha(s, acct, captchaData, formData) {
  let key;
  try {
    key = await new CaptchaSolver().solveHcaptcha(
      captchaData.captcha_sitekey,
      LOGIN_URL,
      {
        enterprisePayload: {
          rqdata: captchaData.captcha_rqdata,
          rqtoken: captchaData.captcha_rqtoken,
        },
        userAgent: await s.page.evaluate(() => navigator.userAgent),
        proxy: s.proxyConfig,
      },
    );
  } catch (error) {
    throw new Error(`DISCORD_CAPTCHA_UNSOLVED: ${error.message}`, {
      cause: error,
    });
  }
  const answered = { ...formData, captcha_key: key };
  if (captchaData.captcha_rqtoken)
    answered.captcha_rqtoken = captchaData.captcha_rqtoken;
  // The mails already in the inbox: a new-location mail Discord sends for
  // this attempt is the one not among them.
  const seenBefore = new Set(
    inboxConfigured()
      ? (await messagesTo(answered.login, 'discord.com')).map((m) => m.id)
      : [],
  );
  let answer = await loginApi(s, answered);
  if (asksNewLocation(answer)) {
    await authorizeNewLocation(s, answered.login, seenBefore);
    await pageSettled(s.page);
    answer = await loginApi(s, answered);
  }
  if (answer.data.captcha_rqdata)
    throw new Error(
      'discord_login: Discord rejected the captcha answer and issued a new challenge',
    );
  if (!answer.ok || !answer.data.token)
    throw new Error(
      `discord_login: the login API answered ${answer.status} with ${answer.body}`,
    );
  await s.page.evaluate(
    (token) => localStorage.setItem('token', JSON.stringify(token)),
    answer.data.token,
  );
  await s.patchAccount(acct.id, {
    metadata: { discord_token: answer.data.token },
  });
  await s.goto('https://discord.com/channels/@me');
  await pageSettled(s.page);
}

await runLogin({
  platform: 'discord',
  banDetector: detectDiscordBanSignals,
  // A provider filter in PROXY_URL resolves to Discord's provider row and
  // country policy through the target host.
  session: { targetHost: 'discord.com' },
  signIn: async (s, { acct, login, password }) => {
    // The register page first, so Cloudflare's clearance is set before login.
    await s.goto('https://discord.com/register');
    await pageSettled(s.page);
    await s.goto(LOGIN_URL);
    await pageSettled(s.page);
    const address = s.page
      .locator('input[type="email"], input[name="email"], input[name="login"]')
      .first();
    const secret = s.page.locator('input[type="password"]').first();
    const form = s.page.locator('form').first();
    if (
      !(await address.count()) ||
      !(await secret.count()) ||
      !(await form.count())
    )
      throw new Error(
        `DISCORD_LOGIN_FORM_MISSING: ${s.page.url()} shows no login form with an address and a password`,
      );
    await humanFill(s.page, address, login);
    await humanFill(s.page, secret, password);
    // A click on Discord's submit never resolves its navigation; submitting
    // the form fires /api/v9/auth/login, whose answer the session captures.
    await form.evaluate((element) => element.requestSubmit());
    await pageSettled(s.page);
    if (s.authBlocked) {
      const outcome = await deactivateAccount(
        acct.id,
        acct.metadata,
        s.authBlocked,
      );
      throw Object.assign(
        new Error(
          `DISCORD_AUTH_BLOCKED: Discord answered ${s.authBlocked}; ${deactivationClause(outcome, acct.username)}`,
        ),
        {
          banSignal: {
            signal: 'suspended',
            healthy: false,
            details: { reason: s.authBlocked },
          },
        },
      );
    }
    if (!onChannels(s.page.url())) {
      if (!s.captchaResponse || !s.captchaFormData)
        throw new Error(
          `discord_login: the login form answered without a captcha challenge and without logging in, at ${s.page.url()}`,
        );
      await answerCaptcha(s, acct, s.captchaResponse, s.captchaFormData);
    }
    if (!onChannels(s.page.url()))
      throw new Error(
        `discord_login: the session is at ${s.page.url()}, not in Discord, after logging in`,
      );
  },
});
