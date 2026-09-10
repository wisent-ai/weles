// Signing the keeper's browser back in when Google interrupts a planner run.
// The loop reads the page, answers whatever accounts.google.com is asking for —
// identity, password, the chooser, the Authenticator code — and walks away as
// soon as the URL leaves accounts.google.com. It only ever answers the screen
// Google put up; it never steers the browser to a challenge of its own choosing.

import { generateTotp } from '../../../_shared/services/google_sso.mjs';
import { preferredEmail } from './run_brief.mjs';
import { clickControl, evalState, fillSelector, idle, press } from './keeper_browser.mjs';

const TOTP_INPUT = 'input[type="tel"], input[type="text"], input[inputmode="numeric"], input[name="totpPin"], input[name="Pin"]';

export async function handleGoogleLogin(creds) {
  for (let step = 0; step < 45; step += 1) {
    const s = await evalState(8000);
    const text = s.text || '';
    const url = s.url || '';
    if (!/accounts\.google\.com/i.test(url)) return true;
    if (/session ended|not signed in|Try signing in again|Try again/i.test(text)) {
      await clickControl('Try again', 'session expired retry').catch(() => false);
      await idle('deliberate');
      continue;
    }

    if (s.inputs.some((input) => input.visible && /email|identifier/i.test(`${input.type} ${input.name} ${input.aria}`))) {
      await fillSelector('input[type="email"], input[name="identifier"], input#identifierId', creds.email || preferredEmail(), 'Google email');
      await clickControl('^Next$', 'email next');
      continue;
    }

    if (s.inputs.some((input) => input.visible && /password|Passwd/i.test(`${input.type} ${input.name}`))) {
      await fillSelector('input[type="password"], input[name="Passwd"]', creds.password, 'Google password');
      await press('Enter');
      continue;
    }

    if (/Try another way|More ways to verify|Choose how you want to sign in|Tap Yes|Gmail app|phone or tablet/i.test(text) && !/Enter code|verification code from the Google Authenticator app/i.test(text)) {
      let after = s;
      if (/Try another way|More ways to verify/i.test(text)) {
        await clickControl('Try another way|More ways to verify', 'Try another way').catch(() => false);
        await idle('deliberate');
        after = await evalState(8000);
      }
      if (/Tap Yes on your phone|Gmail app|phone or tablet/i.test(after.text || '') && !/Try another way|More ways to verify/i.test(after.text || '')) {
        await clickControl('Tap Yes on your phone|Gmail app|phone or tablet', 'phone prompt option').catch(() => false);
        await idle('deliberate');
        continue;
      }
      if (creds?.totpSecret && /Authenticator|verification code/i.test(after.text || '')) {
        await clickControl('Google Authenticator|Authenticator|verification code', 'Authenticator option').catch(() => false);
        const code = generateTotp(creds.totpSecret);
        await fillSelector(TOTP_INPUT, code, 'Google TOTP');
        await clickControl('^Next$|^Verify$', 'TOTP submit');
        continue;
      }
      continue;
    }

    if (/Enter code|verification code|Authenticator app/i.test(text) && creds?.totpSecret) {
      const code = generateTotp(creds.totpSecret);
      await fillSelector(TOTP_INPUT, code, 'Google TOTP');
      await clickControl('^Next$|^Verify$', 'TOTP submit');
      continue;
    }

    if (/Wrong code|Try again/i.test(text) && creds?.totpSecret) {
      const code = generateTotp(creds.totpSecret, { now: Date.now() + 31_000 });
      await fillSelector(TOTP_INPUT, code, 'Google TOTP retry');
      await clickControl('^Next$|^Verify$', 'TOTP retry submit');
      continue;
    }

    await idle('short');
  }
  return false;
}
