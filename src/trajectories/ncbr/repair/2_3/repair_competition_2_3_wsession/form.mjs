// The LSI form helpers of repair_competition_2_3_wsession.mjs, bound to the page they act on.
import { humanClickLocator, humanIdlePause } from '../../../../../../dist/human/mouse.js';
import { humanFill } from '../../../../../../dist/human/keyboard.js';

export function lsiForm({ page, session, email, password, progress }) {
async function setReactInputValue(locator, value) {
  await locator.waitFor({ state: 'visible' });
  await humanClickLocator(page, locator); // allow-raw-playwright: focus visible LSI field
  const max = Number(await locator.getAttribute('maxlength')) || String(value || '').length;
  let next = String(value || '');
  if (next.length > max) next = next.slice(0, max).replace(/\s+\S*$/, '');
  const locked = await locator.evaluate((el) => Boolean(el.readOnly || el.disabled)); // allow-raw-playwright: inspect visible field mutability
  if (!locked) {
    await humanFill(page, locator, ''); // allow-raw-playwright: clear editable LSI field
    await humanFill(page, locator, next); // allow-raw-playwright: fill editable LSI field
  }
  await locator.evaluate((el, v) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, v);
    else el.value = v;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: v }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }, next); // allow-raw-playwright: set React-controlled LSI field value
  await humanIdlePause('short');
  return { len: next.length, max };
}

async function login() {
  progress('login:start');
  await page.goto('https://lsi2.ncbr.gov.pl/logowanie', { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: LSI login page
  await humanIdlePause('long');
  await setReactInputValue(page.locator('#mail, input[name="mail"]').first(), email);
  await setReactInputValue(page.locator('#password, input[name="password"]').first(), password);
  const checkbox = page.locator('#isStatuteAccepted, input[name="isStatuteAccepted"]').first();
  if (!(await checkbox.isChecked().catch(() => false))) await humanClickLocator(page, checkbox) // allow-raw-playwright: accept visible statute checkbox for login only
  await humanIdlePause('short');
  await page.waitForFunction(() => {
    const btn = document.querySelector('#login-btn') || Array.from(document.querySelectorAll('button')).find((b) => b.innerText.trim() === 'Zaloguj');
    return !!btn && !btn.disabled;
  }, null, { timeout: 10000 }).catch(() => null); // allow-raw-playwright: wait for LSI login validation
  for (let attempt = 1; attempt <= 3 && page.url().includes('/logowanie'); attempt += 1) {
    await session.clickSelector('#login-btn, button:has-text("Zaloguj")'); // allow-raw-playwright: click visible login button
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => null);
    await humanIdlePause('long');
  }
  if (page.url().includes('/logowanie')) throw new Error('login stayed on login page');
  progress('login:done');
}

async function readSectionTables(url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: navigate to exact LSI section
  await humanIdlePause('long');
  return page.evaluate(() => Array.from(document.querySelectorAll('table')).map((table) => ({
    rows: table.querySelectorAll('tbody tr').length,
    text: table.innerText.replace(/\s+/g, ' ').trim(),
  }))); // allow-raw-playwright: read visible table text only
}

async function visibleTableText() {
  return page.evaluate(() => Array.from(document.querySelectorAll('table')).map((table) => table.innerText.replace(/\s+/g, ' ').trim()).join('\n')); // allow-raw-playwright: read visible table text only
}

function hasAnyName(text, row) {
  const names = [row.name, row.producer, ...(row.aliases || [])].filter(Boolean);
  return names.some((name) => text.includes(name));
}

async function clickDodaj(nth) {
  const buttons = page.locator('button:visible').filter({ hasText: /^Dodaj$/ });
  if (await buttons.count() <= nth) throw new Error(`Dodaj #${nth} not found`);
  await humanClickLocator(page, buttons.nth(nth)) // allow-raw-playwright: open visible collection row form
  await humanIdlePause('long');
}

async function saveVisibleForm() {
  progress('save:waiting');
  await humanIdlePause('deliberate');
  await humanIdlePause('deliberate');
  await page.waitForFunction(() => Array.from(document.querySelectorAll('button')).some((b) => b.innerText.trim() === 'Zapisz' && !b.disabled && b.getClientRects().length), null, { timeout: 25000 }).catch(() => null); // allow-raw-playwright: wait for enabled visible LSI save
  await humanClickLocator(page, page.locator('button:visible:not([disabled])').filter({ hasText: /^Zapisz$/ }).last()) // allow-raw-playwright: save visible LSI row form
  await humanIdlePause('long');
  progress('save:done');
}

async function selectApplicantIfPresent() {
  const input = page.locator('input[name*="nazwa_skrocona_wnioskodawcy"]').first();
  if (await input.count() === 0) return 'absent';
  if (/Wisent Polska/.test(await input.inputValue().catch(() => ''))) return 'already';
  const opener = input.locator('xpath=ancestor::*[contains(@class,"MuiInputBase-root") or contains(@class,"MuiFormControl-root")][1]').locator('.MuiSelect-select, [role="combobox"]').first();
  if (await opener.count() === 0) return 'no-opener';
  await humanClickLocator(page, opener);
  const state = 'opened'; // allow-raw-playwright: open visible applicant select if present
  if (state !== 'opened') return state;
  await humanIdlePause('deliberate');
  const opt = page.getByRole('option', { name: 'Wisent Polska', exact: true }).first();
  if (await opt.count() > 0) await opt.dispatchEvent('click'); // allow-raw-playwright: select visible applicant option
  await humanIdlePause('short');
  return state;
}

async function fillNamedField(name, value) {
  const visible = page.locator(`input[name="${name}"]:visible, textarea[name="${name}"]:visible`);
  const loc = (await visible.count() > 0) ? visible.last() : page.locator(`input[name="${name}"], textarea[name="${name}"]`).last();
  return { name, ...(await setReactInputValue(loc, value)) };
}

async function fillBySuffix(suffix, value) {
  const visible = page.locator(`input[name$="${suffix}"]:visible, textarea[name$="${suffix}"]:visible`);
  const loc = (await visible.count() > 0) ? visible.last() : page.locator(`input[name$="${suffix}"], textarea[name$="${suffix}"]`).last();
  return { suffix, ...(await setReactInputValue(loc, value)) };
}

  return { setReactInputValue, login, readSectionTables, visibleTableText, hasAnyName, clickDodaj, saveVisibleForm, selectApplicantIfPresent, fillNamedField, fillBySuffix };
}
