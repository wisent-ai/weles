import { WSession } from '../../../dist/session/wsession.js';
import { approveQr } from './_qr_approve.mjs';
import { humanFill } from '../../../dist/human/keyboard.js';
import { humanClickLocator } from '../../../dist/human/mouse.js';
import { pageSettled } from '../_shared/page/settled.mjs';
import { autocompleteField, field } from '../_shared/page/offers.mjs';
import { clickOffered, pageShows } from '../_shared/page/judged/seen.mjs';
import { statedProxy } from '../_shared/inputs/stated.mjs';
import { phoneForField } from '../_shared/inputs/phone.mjs';
import { GOOGLE_ACCOUNTS_HOST } from '../_shared/profile/google_session.mjs';

// hl=en: the month and gender options are chosen by their English names.
const SIGNUP_URL =
  'https://accounts.google.com/signup/v2/createaccount?biz=false&continue=https%3A%2F%2Fwww.youtube.com%2Fsignin%3Faction_handle_signin%3Dtrue&flowEntry=SignUp&flowName=GlifWebSignIn&hl=en&service=youtube';

// The flow's primary action, found by the vision model in whatever language
// Google renders its caption. False when the page offers none.
function clickNext(page) {
  return clickOffered(
    page,
    'the primary button that continues to the next step',
  );
}

function hostOf(page) {
  return new URL(page.url()).hostname;
}

// A visible phone input: Google rotates its name and id, but it autocompletes
// as tel; the birthday fields are type=tel too and are excluded by name.
async function phoneInput(page) {
  const tel = await autocompleteField(page, 'tel');
  if (tel) return tel;
  const candidates = page.locator(
    'input[type="tel"]:not([name="day"]):not([name="month"]):not([name="year"]):not(#day):not(#month):not(#year)',
  );
  const first = candidates.first();
  return (await first.isVisible()) ? first : null;
}

/** The Username input when Google has marked the given name invalid, or null. */
async function refusedUsername(page) {
  const username = page
    .locator('input[name="Username"], input[aria-label="Username"]')
    .first();
  return (await username.isVisible()) &&
    (await username.getAttribute('aria-invalid')) === 'true'
    ? username
    : null;
}

/** The phone field, reached through whatever route Google puts in front of it. */
async function reachPhoneField(page) {
  let phone = await phoneInput(page);
  if (
    !phone &&
    (await clickOffered(
      page,
      'a control that offers verifying by phone instead (another way, a text message or a call)',
    ))
  ) {
    await pageSettled(page);
    phone = await phoneInput(page);
  }
  if (phone) return phone;
  // No phone route offered: approve the QR with the saved approver session,
  // then walk the intro screens until the phone field appears; a screen with
  // no phone field and no control to continue is the failure.
  try {
    await approveQr(page);
  } catch (error) {
    throw new Error(
      `qr_code_blocked: the QR approval Google asked for failed: ${error.message}`,
      { cause: error },
    );
  }
  console.log('[google] QR approved — waiting for phone-entry page');
  while (!phone) {
    phone = await phoneInput(page);
    if (phone) break;
    if (
      !(await clickNext(page)) &&
      !(await clickOffered(
        page,
        'the button that continues or chooses to use a phone number',
      ))
    )
      throw new Error(
        `google offers no phone field and no control to continue at ${page.url()}`,
      );
    await pageSettled(page);
  }
  return phone;
}

async function signup(s) {
  const page = s.page;
  const id = await s.generateIdentity('google');
  const gmailUser = id.username.toLowerCase().replace(/[^\p{Ll}\p{Nd}]/gu, '');
  const firstName = id.firstName;
  const lastName = id.lastName;
  console.log(
    `[google] identity: ${firstName} ${lastName} / ${gmailUser}@gmail.com`,
  );

  const r = await page.goto(SIGNUP_URL, { waitUntil: 'commit' });
  console.log(`[google] signup nav ok: status=${r?.status()} url=${r?.url()}`);
  await page.locator('input[name="firstName"]').waitFor({ state: 'visible' });
  await pageSettled(page);

  console.log('[google] step 2: name');
  await s.fill('First name', firstName);
  await pageSettled(page);
  await s.fill('Last name', lastName);
  await pageSettled(page);
  await clickNext(page);
  await pageSettled(page);

  // Birthday and gender: Material comboboxes need trusted clicks. The month
  // option is the identity's month, by the name it carries.
  console.log('[google] step 3: birthday + gender');
  await humanClickLocator(page, page.locator('#month').first());
  await pageSettled(page);
  await page
    .getByRole('option', { name: id.birthMonth, exact: true })
    .first()
    .click({ force: true });
  await pageSettled(page);
  const dayLoc = page.locator('input[name="day"], input#day').first();
  if (await dayLoc.count()) await humanFill(page, dayLoc, String(id.birthDay));
  await pageSettled(page);
  const yearLoc = page.locator('input[name="year"], input#year').first();
  if (await yearLoc.count())
    await humanFill(page, yearLoc, String(id.birthYear));
  await pageSettled(page);
  await humanClickLocator(
    page,
    page.getByRole('combobox', { name: /^gender$/i }),
  );
  await pageSettled(page);
  await humanClickLocator(
    page,
    page.getByRole('option', { name: /rather not say/i }),
  );
  await pageSettled(page);

  const urlBefore = page.url();
  await clickNext(page);
  await pageSettled(page);
  if (urlBefore === page.url())
    throw new Error(
      `birthday_stuck: the birthday and gender page did not continue (${page.url()})`,
    );

  console.log(`[google] step 4: username ${gmailUser}`);
  if (await clickOffered(page, 'the option to create your own Gmail address'))
    await pageSettled(page);
  await s.fill('Username', gmailUser);
  await pageSettled(page);
  await clickNext(page);
  await pageSettled(page);

  // A username Google refuses is marked invalid on its own input; Google then
  // offers available ones, and the run takes the one it fills in.
  let chosenUser = gmailUser;
  const refused = await refusedUsername(page);
  if (refused) {
    if (
      !(await clickOffered(
        page,
        'one of the available usernames Google suggests',
      ))
    )
      throw new Error(
        `GOOGLE_USERNAME_REFUSED: Google refused ${gmailUser} and suggests no available username`,
      );
    await pageSettled(page);
    chosenUser = (await refused.inputValue()).toLowerCase();
    await clickNext(page);
    await pageSettled(page);
    if (await refusedUsername(page))
      throw new Error(
        `GOOGLE_USERNAME_REFUSED: Google refused the suggested username ${chosenUser} too`,
      );
  }

  console.log('[google] step 5: password');
  await s.fill('Password', id.password);
  await pageSettled(page);
  await s.fill('Confirm', id.password);
  await pageSettled(page);
  await clickNext(page);
  await pageSettled(page);

  // Step 6: phone verification, or the QR block in front of it. Google's
  // country picker is not a select: the field takes the whole international
  // number, rented in the stated PHONE_COUNTRY.
  console.log(`[google] step 6: url=${page.url()}`);
  const phone = await reachPhoneField(page);
  const number = await phoneForField(s, page, 'google');
  console.log(`[google] phone: ${number}`);
  await humanFill(page, phone, number);
  await pageSettled(page);
  await clickNext(page);
  await pageSettled(page);

  console.log('[google] reading the texted code...');
  const code = await s.textedCode();
  const codeField =
    (await field(page, 'code')) ??
    (await autocompleteField(page, 'one-time-code')) ??
    (await phoneInput(page));
  if (!codeField) throw new Error('google offers no field for the SMS code');
  await humanFill(page, codeField, code);
  await pageSettled(page);
  await clickNext(page);
  await pageSettled(page);

  // Steps 7+: recovery email (skip), terms (agree), confirmation — each
  // offers its control; the flow ends on a Google product. However many steps
  // Google shows are walked; a page with no control to continue is the failure.
  for (;;) {
    const host = hostOf(page);
    if (
      ['myaccount.google.com', 'mail.google.com'].includes(host) ||
      host.endsWith('youtube.com')
    )
      break;
    if (
      await pageShows(
        page,
        'Does the page show terms or a privacy agreement to scroll through and agree to?',
      )
    ) {
      await page.evaluate(() =>
        window.scrollTo({ top: document.body.scrollHeight }),
      );
      await pageSettled(page);
    }
    if (
      await clickOffered(
        page,
        'the button that agrees to the terms, skips an optional step, or confirms',
      )
    ) {
      await pageSettled(page);
      continue;
    }
    if (!(await clickNext(page)))
      throw new Error(`google offers no control to continue at ${page.url()}`);
    await pageSettled(page);
  }

  // Success is the account session (Google's SID cookie), not what the page says.
  const cookies = await s.ctx.cookies();
  if (!cookies.some((c) => c.name === 'SID' && c.domain.endsWith('google.com')))
    throw new Error(
      `no_auth_cookies: the signup ended on ${page.url()} without a Google SID cookie`,
    );

  const result = await s.saveAccount('google', {
    username: chosenUser,
    email: `${chosenUser}@gmail.com`,
    password: id.password,
    name: `${firstName} ${lastName}`,
  });
  console.log(`[google] ${result}`);
  return chosenUser;
}

console.log('\n=== Google signup ===');
const s = await WSession.start({
  label: 'google_register',
  proxy: statedProxy('the Google signup'),
  targetHost: GOOGLE_ACCOUNTS_HOST,
});
s.page.on('crash', () => console.log('[evt] RENDERER CRASHED'));
s.ctx.on('close', () => console.log('[evt] ctx.close'));
try {
  console.log(`PASS: ${await signup(s)}`);
} finally {
  await s.close();
}
