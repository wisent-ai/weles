// The 6.1 task row form, bound to the page: adding a row, the named and selector fields,
// the pre-save check, the radio and applicant choices, saving, and opening a task row.
import { humanClickLocator, humanIdlePause } from '../../../../../../dist/human/mouse.js';

export function tasksForm({ page, SECTION_URL }) {
async function clickDodaj() {
  await humanClickLocator(page, page.locator('button:visible').filter({ hasText: /^Dodaj$/ }).first()) // allow-raw-playwright: open collection row
  await humanIdlePause('long');
}


async function fillByName(name, value) {
  const loc = page.locator(`[name="${name}"]`).first();
  await loc.waitFor({ state: 'visible' });
  const max = Number(await loc.getAttribute('maxlength')) || String(value || '').length;
  let v = String(value || '');
  if (v.length > max) v = v.slice(0, max).replace(/\s+\S*$/, '');
  await loc.evaluate((el, next) => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
    if (setter) setter.call(el, next);
    else el.value = next;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: next }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }, v); // allow-raw-playwright: set controlled LSI task field reliably
  await humanIdlePause('short');
  return `${name} ${v.length}/${max}`;
}

async function fillSelector(selector, value) {
  const loc = page.locator(selector).first();
  await loc.waitFor({ state: 'visible' });
  const max = Number(await loc.getAttribute('maxlength')) || String(value || '').length;
  let v = String(value || '');
  if (v.length > max) v = v.slice(0, max).replace(/\s+\S*$/, '');
  await loc.evaluate((el, next) => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
    if (setter) setter.call(el, next);
    else el.value = next;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: next }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }, v); // allow-raw-playwright: set nested controlled LSI milestone textarea reliably
  await humanIdlePause('short');
}

async function assertTaskValuesBeforeSave(nr) {
  const state = await page.evaluate(() => {
    const value = (name) => document.querySelector(`[name="${name}"]`)?.value || '';
    const milestoneLens = Array.from(document.querySelectorAll('textarea[name^="kamienie_milowe_kolekcja["]')).map((el) => ({ name: el.name, len: (el.value || '').length }));
    return {
      zakres: value('zakres_planowanych_prac_br').length,
      szczegolowy: value('szczegolowy_opis_prac').length,
      milestoneLens,
    };
  }); // allow-raw-playwright: verify filled values before saving task row
  const badMilestone = state.milestoneLens.find((x) => x.len < 80);
  if (state.zakres < 500 || state.szczegolowy < 500 || badMilestone) {
    throw new Error(`task ${nr} not filled before save: zakres=${state.zakres}, szczegolowy=${state.szczegolowy}, bad=${badMilestone ? `${badMilestone.name}:${badMilestone.len}` : 'none'}`);
  }
  return state;
}

async function radio(value) {
  await page.locator(`input[type="radio"][value="${value}"]`).first().dispatchEvent('click'); // allow-raw-playwright: radio select
  await humanIdlePause('short');
}

async function setApplicant() {
  const visible = page.locator('#nazwa_skrocona_wnioskodawcy_samodzielnego_lidera_konsorcjum_konsorcjanta').first();
  if (await visible.count() > 0) {
    await humanClickLocator(page, visible); // allow-raw-playwright: open visible MUI Select
  } else {
    const select = page.locator(`input[name="nazwa_skrocona_wnioskodawcy_samodzielnego_lidera_konsorcjum_konsorcjanta"]`).first().locator('xpath=ancestor::*[contains(@class,"MuiInputBase-root")][1]').locator('.MuiSelect-select, [role="combobox"]').first();
    if (await select.count() > 0) await humanClickLocator(page, select) // allow-raw-playwright: open applicant select
  }
  await humanIdlePause('deliberate');
  const opt = page.getByRole('option', { name: 'Wisent Polska', exact: true }).first();
  if (await opt.count() > 0) await humanClickLocator(page, opt); // allow-raw-playwright: select applicant
  else throw new Error('Wisent Polska applicant option not found');
  await humanIdlePause('short');
}

async function saveForm() {
  await humanIdlePause('deliberate');
  await humanIdlePause('deliberate');
  await humanClickLocator(page, page.locator('button:not([disabled])').filter({ hasText: /^Zapisz$/ }).last()) // allow-raw-playwright: save task sub-form
  await humanIdlePause('long');
}

async function editTaskRow(nr) {
  await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');
  const row = page.locator('table tbody tr').filter({ hasText: new RegExp(`^${String(nr)}\. `) }).first();
  if (await row.count() === 0) throw new Error(`task row not found: ${nr}`);
  await humanClickLocator(page, row.locator('button[aria-label="overflow-options"]')) // allow-raw-playwright: open exact task row menu by first-cell prefix
  await humanIdlePause('deliberate');
  await page.getByRole('menuitem', { name: 'Edytuj', exact: true }).first().dispatchEvent('click'); // allow-raw-playwright: edit existing task row
  await humanIdlePause('long');
  await page.waitForSelector('[name="numer_zadania"]');
}
  return { clickDodaj, fillByName, fillSelector, assertTaskValuesBeforeSave, radio, setApplicant, saveForm, editTaskRow };
}
