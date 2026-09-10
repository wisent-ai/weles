// Pangram registration/login bootstrap for authenticated audits.
// DIAG=1 only dumps visible controls; normal mode creates and persists an account.

import { WSession } from '../../../dist/session/wsession.js';
import { humanClickLocator, humanIdlePause } from '../../../dist/human/mouse.js';
import { humanFill, humanType } from '../../../dist/human/keyboard.js';
import { generatePersona } from '../../../dist/browser/persona.js';
import { generateEmail, registrationPassword } from './register/identity.mjs';
import { countryHintFromProxy, selectRegistrationProxy } from './register/proxy.mjs';
import { inboxConfigured, waitForPangramMail } from './register/inbox.mjs';
import { clickByText, dismissCookies, dumpControls, fillFirst, isAuthenticatedStatus, loginWithPassword, sessionStatus } from './register/page.mjs';

const SIGNUP_URL = process.env.PANGRAM_SIGNUP_URL || 'https://www.pangram.com/signup';
const EMAIL = generateEmail();
const FIRST_NAME = process.env.PANGRAM_FIRST_NAME || 'Wisent';
const LAST_NAME = process.env.PANGRAM_LAST_NAME || 'Audit';
const PASSWORD = registrationPassword();

const regProxy = process.env.PANGRAM_NO_PROXY === '1' ? null : await selectRegistrationProxy();
const persona = generatePersona({ country: countryHintFromProxy(regProxy?.proxyUrl), browser: 'chromium' });
console.log(`[pangram_register] email=${EMAIL} proxy=${regProxy?.proxyUrl ? 'yes' : 'direct'} domain=${EMAIL.split('@')[1]} persona_os=${persona?.userAgentOs || 'default'}`);
const s = await WSession.start({
  label: 'pangram_register',
  browser: 'chromium',
  targetHost: 'www.pangram.com',
  proxy: regProxy?.proxyUrl,
  persona,
});
const sinceMs = Date.now();

/** Fill the signup form: email, password (and its confirmation), names, and the terms box. */
async function fillSignupForm(page) {
  const emailOk = await fillFirst(page, [
    page.locator('input[type="email"]'),
    page.locator('input[name*="email" i]'),
    page.locator('input[placeholder*="email" i]'),
  ], EMAIL);
  if (!emailOk) throw new Error('email_field_not_found');

  const passwordOk = await fillFirst(page, [
    page.locator('input[type="password"]').nth(0),
    page.locator('input[name*="password" i]'),
    page.locator('input[placeholder*="password" i]'),
  ], PASSWORD);
  if (!passwordOk) throw new Error('password_field_not_found');

  const passwordFields = page.locator('input[type="password"]');
  if (await passwordFields.count() > 1) {
    const confirm = passwordFields.nth(1);
    if (await confirm.isVisible().catch(() => false)) {
      await humanClickLocator(page, confirm);
      await humanFill(page, confirm, '');
      await humanType(page, PASSWORD);
    }
  }
  await fillFirst(page, [
    page.locator('input[placeholder*="confirm" i]'),
    page.locator('input[name*="confirm" i]'),
  ], PASSWORD);

  await fillFirst(page, [
    page.locator('input[name*="first" i]'),
    page.locator('input[placeholder*="first" i]'),
  ], FIRST_NAME);
  await fillFirst(page, [
    page.locator('input[name*="last" i]'),
    page.locator('input[placeholder*="last" i]'),
  ], LAST_NAME);

  const boxes = page.locator('input[type="checkbox"]').filter({ visible: true });
  const visibleCount = await boxes.count();
  let termsResult = { clicked: false, visibleCount };
  for (let index = 0; index < visibleCount; index += 1) {
    const box = boxes.nth(index);
    const context = await box.evaluate((el) => [
      el.closest('label')?.innerText,
      el.parentElement?.innerText,
      el.closest('div')?.innerText,
      el.closest('form')?.innerText,
    ].filter(Boolean).join(' ').toLowerCase());
    if (/terms|conditions|privacy/.test(context) && !await box.isChecked()) {
      await humanClickLocator(page, box);
      termsResult = { clicked: true, context: context.slice(0, 120) };
      break;
    }
  }
  console.log(`[pangram_register] terms=${JSON.stringify(termsResult)}`);
  await humanIdlePause('short');
}

/** Prove the address through the verification mail, then sign in if the page asks. */
async function verifyThroughMail(page) {
  const mail = inboxConfigured() ? await waitForPangramMail(EMAIL, sinceMs) : null;
  console.log(`[pangram_register] mail=${mail ? JSON.stringify({ subject: mail.subject, hasCode: Boolean(mail.code), hasLink: Boolean(mail.pangramLink) }) : 'none'}`);
  if (mail?.code) {
    const codeInput = page.locator('input[autocomplete="one-time-code"], input[name*="code" i], input[maxlength="6"], input[maxlength="5"]').first();
    if (await codeInput.count() > 0 && await codeInput.isVisible().catch(() => false)) {
      await humanClickLocator(page, codeInput);
      await humanType(page, mail.code);
      await clickByText(page, /verify|continue|submit/i).catch(() => false);
      await humanIdlePause('long');
    }
  }
  if (mail?.pangramLink) {
    await s.goto(mail.pangramLink);
    await humanIdlePause('long');
  }
  let status = await sessionStatus(page);
  if (!isAuthenticatedStatus(status)) {
    const pageText = await page.evaluate(() => document.body?.innerText || '').catch((e) => `unreadable: ${e.message}`); // allow-raw-playwright: read page state after verify link
    if (/log in to your account|sign in|password/i.test(pageText)) {
      const loggedIn = await loginWithPassword(page, EMAIL, PASSWORD);
      console.log(`[pangram_register] post_verify_login=${loggedIn}`);
      await humanIdlePause('long');
      status = await sessionStatus(page);
    }
  }
  return status;
}

try {
  await s.goto(SIGNUP_URL);
  await humanIdlePause('long');
  await dismissCookies(s.page);

  if (process.env.DIAG === '1') {
    console.log(JSON.stringify(await dumpControls(s.page), null, 2));
    process.exit(0);
  }

  console.log(`[pangram_register] email=${EMAIL}`);
  await clickByText(s.page, /email|password|sign up with email|continue with email/i).catch(() => false);
  await fillSignupForm(s.page);

  const submitted = await clickByText(s.page, /sign up|create account|continue|get started|submit/i);
  if (!submitted) throw new Error('submit_button_not_found');
  await humanIdlePause('long');

  let status = await sessionStatus(s.page);
  if (!isAuthenticatedStatus(status)) status = await verifyThroughMail(s.page);

  console.log(`[pangram_register] session_status=${status.status} body=${status.body.slice(0, 300)}`);
  if (!isAuthenticatedStatus(status)) {
    throw new Error('pangram_not_authenticated_after_signup');
  }

  const result = await s.saveAccount('pangram', { username: EMAIL, email: EMAIL, password: PASSWORD, status: 'created' });
  console.log(`[pangram_register] saveAccount=${result}`);
  console.log(`PASS: pangram account ready ${EMAIL}`);
} catch (e) {
  console.log(`FAIL: ${String(e?.message || e).slice(0, 300)}`);
  process.exitCode = 1;
} finally {
  await s.close();
}
