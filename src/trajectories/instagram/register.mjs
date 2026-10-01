import { WSession } from '../../../dist/session/wsession.js';
import { runRecordingsDir } from '../../../dist/session/run-recordings.js';
import { humanType, humanFill } from '../../../dist/human/keyboard.js';
import { humanIdlePause } from '../../../dist/human/mouse.js';
import { autoBindCharacter } from '../lib/character-bind.mjs';
import { pickInstagramProxy } from '../lib/instagram-proxy.mjs';
import { pageSettled } from '../_shared/page/settled.mjs';
import { autocompleteField, field } from '../_shared/page/offers.mjs';

const URL = 'https://www.instagram.com/accounts/emailsignup/';
// The SMS countries to order numbers from, in the order tried.
const COUNTRY_ORDER = (process.env.INSTAGRAM_SMS_COUNTRIES || 'UK,NL,US').split(',').map((c) => c.trim()).filter(Boolean);
const NO_CODE = 'no code received';

// Instagram's post-signup flow is told apart by its URL path and by the
// input the page asks for, never by the page's words.
const PATH = {
  passwordReset: '/accounts/password/reset',
  suspended: '/accounts/suspended',
  challenge: '/challenge',
  signup: '/accounts/emailsignup',
};

function pathOf(page) {
  return new globalThis.URL(page.url()).pathname;
}

async function visible(locator) {
  return (await locator.isVisible()) ? locator : null;
}

async function codeField(page) {
  return (await field(page, 'email_confirmation_code')) ?? (await autocompleteField(page, 'one-time-code'))
    ?? (await visible(page.locator('input[maxlength="6"]').first()));
}

// What the page asks for right now.
async function state(page) {
  const path = pathOf(page);
  if (path.startsWith(PATH.passwordReset)) return 'password_reset';
  if (await codeField(page)) return 'code';
  const challenged = path.startsWith(PATH.suspended) || path.startsWith(PATH.challenge);
  if (challenged) {
    if (await visible(page.locator('input[type="file"]').first())) return 'selfie';
    if (await visible(page.locator('input[type="tel"]').first())) return 'phone';
    return 'challenge';
  }
  if (path.startsWith(PATH.signup) && (await field(page, 'username'))) return 'form';
  return 'in';
}

// Instagram renders its buttons as role="button" containers; a trusted mouse
// move crashes its page, so clicks go through the untrusted jsClick atom and
// the result says whether a control was found.
async function pressAny(s, names) {
  for (const name of names) {
    const r = await s.jsClick('[role="button"], a[role="button"]', name);
    if (r !== 'no-element-found') return name;
  }
  return null;
}

async function phoneVerification(s, page) {
  for (let phoneAttempt = 0; !page.isClosed(); phoneAttempt++) {
    const country = COUNTRY_ORDER[phoneAttempt % COUNTRY_ORDER.length];
    const phone = await s.checkSms('instagram', country);
    console.log(`[ig] SMS attempt ${phoneAttempt + 1} (${country}): ${phone}`);
    if (phone.startsWith('error')) { await pageSettled(page); continue; }
    // E.164 on the re-entry field too: strip only separators. The country
    // selector's option is the one whose dial code the number starts with.
    const digits = s.resolveEnv('$INSTAGRAM_NEW_PHONE').replace(/[^\d+]/g, '');
    await page.evaluate((number) => {
      for (const sel of document.querySelectorAll('select')) {
        const match = Array.from(sel.options)
          .filter((o) => o.value && number.startsWith(`+${o.value.replace(/\D/g, '')}`))
          .sort((a, b) => b.value.length - a.value.length)[0];
        if (match) { sel.value = match.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
      }
    }, digits);
    await pageSettled(page);
    const tel = page.locator('input[type="tel"]').first();
    if (await tel.count()) await humanFill(page, tel, '');
    await pageSettled(page);
    await humanType(page, digits);
    await pageSettled(page);
    await pressAny(s, ['send', 'continue', 'next']);
    await pageSettled(page);
    const smsCode = await s.pollSmsCode();
    console.log(`[ig] SMS code: ${smsCode}`);
    if (smsCode && smsCode !== NO_CODE && !page.isClosed()) {
      const code = await codeField(page);
      if (!code) throw new Error('instagram asked for a phone, took it, and shows no code field');
      await code.fill(smsCode);
      await pageSettled(page);
      await pressAny(s, ['confirm', 'continue', 'next']);
      await pageSettled(page);
      return;
    }
    await s.jsClick('[aria-label="Back"], [aria-label="Go back"]');
    await pageSettled(page);
  }
}

async function signup(s, attempt = 1) {
  const id = await s.generateIdentity('instagram');
  id.email = `${id.username}@wisentmedia.com`;
  s._env['INSTAGRAM_NEW_EMAIL'] = id.email;
  const name = `${id.firstName} ${id.lastName}`;
  const page = s.page;

  // Rotate the SMS country by attempt; on an order error try the others.
  const country = COUNTRY_ORDER[(attempt - 1) % COUNTRY_ORDER.length];
  let phone = await s.checkSms('instagram', country);
  for (const fb of COUNTRY_ORDER) { if (phone.startsWith('error') && fb !== country) phone = await s.checkSms('instagram', fb); }
  console.log(`[ig] identity: ${id.username} / phone=${phone}`);
  if (phone.startsWith('error')) throw new Error('no_phone_number');
  const phoneNum = s.resolveEnv('$INSTAGRAM_NEW_PHONE');
  // The field validates E.164: keep the +<cc>, strip only separators.
  const digits = phoneNum.replace(/[^\d+]/g, '');

  await s.goto(URL);
  await pageSettled(page);

  // Cookie consent, when the page offers it.
  if ((await s.jsClick('button', 'Allow essential')) !== 'no-element-found') await pageSettled(page);

  await s.fill('email', digits);
  await pageSettled(page);
  await s.fill('password', id.password);
  await pageSettled(page);
  // Date of birth: ARIA comboboxes labelled "Select day/month/year" with a
  // virtualized listbox; s.select walks it by aria-selected.
  await s.select('Select day', id.birthDay);
  await humanIdlePause('short');
  await s.select('Select month', id.birthMonth);
  await humanIdlePause('short');
  await s.select('Select year', id.birthYear);
  await pageSettled(page);
  await s.fill('Full name', name);
  await pageSettled(page);
  await s.fill('username', id.username);
  await pageSettled(page);

  await page.screenshot({ path: `${runRecordingsDir('instagram_register')}/ig_before_submit.png` });
  // The submit is a role="button" container, not a <button>.
  await s.click('Submit');
  await pageSettled(page);
  await page.screenshot({ path: `${runRecordingsDir('instagram_register')}/ig_after_submit.png` });

  // Leave the signup form: the next state is whatever the page asks for.
  let current = 'form';
  for (let w = 0; w < 30 && current === 'form'; w++) {
    if (page.isClosed()) throw new Error('page_closed');
    await pageSettled(page);
    current = await state(page);
    if (w % 5 === 0) console.log(`[ig] after submit ${w}: path=${pathOf(page)} state=${current}`);
  }
  if (current === 'form') throw new Error('signup_form_stuck');

  let smsCode = '';
  if (current === 'code') {
    console.log('[ig] SMS verification — polling for code...');
    smsCode = await s.pollSmsCode();
    console.log(`[ig] SMS code: ${smsCode}`);
  }

  for (let i = 0; i < 30; i++) {
    if (page.isClosed()) throw new Error('page_closed');
    current = await state(page);
    console.log(`[ig] onboarding ${i}: path=${pathOf(page)} state=${current}`);
    if (current === 'in') break;
    if (current === 'password_reset') throw new Error('password_reset_redirect');
    if (current === 'code') {
      if (!smsCode || smsCode === NO_CODE) throw new Error('sms_code_not_received');
      await (await codeField(page)).fill(smsCode);
      await humanIdlePause('short');
      await pressAny(s, ['Continue', 'Next', 'Confirm']);
      await humanIdlePause('deliberate');
      continue;
    }
    if (current === 'selfie') throw new Error('selfie_required');
    if (current === 'phone') { await phoneVerification(s, page); continue; }
    if (current === 'challenge') {
      // A challenge with neither a phone nor a selfie field: continue once;
      // one that then asks for text beside an image is an image code this
      // run does not solve.
      await pressAny(s, ['continue', 'next']);
      await pageSettled(page);
      const text = page.locator('main input[type="text"], form input[type="text"]').first();
      if ((await state(page)) === 'challenge' && (await text.isVisible())) {
        throw new Error('instagram_image_captcha: Instagram asked for an image code after signup; the run stops here');
      }
      continue;
    }
    if (await pressAny(s, ['skip', 'not now', 'next'])) await pageSettled(page);
  }

  if (page.isClosed()) throw new Error('page_closed');
  if (pathOf(page).startsWith(PATH.suspended)) throw new Error('account_suspended');
  // Success is the session's auth cookies, not what the page says.
  const cookies = await s.ctx.cookies();
  const authCookies = cookies.filter(c => c.domain?.includes('instagram.com') && (c.name === 'sessionid' || c.name === 'csrftoken'));
  if (authCookies.length < 2) {
    console.log(`[ig] no auth cookies (cookies=${authCookies.map(c => c.name)})`);
    throw new Error('no_auth_cookies');
  }
  console.log(`[ig] auth cookies verified: ${authCookies.map(c => c.name).join(', ')}`);

  const result = await s.saveAccount('instagram', {
    username: id.username, email: id.email, password: id.password, name, phone: phoneNum,
  });
  console.log(`[ig] ${result}`);
  const bound = await autoBindCharacter(id.username, 'instagram');
  console.log(`[bind] ${JSON.stringify(bound)}`);
  return id.username;
}

const s = await WSession.start({ label: 'instagram_register', proxy: pickInstagramProxy() });
try {
  const username = await signup(s, 1);
  console.log(`PASS: ${username}`);
  await s.close();
  process.exit(0);
} catch (e) {
  console.log(`FAIL: ${e.message}`);
  await s.close();
  process.exitCode = 1;
}
