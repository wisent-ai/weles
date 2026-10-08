// Creating a Claude account on a fresh identity: the address is on an inbound
// domain Weles reads, so the sign-in code claude.ai mails is read from it,
// and the onboarding pages that follow are answered from the identity.

import { humanFill } from '../../../../dist/human/keyboard.js';
import { humanClickLocator } from '../../../../dist/human/mouse.js';
import { pageSettled } from '../../_shared/page/settled.mjs';
import { emailCodeSignIn } from '../../_shared/subscription-auth/email_code.mjs';
import { clickNamed, failOnPage, visibleText } from './page_steps.mjs';

/** claude.ai's own sign-in page; a new address is an account created. */
const LOGIN_PAGE = new URL('/login', 'https://claude.ai');

/** Where the app lands once onboarding is over. */
const APP_PATHS = /^\/(new|chats?|recents)\b/;

/** The controls onboarding pages move on with. */
const ADVANCE = /^(continue|next|get started|agree|accept|let.s go|done|skip|start)/i;

/** A name field onboarding asks to be filled. */
const NAME_FIELD =
  'input[name*="name" i],input[placeholder*="name" i],input[autocomplete="name"],input[autocomplete="given-name"]';

/** Confirmations onboarding asks to be ticked: age and terms. */
const CONSENT = /years old|of age|age requirement|terms|agree|policy|acknowledge/i;

async function fillName(page, identity) {
  const field = page.locator(NAME_FIELD).filter({ visible: true }).first();
  if (!(await field.count())) return false;
  if (await field.inputValue()) return false;
  await humanFill(page, field, `${identity.firstName} ${identity.lastName}`);
  return true;
}

async function tickConsents(page) {
  let ticked = false;
  const boxes = page.getByRole('checkbox').filter({ visible: true });
  for (const box of await boxes.all()) {
    if (await box.isChecked()) continue;
    const label = await box.evaluate(
      (element) =>
        element.closest('label')?.innerText ||
        element.getAttribute('aria-label') ||
        element.parentElement?.innerText,
    );
    if (!CONSENT.test(String(label))) continue;
    await humanClickLocator(page, box);
    ticked = true;
  }
  return ticked;
}

/**
 * Sign the identity up and walk onboarding until the app shows. Each page is
 * answered from what it shows; a page that asks for nothing this walk can
 * give (a phone number, an unknown question) fails with its DOM.
 */
export async function signUp(session, identity, mark) {
  const page = session.page;
  await session.goto(LOGIN_PAGE.href);
  await pageSettled(page);
  await emailCodeSignIn(
    session,
    { email: identity.email, loginMethod: 'email_code' },
    'anthropic',
    mark,
  );
  mark('onboarding');
  for (;;) {
    await pageSettled(page);
    if (APP_PATHS.test(new URL(page.url()).pathname)) {
      mark('account_created');
      return;
    }
    const text = await visibleText(page);
    if (/phone number|verify your phone/i.test(text))
      await failOnPage(
        page,
        'phone_verification_required',
        'onboarding',
        'claude.ai asks the new account for a phone number, which this sign-up does not supply',
      );
    const named = await fillName(page, identity);
    const ticked = await tickConsents(page);
    const advanced = await clickNamed(page, ADVANCE);
    if (!named && !ticked && !advanced)
      await failOnPage(
        page,
        'onboarding_page_unrecognized',
        'onboarding',
        'claude.ai showed an onboarding page with no name to fill, no confirmation to tick and no control to continue with',
      );
  }
}
