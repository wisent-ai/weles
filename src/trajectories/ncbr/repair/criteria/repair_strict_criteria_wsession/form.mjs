// The LSI form helpers of repair_strict_criteria_wsession.mjs, bound to the page they act on.
import { humanClickLocator, humanIdlePause } from '../../../../../../dist/human/mouse.js';
import { fillField } from '../../../form-input.mjs';

export function lsiForm({ page, email, password }) {

async function login() {
  await page.goto('https://lsi2.ncbr.gov.pl/logowanie', { waitUntil: 'domcontentloaded' }); // allow-raw-playwright: LSI login page
  await fillField(page, page.locator('#mail, input[name="mail"]').first(), email);
  await fillField(page, page.locator('#password, input[name="password"]').first(), password);
  const statute = page.locator('#isStatuteAccepted, input[name="isStatuteAccepted"]').first();
  if (!await statute.isChecked()) await humanClickLocator(page, statute.locator('xpath=ancestor-or-self::label[1]').or(statute));
  await page.waitForFunction(() => {
    const btn = document.querySelector('#login-btn') || Array.from(document.querySelectorAll('button')).find((b) => b.innerText.trim() === 'Zaloguj');
    return !!btn && !btn.disabled;
  }, null, { polling: 'raf' }); // allow-raw-playwright: wait for login form validation
  for (let attempt = 1; attempt <= 3 && page.url().includes('/logowanie'); attempt += 1) {
    if (attempt === 1) {
      await humanClickLocator(page, page.locator('#login-btn, button:has-text("Zaloguj")').first()); // allow-raw-playwright: click visible login button
    } else {
      await humanClickLocator(page, page.locator('#login-btn, button:has-text("Zaloguj")').first());
    }
    await page.waitForLoadState('load');
    await humanIdlePause('long');
  }
  if (page.url().includes('/logowanie')) throw new Error('login stayed on login page');
}

async function fillBySuffix(suffix, value) {
  const visible = page.locator(`[name$="${suffix}"]:visible`);
  const loc = (await visible.count() > 0) ? visible.last() : page.locator(`[name$="${suffix}"]`).last();
  const res = await fillField(page, loc, value);
  return { suffix, ...res };
}

async function fillByExactName(name, value) {
  const visible = page.locator(`[name="${name}"]:visible`);
  const loc = (await visible.count() > 0) ? visible.last() : page.locator(`[name="${name}"]`).last();
  const res = await fillField(page, loc, value);
  return { name, ...res };
}

async function saveVisibleForm() {
  const save = page.getByRole('button', { name: 'Zapisz', exact: true })
    .and(page.locator('button:not(:disabled):not([aria-disabled="true"])')).filter({ visible: true }).last();
  await save.waitFor({ state: 'visible' });
  await humanClickLocator(page, save);
  await humanIdlePause('long');
}

async function closeVisibleForm(editorField) {
  if (!await editorField.isVisible()) return;
  const cancel = page.getByRole('button', { name: 'Anuluj', exact: true })
    .and(page.locator('button:not(:disabled):not([aria-disabled="true"])')).filter({ visible: true }).last();
  await cancel.waitFor({ state: 'visible' });
  await humanClickLocator(page, cancel);
  await editorField.waitFor({ state: 'hidden' });
}

  return { login, fillBySuffix, fillByExactName, saveVisibleForm, closeVisibleForm };
}
