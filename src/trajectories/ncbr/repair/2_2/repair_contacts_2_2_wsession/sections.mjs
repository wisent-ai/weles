// The section 1.3 and 2.2 repairs and diagnostics of repair_contacts_2_2_wsession.mjs, bound to the page and the form helpers.
import { humanClickLocator, humanIdlePause } from '../../../../../../dist/human/mouse.js';
import { humanFill } from '../../../../../../dist/human/keyboard.js';
import { CONTACT, FACTORS, FEATURES } from './source.mjs';

export function contactRepairs({ page, email, progress, URLS, setReactInputValue, clickVisibleButton, saveVisibleForm, fillAny, fillByName, deleteRowsContaining, fillEdoreczeniaIfPresent }) {
async function repair13() {
  progress('section:1.3');
  await page.goto(URLS['1.3'], { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: section 1.3 navigation
  await humanIdlePause('long');
  await openFirstRowEdit('Wisent Polska');
  const edoreczenia = await fillEdoreczeniaIfPresent();
  const edited = [];
  const hasZuzanna = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').includes('Zuzanna Bartoszcze')); // allow-raw-playwright: inspect current contact rows
  if (!hasZuzanna) {
    const hasWeronika = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').includes('Weronika Pernak')); // allow-raw-playwright: inspect current contact rows
    if (!hasWeronika) throw new Error('neither Zuzanna nor Weronika contact row is visible in 1.3 edit form');
    const row = page.locator('table tbody tr').filter({ hasText: 'Weronika Pernak' }).first();
    await humanClickLocator(page, row.locator('button[aria-label="overflow-options"]')) // allow-raw-playwright: open visible stale contact row menu
    await humanIdlePause('deliberate');
    await page.getByRole('menuitem', { name: 'Edytuj', exact: true }).first().dispatchEvent('click'); // allow-raw-playwright: edit visible stale contact row
    await humanIdlePause('long');
    await fillAny(['imie', 'imie_osoby_do_kontaktu', 'osoby_do_kontaktu_kolekcja[1].imie'], CONTACT.imie);
    await fillAny(['nazwisko', 'nazwisko_osoby_do_kontaktu', 'osoby_do_kontaktu_kolekcja[1].nazwisko'], CONTACT.nazwisko);
    await fillAny(['telefon', 'telefon_osoby_do_kontaktu', 'nr_telefonu', 'osoby_do_kontaktu_kolekcja[1].telefon'], CONTACT.telefon);
    await fillAny(['adres_email', 'email', 'adres_email_osoby_do_kontaktu', 'osoby_do_kontaktu_kolekcja[1].adres_email'], CONTACT.email);
    await saveVisibleForm();
    edited.push('Weronika Pernak -> Zuzanna Bartoszcze');
  }
  await saveVisibleForm();
  return { edoreczenia, edited, readback: await readTables(URLS['1.3']) };
}

async function diag13() {
  const reports = [];
  await page.goto(URLS['1.3'], { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: section 1.3 diagnostic navigation
  await humanIdlePause('long');
  const count = await page.evaluate(() => Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Dodaj' && b.getClientRects().length).length); // allow-raw-playwright: count visible add buttons
  for (let i = 0; i < count; i += 1) {
    await page.goto(URLS['1.3'], { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: reset section between diagnostic opens
    await humanIdlePause('long');
    await clickVisibleButton('Dodaj', i);
    const fields = await page.evaluate(() => Array.from(document.querySelectorAll('input, textarea')).map((el) => {
      const id = el.id || '';
      const label = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent?.trim() : null;
      const rect = el.getBoundingClientRect();
      return {
        tag: el.tagName,
        type: el.getAttribute('type'),
        name: el.getAttribute('name'),
        id,
        label,
        value: (el.value || '').slice(0, 80),
        max: el.getAttribute('maxlength'),
        visible: rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none',
      };
    }).filter((field) => field.visible && (field.name || field.label || field.value))); // allow-raw-playwright: read diagnostic field metadata only
    const buttons = await page.evaluate(() => Array.from(document.querySelectorAll('button')).map((b) => ({ text: b.innerText.trim(), disabled: b.disabled })).filter((b) => b.text)); // allow-raw-playwright: read diagnostic buttons only
    reports.push({ addIndex: i, fields, buttons });
  }
  return { addButtonCount: count, reports };
}

async function openFirstRowEdit(rowNeedle) {
  const row = page.locator('table tbody tr').filter({ hasText: rowNeedle }).first();
  if (await row.count() === 0) throw new Error(`row not found for edit: ${rowNeedle}`);
  await humanClickLocator(page, row.locator('button[aria-label="overflow-options"]')) // allow-raw-playwright: open visible row menu for diagnostic/edit
  await humanIdlePause('deliberate');
  await page.getByRole('menuitem', { name: 'Edytuj', exact: true }).first().dispatchEvent('click'); // allow-raw-playwright: choose visible edit menu item
  await humanIdlePause('long');
}

async function diag13Edit() {
  await page.goto(URLS['1.3'], { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: section 1.3 diagnostic navigation
  await humanIdlePause('long');
  await openFirstRowEdit('Wisent Polska');
  const before = await page.evaluate(() => ({
    fields: Array.from(document.querySelectorAll('input, textarea')).map((el) => {
      const id = el.id || '';
      const label = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent?.trim() : null;
      const rect = el.getBoundingClientRect();
      return { tag: el.tagName, type: el.getAttribute('type'), name: el.getAttribute('name'), id, label, value: (el.value || '').slice(0, 80), max: el.getAttribute('maxlength'), visible: rect.width > 0 && rect.height > 0 };
    }).filter((field) => field.visible && (field.name || field.label || field.value)),
    tables: Array.from(document.querySelectorAll('table')).map((table) => ({ rows: table.querySelectorAll('tbody tr').length, text: table.innerText.replace(/\s+/g, ' ').trim().slice(0, 1200) })),
    buttons: Array.from(document.querySelectorAll('button')).map((b) => ({ text: b.innerText.trim(), disabled: b.disabled })).filter((b) => b.text),
  })); // allow-raw-playwright: read diagnostic state inside 1.3 entity edit form
  const nestedAddCount = before.buttons.filter((b) => b.text === 'Dodaj kolejny' && !b.disabled).length;
  const nestedReports = [];
  for (let i = 0; i < nestedAddCount; i += 1) {
    await page.goto(URLS['1.3'], { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: reset 1.3 edit diagnostic
    await humanIdlePause('long');
    await openFirstRowEdit('Wisent Polska');
    const buttons = page.locator('button:visible:not([disabled])').filter({ hasText: /^Dodaj kolejny$/ });
    if (await buttons.count() <= i) throw new Error(`Dodaj kolejny #${i} not found`);
    await humanClickLocator(page, buttons.nth(i)) // allow-raw-playwright: open visible nested collection diagnostic row
    await humanIdlePause('long');
    const fields = await page.evaluate(() => Array.from(document.querySelectorAll('input, textarea')).map((el) => {
      const id = el.id || '';
      const label = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent?.trim() : null;
      const rect = el.getBoundingClientRect();
      return { tag: el.tagName, type: el.getAttribute('type'), name: el.getAttribute('name'), id, label, value: (el.value || '').slice(0, 80), max: el.getAttribute('maxlength'), visible: rect.width > 0 && rect.height > 0 };
    }).filter((field) => field.visible && (field.name || field.label || field.value))); // allow-raw-playwright: read nested diagnostic fields
    nestedReports.push({ nestedAddIndex: i, fields });
  }
  return { before, nestedReports };
}

async function diag13ContactEdit() {
  await page.goto(URLS['1.3'], { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: section 1.3 contact diagnostic navigation
  await humanIdlePause('long');
  await openFirstRowEdit('Wisent Polska');
  const row = page.locator('table tbody tr').filter({ hasText: 'Weronika Pernak' }).first();
  await humanClickLocator(page, row.locator('button[aria-label="overflow-options"]')) // allow-raw-playwright: open visible nested contact row menu
  await humanIdlePause('deliberate');
  await page.getByRole('menuitem', { name: 'Edytuj', exact: true }).first().dispatchEvent('click'); // allow-raw-playwright: edit visible nested contact row
  await humanIdlePause('long');
  return await page.evaluate(() => ({
    fields: Array.from(document.querySelectorAll('input, textarea')).map((el) => {
      const id = el.id || '';
      const label = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent?.trim() : null;
      const rect = el.getBoundingClientRect();
      return { tag: el.tagName, type: el.getAttribute('type'), name: el.getAttribute('name'), id, label, value: (el.value || '').slice(0, 80), max: el.getAttribute('maxlength'), visible: rect.width > 0 && rect.height > 0 };
    }).filter((field) => field.visible && (field.name || field.label || field.value)),
    buttons: Array.from(document.querySelectorAll('button')).map((b) => ({ text: b.innerText.trim(), disabled: b.disabled })).filter((b) => b.text),
  })); // allow-raw-playwright: read contact edit fields only
}

async function setAutoByName(name, search) {
  const inp = page.locator(`input[name="${name}"]:visible`).first();
  await inp.waitFor({ state: 'visible' });
  await humanClickLocator(page, inp); // allow-raw-playwright: open visible autocomplete
  await humanFill(page, inp, search); // allow-raw-playwright: filter visible autocomplete
  await humanIdlePause('deliberate');
  const opt = page.locator('[role="option"]').filter({ hasText: search.slice(0, 30) }).first();
  if (await opt.count() > 0) {
    const picked = (await opt.textContent())?.trim();
    await opt.dispatchEvent('click'); // allow-raw-playwright: pick visible option
    await humanIdlePause('short');
    return picked;
  }
  const first = page.locator('[role="option"]').first();
  if (await first.count() === 0) throw new Error(`no option for ${name}: ${search}`);
  const picked = (await first.textContent())?.trim();
  await first.dispatchEvent('click'); // allow-raw-playwright: pick first filtered option
  await humanIdlePause('short');
  return picked;
}

async function repair22() {
  progress('section:2.2');
  const done = [];
  await page.goto(URLS['2.2'], { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: section 2.2 navigation
  await humanIdlePause('long');
  for (const feature of FEATURES) {
    const current = await page.locator('body').innerText();
    if (current.includes(feature.cecha.slice(0, 120))) {
      done.push({ collection: 'cecha', skippedExisting: feature.cecha.slice(0, 80) });
      continue;
    }
    progress(`2.2:add-feature:${feature.cecha.slice(0, 50)}`);
    await clickVisibleButton('Dodaj', 0);
    await fillByName('cecha_funkcjonalnosc_rezultatu_projektu', feature.cecha);
    await fillByName('wartosc_bazowa', feature.bazowa);
    await fillByName('wartosc_docelowa', feature.docelowa);
    await fillByName('produkt_proces_referencyjny', feature.referencyjny);
    await fillByName('korzysc_przewaga', feature.korzysc);
    await fillByName('sposob_weryfikacji_osiagniecia_wartosci_docelowej', feature.weryfikacja);
    await saveVisibleForm();
    done.push({ collection: 'cecha', added: feature.cecha.slice(0, 80) });
    await page.goto(URLS['2.2'], { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: reload after row save
    await humanIdlePause('long');
  }
  for (const factor of FACTORS) {
    const current = await page.locator('body').innerText();
    if (current.includes(factor.parametr)) {
      done.push({ collection: 'czynnik', skippedExisting: factor.parametr });
      continue;
    }
    progress(`2.2:add-factor:${factor.parametr}`);
    await clickVisibleButton('Dodaj', 1);
    const picked = await setAutoByName('wybrany_czynnik', factor.czynnik);
    await fillByName('nazwa_parametru', factor.parametr);
    await fillByName('wartosc_bazowa', factor.bazowa);
    await fillByName('rok_bazowy', factor.rokBazowy);
    await fillByName('wartosc_docelowa', factor.docelowa);
    await fillByName('rok_docelowy', factor.rokDocelowy);
    await fillByName('metoda_szacowania_wartosci_docelowej', factor.metoda);
    await fillByName('sposob_monitorowania_weryfikacji_osiagniecia_zaplanowanych_wartosci_docelowych', factor.weryfikacja);
    await saveVisibleForm();
    done.push({ collection: 'czynnik', added: factor.parametr, picked });
    await page.goto(URLS['2.2'], { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: reload after row save
    await humanIdlePause('long');
  }
  return { parsed: { features: FEATURES.length, factors: FACTORS.length }, done, readback: await readTables(URLS['2.2']) };
}

async function readTables(url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: read-only section navigation
  await humanIdlePause('long');
  return page.evaluate(() => Array.from(document.querySelectorAll('table')).map((table) => ({
    rows: table.querySelectorAll('tbody tr').length,
    text: table.innerText.replace(/\s+/g, ' ').trim(),
  }))); // allow-raw-playwright: read visible table text only
}

  return { repair13, diag13, openFirstRowEdit, diag13Edit, diag13ContactEdit, setAutoByName, repair22, readTables };
}
