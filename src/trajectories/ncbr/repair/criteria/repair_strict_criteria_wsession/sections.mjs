// The section repairs of repair_strict_criteria_wsession.mjs, bound to the page, the form helpers and the section URLs.
import { humanClickLocator, humanIdlePause } from '../../../../../../dist/human/mouse.js';
import { indicatorRepairs, scalarRepairs, taskRepairs } from './repairs.mjs';

export function criteriaRepairs({ page, setReactInputValue, fillBySuffix, fillByExactName, saveVisibleForm, closeVisibleForm, URLS }) {
async function repairScalarSections() {
  const out = [];
  for (const item of scalarRepairs) {
    console.log(`[scalar] ${item.section} ${item.suffix}`);
    await page.goto(URLS[item.section], { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: section navigation
    await humanIdlePause('long');
    out.push({ section: item.section, ...(await fillBySuffix(item.suffix, item.value)) });
    await saveVisibleForm();
  }
  return out;
}

async function openTaskRow(nr) {
  await page.goto(URLS['6.1'], { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: section 6.1 navigation
  await humanIdlePause('long');
  const taskRow = page.locator('table tbody tr').filter({ has: page.locator('td').filter({ hasText: new RegExp(`^${nr}\. `) }) }).first();
  await humanClickLocator(page, taskRow.locator('button[aria-label="overflow-options"]'));
  await humanIdlePause('deliberate');
  await page.getByRole('menuitem', { name: 'Edytuj', exact: true }).first().dispatchEvent('click'); // allow-raw-playwright: edit task row
  await humanIdlePause('long');
  await page.waitForSelector('[name="nazwa_zadania"]');
}

async function repairTasks61() {
  const out = [];
  for (const task of taskRepairs) {
    console.log(`[6.1] task ${task.nr}`);
    await openTaskRow(task.nr);
    const filled = [];
    filled.push(await setReactInputValue(page.locator('[name="nazwa_zadania"]').first(), task.name));
    filled.push(await setReactInputValue(page.locator('[name="zakres_planowanych_prac_br"]').first(), task.scope));
    filled.push(await setReactInputValue(page.locator('[name="szczegolowy_opis_prac"]').first(), task.detail));
    await saveVisibleForm();
    out.push({ nr: task.nr, filled });
  }
  return out;
}

async function openIndicatorRowExact(name) {
  await page.goto(URLS['9.2'], { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: section 9.2 navigation
  await humanIdlePause('long');
  const indicatorRow = page.locator('table tbody tr').filter({ has: page.locator('td').filter({ hasText: new RegExp(`^${name}$`) }) }).first();
  await humanClickLocator(page, indicatorRow.locator('button[aria-label="overflow-options"]'));
  await humanIdlePause('deliberate');
  await page.getByRole('menuitem', { name: 'Edytuj', exact: true }).first().dispatchEvent('click'); // allow-raw-playwright: edit exact indicator row
  await humanIdlePause('long');
  await page.waitForSelector('input, textarea');
}

async function openIndicatorRowByIndex(index) {
  await page.goto(URLS['9.2'], { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: section 9.2 navigation
  await humanIdlePause('long');
  const indicatorRow = page.locator('table tbody tr').filter({ has: page.locator('button[aria-label="overflow-options"]') }).nth(index);
  await humanClickLocator(page, indicatorRow.locator('button[aria-label="overflow-options"]'));
  await humanIdlePause('deliberate');
  await page.getByRole('menuitem', { name: 'Edytuj', exact: true }).first().dispatchEvent('click'); // allow-raw-playwright: edit indicator row by index
  await humanIdlePause('long');
  await page.waitForSelector('input, textarea');
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
    await openIndicatorRowExact(item.name);
    const filled = [];
    if (item.year && process.env.METH_92 !== '1') filled.push({ field: 'year', ...(await fillByExactName('rok_osiagniecia_wartosci_docelowej', item.year)) });
    if (item.methodology) filled.push({ field: 'methodology', ...(await fillByExactName('opis_metodologii', item.methodology)) });
    if (item.verification && process.env.METH_92 !== '1') filled.push({ field: 'verification', ...(await fillByExactName('opis_sposobu_weryfikacji', item.verification)) });
    let save = 'saved';
    try {
      await saveVisibleForm();
    } catch (e) {
      if (!/no enabled visible Zapisz/i.test(String(e?.message || e))) throw e;
      save = 'unchanged_or_readonly';
      await closeVisibleForm();
    }
    out.push({ name: item.name, save, filled });
  }
  return out;
}

  return { repairScalarSections, openTaskRow, repairTasks61, openIndicatorRowExact, openIndicatorRowByIndex, repairIndicators92 };
}
