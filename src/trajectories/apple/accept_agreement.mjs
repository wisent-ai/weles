// Apple Developer Program License Agreement acceptance: one guarded run
// (guarded/run.mjs) signs the Account Holder into the developer portal once
// (guarded/sign_in.mjs), opens the agreement Apple says is waiting, accepts it
// and reads the portal again to see that it no longer asks. Stado owns
// execution and placement.
//
// Until the Account Holder accepts an updated agreement, Apple refuses every
// provisioning request of the team: a TestFlight build ended with "Unable to
// process request - PLA Update available: You currently don't have access to
// this membership resource". Only the Account Holder can accept it, which is
// why this runs under the same guarded sign-in as apple_login.
import { clickDescribed, pageShows } from '../_shared/page/judged/seen.mjs';
import { pageSettled } from '../_shared/page/settled.mjs';
import { runGuarded } from './guarded/run.mjs';
import { signInGuarded } from './guarded/sign_in.mjs';

const PREFIX = '[apple-accept-agreement]';
const ACCOUNT_URL = new URL('https://developer.apple.com/account');
const ACCOUNT_ROUTE = ACCOUNT_URL.pathname;

/** On the developer portal's account pages. */
const onDeveloperPortal = (url) =>
  url.hostname === ACCOUNT_URL.hostname && url.pathname.startsWith(ACCOUNT_ROUTE);

const ASKS =
  'a notice that an updated Apple Developer Program License Agreement must be reviewed or agreed to';

/** Whether the portal asks the Account Holder to accept an agreement now. */
async function agreementWaiting(page) {
  await page.goto(ACCOUNT_URL.href, { waitUntil: 'domcontentloaded' });
  await pageSettled(page);
  return pageShows(page, `Does the page show ${ASKS}?`);
}

await runGuarded({
  label: 'apple_accept_agreement',
  prefix: PREFIX,
  act: async (s, guard) => {
    await s.page.goto(ACCOUNT_URL.href, { waitUntil: 'domcontentloaded' });
    await pageSettled(s.page);
    await signInGuarded(s, guard, onDeveloperPortal, PREFIX);
    if (!(await agreementWaiting(s.page)))
      return `No agreement waits on ${s.page.url()}: the portal asks the Account Holder to accept nothing`;
    console.log(`${PREFIX} AGREEMENT_WAITING`);
    await clickDescribed(s.page, `the control that opens ${ASKS}`);
    await clickDescribed(
      s.page,
      'the checkbox confirming that the agreement was read and is agreed to',
    );
    await clickDescribed(s.page, 'the button that agrees to the agreement');
    console.log(`${PREFIX} AGREE_SUBMITTED`);
    if (await agreementWaiting(s.page))
      throw new Error(
        `APPLE_AGREEMENT_STILL_WAITING: after agreeing, ${s.page.url()} still shows ${ASKS}`,
      );
    return `Apple Developer Program License Agreement accepted; ${ACCOUNT_URL.href} no longer asks for it`;
  },
});
