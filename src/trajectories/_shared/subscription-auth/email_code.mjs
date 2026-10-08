// Signing in with the one-time code a provider mails to the account's
// address: the method of every account an acquisition buys, whose address is
// on an inbound domain Weles reads.

import { humanFill } from '../../../../dist/human/keyboard.js';
import { humanClickLocator } from '../../../../dist/human/mouse.js';
import { pageSettled } from '../page/settled.mjs';
import { AuthenticationFailure } from './oauth.mjs';

/**
 * Wait for the code the provider mailed to `email`. A mail has no clock that
 * ends its delivery, so the mailbox is read again as soon as each reading
 * answers, and the wait ends when the code arrives, when the mailbox answers
 * with an error, or when the run is cancelled (`weles runs cancel`).
 */
export async function waitForMailedCode(session, email, sender, mark) {
  mark('email_code_waiting');
  for (;;) {
    const answer = await session.checkEmail(email, sender);
    if (/^\d+$/.test(answer)) return answer;
    if (/^error|without numeric code/.test(answer))
      throw new AuthenticationFailure(
        'email_code_unreadable',
        'email_code',
        `the sign-in mail to ${email} could not be read as a code: ${answer}`,
      );
  }
}

/** Enter the address, wait for the mailed code, enter it. */
export async function emailCodeSignIn(session, login, sender, mark) {
  const page = session.page;
  const email = page
    .locator('input[type="email"],input[autocomplete="email"],input[name="email"]')
    .filter({ visible: true })
    .first();
  await email.waitFor({ state: 'visible' });
  await humanFill(page, email, login.email);
  await session.press('Enter');
  mark('email_code_requested');
  const code = await waitForMailedCode(session, login.email, sender, mark);
  const box = page
    .locator(
      'input[autocomplete="one-time-code"],input[name="code"],input[inputmode="numeric"],input[id*="code" i]',
    )
    .filter({ visible: true })
    .first();
  await box.waitFor({ state: 'visible' });
  await humanFill(page, box, code);
  await session.press('Enter');
  await pageSettled(page);
  mark('email_code_entered');
}

/** Grant the authorization the provider's consent page asks for. */
export async function grantConsent(page, mark) {
  const grant = page
    .getByRole('button', { name: /^(authorize|allow|approve)\b/i })
    .first();
  await grant.waitFor({ state: 'visible' });
  mark('oauth_consent');
  await humanClickLocator(page, grant);
  await pageSettled(page);
}
