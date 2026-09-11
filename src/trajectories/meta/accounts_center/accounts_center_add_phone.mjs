// Add a phone contact in Accounts Center for Meta developer verification.
// Requires META_VERIFY_PHONE. If META_VERIFY_CODE is provided, submits the SMS code too.
// Phone and code values are not printed.

import { WSession } from '../../../../dist/session/wsession.js';
import { CODE_ONLY, USER_DATA_DIR, VERIFY_CODE } from './accounts_center_add_phone/settings.mjs';
import { bringBrowserToFront, snapshot, stableProfilePersona } from './accounts_center_add_phone/page.mjs';
import { clickFirst, fillCode, fillPhone, selectPhoneAssociationAccount, waitAndClickFirst } from './accounts_center_add_phone/steps.mjs';

const s = await WSession.start({
  label: 'meta_accounts_center_add_phone',
  browser: process.env.BROWSER || 'chromium',
  proxy: process.env.PROXY_URL || 'direct',
  persona: stableProfilePersona(),
  userDataDir: USER_DATA_DIR,
  headless: process.env.META_VERIFY_HEADLESS === '1',
  pageDiagnostics: process.env.WELES_PAGE_DIAGNOSTICS === '1',
});

let exitCode = 0;
try {
  await bringBrowserToFront(s);
  await s.page.goto('https://accountscenter.facebook.com/youraccount/contact_points/', { waitUntil: 'domcontentloaded' }).catch(() => {});
  const initial = await snapshot(s.page, 'contact_points_initial');
  if (CODE_ONLY) {
    if (!VERIFY_CODE) throw new Error('META_VERIFY_CODE is required when META_VERIFY_CODE_ONLY=1');
    if (!initial.statusHints.code) {
      await clickFirst(s.page, 'open_pending_contact', /Oczekuje na potwierdzenie|Pending confirmation|pending/i);
    }
    let codeScreen = await snapshot(s.page, 'code_only_screen');
    if (!codeScreen.statusHints.code) {
      await clickFirst(s.page, 'confirm_pending_contact', /Potwierdź numer|Confirm number|Verify number/i);
      codeScreen = await snapshot(s.page, 'code_only_confirm_screen');
    }
    if (!codeScreen.statusHints.code && codeScreen.statusHints.phoneChoice) {
      await fillPhone(s.page);
      await selectPhoneAssociationAccount(s.page);
      await snapshot(s.page, 'code_only_phone_form_ready');
      const phoneSubmitted = await clickFirst(s.page, 'submit_code_only_phone_form', /^(Dalej|Next|Wyślij|Send|Kontynuuj|Continue)$/i);
      if (!phoneSubmitted) throw new Error('No enabled submit button found while reopening pending phone confirmation');
      codeScreen = await snapshot(s.page, 'code_only_after_phone_submit');
    }
    if (!codeScreen.statusHints.code) throw new Error('No confirmation code screen found for META_VERIFY_CODE_ONLY=1');
    if (!await fillCode(s.page)) throw new Error('No confirmation code input found');
    await snapshot(s.page, 'code_only_filled');
    const submitted = await clickFirst(s.page, 'submit_code_only', /^(Dalej|Next|Wyślij|Send|Kontynuuj|Continue)$/i);
    if (!submitted) throw new Error('No enabled code submit button found in META_VERIFY_CODE_ONLY=1');
    await snapshot(s.page, 'after_code_only_submit');
    await waitAndClickFirst(s.page, 'skip_passkey', /^(Nie teraz|Not now)$/i, /Utwórz|Create/i, 12);
    await snapshot(s.page, 'after_code_only_passkey_skip');
    await bringBrowserToFront(s);
  } else {
    const add = await clickFirst(s.page, 'add_new_contact', /Dodaj nowy kontakt|Add new contact/i);
    if (!add) throw new Error('No Add new contact control found');
    await snapshot(s.page, 'after_add_new_contact');
    await clickFirst(s.page, 'choose_phone', /Dodaj numer telefonu|Add.*phone|Mobile number|Numer telefonu/i);
    await snapshot(s.page, 'phone_form');
    if (!await fillPhone(s.page)) throw new Error('No phone input found');
    await snapshot(s.page, 'phone_filled');
    await selectPhoneAssociationAccount(s.page);
    await snapshot(s.page, 'after_select_account');
    const submitted = await clickFirst(s.page, 'submit_phone', /^(Dalej|Next|Wyślij|Send|Kontynuuj|Continue)$/i);
    if (!submitted) throw new Error('No enabled submit button found after filling phone');
    const afterSubmit = await snapshot(s.page, 'after_submit');
    if (afterSubmit.statusHints.code) {
      if (!VERIFY_CODE) {
        console.log('NEED_CODE: META_VERIFY_CODE is required to submit the confirmation code');
      } else if (await fillCode(s.page)) {
        await snapshot(s.page, 'code_filled');
        const codeSubmitted = await clickFirst(s.page, 'submit_code', /^(Dalej|Next|Wyślij|Send|Kontynuuj|Continue)$/i);
        if (!codeSubmitted) throw new Error('No enabled code submit button found after entering confirmation code');
        await snapshot(s.page, 'after_code_submit');
        await waitAndClickFirst(s.page, 'skip_passkey', /^(Nie teraz|Not now)$/i, /Utwórz|Create/i, 12);
        await snapshot(s.page, 'after_passkey_skip');
      } else {
        throw new Error('No confirmation code input found');
      }
    } else {
      await bringBrowserToFront(s);
    }
  }
} catch (error) {
  exitCode = 1;
  console.log(`FAIL: ${error.message || String(error)}`);
} finally {
  await s.close().catch(() => {});
}

if (exitCode) process.exit(exitCode);
