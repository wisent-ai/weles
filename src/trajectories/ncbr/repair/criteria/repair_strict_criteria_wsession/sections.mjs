// The section repairs of repair_strict_criteria_wsession.mjs, bound to the page, the form helpers and the section URLs.
import { humanClickLocator } from '../../../../../../dist/human/mouse.js';
import { indicatorRepairs, scalarRepairs, taskRepairs } from './repairs.mjs';
import { fillField } from '../../../form-input.mjs';

export function criteriaRepairs({ page, fillBySuffix, fillByExactName, saveVisibleForm, closeVisibleForm, URLS }) {
const indicatorField = page.locator('[name="rok_osiagniecia_wartosci_docelowej"], [name="opis_metodologii"], [name="opis_sposobu_weryfikacji"]')
  .filter({ visible: true }).first();
const taskField = page.locator('[name="nazwa_zadania"]').filter({ visible: true }).first();
async function repairScalarSections() {
  const out = [];
  for (const item of scalarRepairs) {
    console.log(`[scalar] ${item.section} ${item.suffix}`);
    await page.goto(URLS[item.section], { waitUntil: 'domcontentloaded' }); // allow-raw-playwright: section navigation
    const filled = await fillBySuffix(item.suffix, item.value);
    if (filled.changed) await saveVisibleForm();
    out.push({ section: item.section, ...filled, save: filled.changed ? 'save_clicked' : 'unchanged' });
  }
  return out;
}

async function openTaskRow(nr) {
  await page.goto(URLS['6.1'], { waitUntil: 'domcontentloaded' }); // allow-raw-playwright: section 6.1 navigation
  const taskRow = page.locator('table tbody tr').filter({ has: page.locator('td').filter({ hasText: new RegExp(`^${nr}\\. `) }) }).first();
  const menu = taskRow.locator('button[aria-label="overflow-options"]:not(:disabled):not([aria-disabled="true"])');
  await menu.waitFor({ state: 'visible' });
  await humanClickLocator(page, menu);
  await page.getByRole('menuitem', { name: 'Edytuj', exact: true }).filter({ visible: true }).first().dispatchEvent('click'); // allow-raw-playwright: edit task row
  await taskField.waitFor({ state: 'visible' });
  return taskField;
}

async function repairTasks61() {
  const out = [];
  for (const task of taskRepairs) {
    console.log(`[6.1] task ${task.nr}`);
    const editorField = await openTaskRow(task.nr);
    const filled = [];
    filled.push(await fillField(page, editorField, task.name));
    filled.push(await fillField(page, page.locator('[name="zakres_planowanych_prac_br"]').first(), task.scope));
    filled.push(await fillField(page, page.locator('[name="szczegolowy_opis_prac"]').first(), task.detail));
    const changed = filled.some((field) => field.changed);
    if (changed) await saveVisibleForm();
    else await closeVisibleForm(editorField);
    out.push({ nr: task.nr, filled, save: changed ? 'save_clicked' : 'unchanged' });
  }
  return out;
}

async function openIndicatorRowExact(name) {
  await page.goto(URLS['9.2'], { waitUntil: 'domcontentloaded' }); // allow-raw-playwright: section 9.2 navigation
  const indicatorRow = page.locator('table tbody tr').filter({ has: page.locator('td').filter({ hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) }).first();
  const menu = indicatorRow.locator('button[aria-label="overflow-options"]:not(:disabled):not([aria-disabled="true"])');
  await menu.waitFor({ state: 'visible' });
  await humanClickLocator(page, menu);
  await page.getByRole('menuitem', { name: 'Edytuj', exact: true }).filter({ visible: true }).first().dispatchEvent('click'); // allow-raw-playwright: edit exact indicator row
  await indicatorField.waitFor({ state: 'visible' });
  return indicatorField;
}

async function openIndicatorRowByIndex(index) {
  await page.goto(URLS['9.2'], { waitUntil: 'domcontentloaded' }); // allow-raw-playwright: section 9.2 navigation
  const indicatorRow = page.locator('table tbody tr').filter({ has: page.locator('button[aria-label="overflow-options"]') }).nth(index);
  const menu = indicatorRow.locator('button[aria-label="overflow-options"]:not(:disabled):not([aria-disabled="true"])');
  await menu.waitFor({ state: 'visible' });
  await humanClickLocator(page, menu);
  await page.getByRole('menuitem', { name: 'Edytuj', exact: true }).filter({ visible: true }).first().dispatchEvent('click'); // allow-raw-playwright: edit indicator row by index
  await indicatorField.waitFor({ state: 'visible' });
  return indicatorField;
}

async function repairIndicators92() {
  const out = [];
  const items = process.env.TAIL_92 === '1'
    ? indicatorRepairs.filter((item) => [
      'Redukcja ilości tokenów treningowych dla RNM 70B wobec modelu odniesienia (transformer) do osiągnięcia parytetu jakości na MMLU',
      'Udział cykli treningowych RNM z pomiarem energii, CO2eq i kryteriami zielonych zamówień',
      'Liczba przedsięwzięć proekologicznych',
    ].includes(item.name))
    : process.env.METH_92 === '1'
      ? indicatorRepairs.filter((item) => item.name === 'Liczba wprowadzonych innowacji procesowych')
    : process.env.REV_92 === '1'
      ? indicatorRepairs.filter((item) => item.name === 'Przychody ze sprzedaży nowych lub udoskonalonych produktów/usług')
    : process.env.ERROR_92 === '1'
      ? indicatorRepairs.filter((item) => [
        'Liczba wprowadzonych innowacji procesowych',
        'Przedsiębiorstwa wprowadzające innowacje procesowe',
        'Małe i średnie przedsiębiorstwa (MŚP) wprowadzające innowacje procesowe',
      ].includes(item.name))
    : indicatorRepairs;
  for (const item of items) {
    console.log(`[9.2] ${item.name}`);
    const editorField = await openIndicatorRowExact(item.name);
    const filled = [];
    if (item.year && process.env.METH_92 !== '1') filled.push({ field: 'year', ...(await fillByExactName('rok_osiagniecia_wartosci_docelowej', item.year)) });
    if (item.methodology) filled.push({ field: 'methodology', ...(await fillByExactName('opis_metodologii', item.methodology)) });
    if (item.verification && process.env.METH_92 !== '1') filled.push({ field: 'verification', ...(await fillByExactName('opis_sposobu_weryfikacji', item.verification)) });
    const changed = filled.some((field) => field.changed);
    if (changed) await saveVisibleForm();
    else await closeVisibleForm(editorField);
    out.push({ name: item.name, save: changed ? 'save_clicked' : 'unchanged', filled });
  }
  return out;
}

  return { repairScalarSections, openTaskRow, repairTasks61, openIndicatorRowExact, openIndicatorRowByIndex, repairIndicators92 };
}
