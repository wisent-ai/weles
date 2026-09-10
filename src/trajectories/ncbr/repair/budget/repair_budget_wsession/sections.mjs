// The section repairs of repair_budget_wsession.mjs: 6.3, 6.5, 8 and 2.2, bound to the page and the form helpers.
import { humanClickLocator, humanIdlePause } from '../../../../../../dist/human/mouse.js';
import { DIRECT_ROWS, FIELD_REPAIRS_63, FINANCING_8, INDIRECT_ROWS, OBSOLETE_ROWS } from './rows.mjs';

export function budgetSections({ page, openRowMenu, clickMenu, fill, typeFill, setReactInputValue, saveVisibleForm, tableReadback, clickVisibleButton, selectVisibleOption, URL_63, URL_65, URL_8, URL_22 }) {
async function deleteRows63() {
  const deleted = [];
  for (const target of OBSOLETE_ROWS) {
    console.log(`[6.3 delete] ${target}`);
    await page.goto(URL_63, { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: budget section navigation
    await humanIdlePause('long');
    const row = page.locator('table').first().locator('tbody tr').filter({ hasText: target }).first();
    if (await row.count() === 0) { deleted.push({ target, status: 'not_found' }); continue; }
    await openRowMenu(target);
    await clickMenu(/Usuń|Usun|Delete/i);
    const confirm = page.locator('button').filter({ hasText: /Usuń|Usun|Potwierdź|Tak|Delete/i }).last();
    if (await confirm.count() > 0) await confirm.dispatchEvent('click'); // allow-raw-playwright: confirm visible delete dialog
    await humanIdlePause('long');
    deleted.push({ target, status: 'deleted' });
  }
  return deleted;
}

async function rewriteRows63() {
  const rewritten = [];
  for (const row of DIRECT_ROWS) {
    console.log(`[6.3 rewrite] ${row.match} -> ${row.name}`);
    await page.goto(URL_63, { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: budget section navigation
    await humanIdlePause('long');
    await openRowMenu(row.match);
    await clickMenu(/Edytuj/i);
    await fill('nazwa_kosztu', row.name);
    await fill('wydatki_ogolem', row.total);
    await fill('wydatki_kwalifikowalne', row.total);
    await fill('w_tym_vat', '0.00');
    await fill('dofinansowanie', row.grant);
    await typeFill('uzasadnienie_kosztu', row.uz);
    await typeFill('metoda_szacowania', row.met);
    await typeFill('nazwa_kosztu', row.name);
    await saveVisibleForm();
    rewritten.push(row.name);
  }
  return rewritten;
}

async function repairRequiredFields63() {
  const repaired = [];
  for (const row of FIELD_REPAIRS_63) {
    console.log(`[6.3 required fields] ${row.name}`);
    await page.goto(URL_63, { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: budget section navigation for required-field repair
    await humanIdlePause('long');
    await openRowMenu(row.match);
    await clickMenu(/Edytuj/i);
    await page.locator('[name="nazwa_kosztu"]').first().waitFor({ state: 'visible', timeout: 10000 });
    await typeFill('uzasadnienie_kosztu', row.uz);
    await typeFill('metoda_szacowania', row.met);
    await typeFill('nazwa_kosztu', row.name);
    const state = await page.evaluate(() => ({
      nameLens: Array.from(document.querySelectorAll('[name="nazwa_kosztu"]')).map((e) => e.value?.length || 0),
      uzLens: Array.from(document.querySelectorAll('[name="uzasadnienie_kosztu"]')).map((e) => e.value?.length || 0),
      metLens: Array.from(document.querySelectorAll('[name="metoda_szacowania"]')).map((e) => e.value?.length || 0),
      saveDisabled: Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Zapisz').map((b) => b.disabled),
    })); // allow-raw-playwright: verify required fields before save
    if (Math.max(...state.nameLens, 0) === 0 || Math.max(...state.uzLens, 0) === 0 || Math.max(...state.metLens, 0) === 0) {
      throw new Error(`required 6.3 fields still empty for ${row.name}: ${JSON.stringify(state)}`);
    }
    const saveStatus = await saveVisibleForm({ allowNoChange: true });
    repaired.push({ name: row.name, state, saveStatus });
  }
  return repaired;
}

async function rewriteRows65() {
  const rewritten = [];
  for (const row of INDIRECT_ROWS) {
    console.log(`[6.5 rewrite] ${row.match}`);
    await page.goto(URL_65, { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: indirect-cost section navigation
    await humanIdlePause('long');
    await openRowMenu(row.match);
    await clickMenu(/Edytuj/i);
    for (const amountName of ['wydatki_ogolem', 'wydatki_kwalifikowalne']) {
      const field = page.locator(`[name="${amountName}"]:visible`).last();
      if (await field.count() > 0) await fill(amountName, row.total);
    }
    await fill('dofinansowanie', row.grant);
    const info = page.locator('[name="informacje_o_metodzie_uproszczone"]').first();
    if (await info.count() > 0) await fill('informacje_o_metodzie_uproszczone', row.info);
    await typeFill('uzasadnienie_kosztu', row.uz);
    await saveVisibleForm();
    rewritten.push(row.match);
  }
  return rewritten;
}
async function repair63SecondMethod() {
  const row = DIRECT_ROWS[1];
  console.log(`[6.3 method-only] ${row.name}`);
  await page.goto(URL_63, { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: budget section navigation for targeted repair
  await humanIdlePause('long');
  await openRowMenu(row.match);
  await clickMenu(/Edytuj/i);
  await page.locator('[name="metoda_szacowania"]').first().waitFor({ state: 'visible', timeout: 10000 });
  await typeFill('metoda_szacowania', row.met);
  const state = await page.evaluate(() => ({
    metLens: Array.from(document.querySelectorAll('[name="metoda_szacowania"]')).map((e) => e.value?.length || 0),
    saveDisabled: Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Zapisz').map((b) => b.disabled),
  })); // allow-raw-playwright: verify 6.3 method field before save
  await saveVisibleForm();
  return state;
}

async function repair63GpuNameOnly() {
  const row = DIRECT_ROWS[2];
  console.log(`[6.3 name-only] ${row.name}`);
  await page.goto(URL_63, { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: budget section navigation for targeted name cleanup
  await humanIdlePause('long');
  await openRowMenu(row.match);
  await clickMenu(/Edytuj/i);
  await page.locator('[name="nazwa_kosztu"]').first().waitFor({ state: 'visible', timeout: 10000 });
  await typeFill('nazwa_kosztu', row.name);
  const state = await page.evaluate(() => ({
    nameValues: Array.from(document.querySelectorAll('[name="nazwa_kosztu"]')).map((e) => e.value || ''),
    saveDisabled: Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Zapisz').map((b) => b.disabled),
  })); // allow-raw-playwright: verify 6.3 GPU name before save
  await saveVisibleForm();
  return state;
}

async function setApplicantIfPresent() {
  const applicant = page.locator('input[name*="nazwa_skrocona"]').first();
  const select = applicant.locator('xpath=ancestor::*[contains(@class, "MuiInputBase-root")][1]').locator('.MuiSelect-select, [role="combobox"]').first();
  if (await select.count()) await humanClickLocator(page, select);
  await humanIdlePause('deliberate');
  const opt = page.getByRole('option', { name: 'Wisent Polska', exact: true }).first();
  if (await opt.count() > 0) await opt.dispatchEvent('click'); // allow-raw-playwright: choose visible applicant option
  await humanIdlePause('short');
}

function valueForSection8Field(field) {
  const hay = `${field.name || ''} ${field.label || ''}`.toLowerCase();
  if (hay.includes('suma_wydatki_ogolem') || hay.includes('suma wydatków ogółem')) return FINANCING_8.total;
  if (hay.includes('suma_wydatki_kwalifikowalne') || hay.includes('suma wydatków kwalifikowalnych')) return FINANCING_8.total;
  if (hay.includes('srodki_wlasne') || hay.includes('środki własne') || hay.includes('własne')) return FINANCING_8.own;
  if (hay.includes('pozycz') || hay.includes('pożycz')) return FINANCING_8.loan;
  if (hay.includes('prywatne')) return FINANCING_8.private;
  if (hay.includes('kredyt')) return '0.00';
  if (hay.includes('inne')) return '0.00';
  if (hay.includes('dofinansowanie') || hay.includes('wnioskowane') || hay.includes('publiczne') || hay.includes('ue')) return FINANCING_8.grant;
  return null;
}

async function section8Fields() {
  return await page.evaluate(() => Array.from(document.querySelectorAll('input, textarea')).map((el) => {
    const id = el.id || '';
    const label = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent?.trim() : null;
    const rect = el.getBoundingClientRect();
    return {
      tag: el.tagName,
      type: el.getAttribute('type'),
      name: el.getAttribute('name'),
      id,
      label,
      value: el.value || '',
      readOnly: el.readOnly,
      disabled: el.disabled,
      visible: rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none',
    };
  }).filter((x) => (x.name || x.label) && x.visible)); // allow-raw-playwright: read visible section 8 edit fields
}

async function repairSection8() {
  console.log('[8 repair] financing totals');
  await page.goto(URL_8, { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: section 8 navigation
  await humanIdlePause('long');
  const existingRow = page.locator('table').first().locator('tbody tr').filter({ hasText: /Wisent Polska|WISENT POLSKA/i }).first();
  if (await existingRow.count() > 0) {
    await existingRow.locator('button[aria-label="overflow-options"]').first().dispatchEvent('click'); // allow-raw-playwright: open visible section 8 row menu
    await humanIdlePause('deliberate');
    await clickMenu(/Edytuj/i);
  } else {
    await clickVisibleButton('Dodaj');
    await setApplicantIfPresent();
  }

  let before = await section8Fields();
  const changed = [];
  for (const field of before) {
    if (!field.name || field.readOnly || field.disabled) continue;
    const value = valueForSection8Field(field);
    if (value === null) continue;
    await setReactInputValue(page.locator(`[name="${field.name}"]:visible`).last(), value);
    changed.push({ name: field.name, label: field.label, value });
  }
  if (changed.length === 0) {
    throw new Error(`no editable section 8 amount fields found: ${JSON.stringify(before)}`);
  }
  await saveVisibleForm();
  await page.goto(URL_8, { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: section 8 readback navigation
  await humanIdlePause('long');
  const readback8 = await tableReadback(URL_8);
  before = before.map((f) => ({ name: f.name, label: f.label, value: f.value, readOnly: f.readOnly, disabled: f.disabled }));
  return { before, changed, readback8 };
}
async function repair22MainFactor() {
  console.log('[2.2 repair] main dependency factors');
  await page.goto(URL_22, { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: 2.2 section navigation
  await humanIdlePause('long');
  const input = page.locator('input[name$="rezultat_prac_br_spelnia_nastepujace_czynniki"]').first();
  await input.waitFor({ state: 'visible', timeout: 10000 });
  await humanClickLocator(page, input); // allow-raw-playwright: open visible 2.2 multi-select
  await humanIdlePause('deliberate');
  let selected = null;
  try {
    selected = await selectVisibleOption(/bezpieczeństwa dostaw|bezpieczenstwa dostaw/i);
  } catch (e) {
    selected = `not_selected_or_already_selected: ${String(e?.message || e).slice(0, 160)}`;
  }
  await saveVisibleForm({ allowNoChange: true });
  const readback = await tableReadback(URL_22);
  return { selected, readback };
}
  return { deleteRows63, rewriteRows63, repairRequiredFields63, rewriteRows65, repair63SecondMethod, repair63GpuNameOnly, repairSection8, repair22MainFactor };
}
