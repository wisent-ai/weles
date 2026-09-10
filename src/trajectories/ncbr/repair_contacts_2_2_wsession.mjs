// UI-only repair for section 1.3 contacts/e-Doreczenia and section 2.2 collections.
// Never submits, never uploads documents, never uses LSI direct APIs.

import { readFileSync, writeFileSync } from 'node:fs';
import { WSession } from '../../../dist/index.js';
import { humanClickLocator, humanIdlePause } from '../../../dist/human/mouse.js';
import { humanFill } from '../../../dist/human/keyboard.js';

const PROJECT_ID = process.env.NCBR_PROJECT_ID || '7ee80d9a-67dd-4d99-becd-8dda407221c1';
const PROJECT_URL = `https://lsi2.ncbr.gov.pl/projekt/${PROJECT_ID}`;
const BASE = `${PROJECT_URL}/projekt_step/`;
const URLS = {
  '1.3': `${BASE}317a21dd-e798-4115-ab53-6ab5a2912fb0`,
  '2.2': `${BASE}80ebca16-a9dd-4798-a334-5ac007cecbf7`,
};
const OUT = process.env.OUT || '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/backends/STEP_sciezka_A_Wisent/contacts_2_2_repair_evidence_20260624.json';
const MD22 = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/backends/STEP_sciezka_A_Wisent/wersja_B_2.2_innowacyjnosc_i_zaleznosci.md';
const email = process.env.NCBR_EMAIL;
const password = process.env.NCBR_PASSWORD;
if (!email || !password) {
  console.log(JSON.stringify({ error: 'MISSING_NCBR_CREDENTIALS' }, null, 2));
  process.exit(2);
}
delete process.env.NCBR_PASSWORD;

const md = readFileSync(MD22, 'utf8');
const EDORECZENIA = 'AE:PL-50419-15057-VDGUG-25';
const CONTACT = {
  imie: 'Zuzanna',
  nazwisko: 'Bartoszcze',
  stanowisko: 'Osoba do kontaktu organizacyjnego i finansowo-operacyjnego',
  telefon: '+48534110040',
  email: 'zuzanna.bartoszcze@gmail.com',
};

function clean(s) { return String(s || '').replace(/\s*<!--[\s\S]*?-->\s*/g, ' ').replace(/\s+/g, ' ').trim(); }
function featureBlock(n) {
  const start = `### Cecha/funkcjonalność ${n}:`;
  const a = md.indexOf(start);
  if (a < 0) throw new Error(`feature ${n} missing`);
  const b = md.indexOf(`### Cecha/funkcjonalność ${n + 1}:`, a + start.length);
  const fallback = md.indexOf('## Rezultat prac B+R spełnia', a);
  return md.slice(a, b >= 0 ? b : fallback);
}
function tableVal(block, label) {
  for (const line of block.split(/\r?\n/)) {
    if (!line.trim().startsWith('|') || /^\|\s*-/.test(line)) continue;
    const cells = line.split('|').map((c) => clean(c));
    if ((cells[1] || '').includes(label)) return cells[2] || '';
  }
  return '';
}
const FEATURES = [1, 2, 3, 4, 5].map((n) => {
  const block = featureBlock(n);
  return {
    cecha: tableVal(block, 'Cecha/funkcjonalność rezultatu projektu'),
    bazowa: tableVal(block, 'Wartość bazowa'),
    docelowa: tableVal(block, 'Wartość docelowa'),
    referencyjny: tableVal(block, 'Produkt/proces referencyjny'),
    korzysc: tableVal(block, 'Korzyść/przewaga'),
    weryfikacja: tableVal(block, 'Sposób weryfikacji'),
  };
}).filter((row) => row.cecha && row.docelowa);
const factorTable = md.slice(md.indexOf('## Podsumowanie wpływu prac B+R na ograniczanie'));
const FACTORS = factorTable.split(/\r?\n/)
  .filter((line) => line.trim().startsWith('|') && !/---|Wybrany czynnik/.test(line))
  .map((line) => {
    const cells = line.split('|').map((c) => clean(c));
    return {
      czynnik: cells[1],
      parametr: cells[2],
      bazowa: cells[3],
      docelowa: cells[4],
      rokBazowy: cells[5],
      rokDocelowy: cells[6],
      metoda: cells[7],
      weryfikacja: cells[8],
    };
  }).filter((row) => row.czynnik && row.parametr);

const session = await WSession.start({ label: 'ncbr_repair_contacts_2_2_wsession', proxy: 'direct', browser: 'chromium' });
const page = session.page;
page.setDefaultTimeout(35000);

function progress(message) {
  console.log(`[repair_contacts_2_2] ${new Date().toISOString()} ${message}`);
}

async function setReactInputValue(locator, value) {
  await locator.waitFor({ state: 'visible' });
  await humanClickLocator(page, locator); // allow-raw-playwright: focus visible LSI input
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
  }, null, { timeout: 10000 }).catch(() => null); // allow-raw-playwright: wait for login validation
  for (let attempt = 1; attempt <= 3 && page.url().includes('/logowanie'); attempt += 1) {
    await session.clickSelector('#login-btn, button:has-text("Zaloguj")'); // allow-raw-playwright: click visible login button
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => null);
    await humanIdlePause('long');
  }
  if (page.url().includes('/logowanie')) throw new Error('login stayed on login page');
  progress('login:done');
}

async function clickVisibleButton(text, nth = 0) {
  const buttons = page.locator('button:visible').filter({ hasText: new RegExp(`^${text}$`) });
  if (await buttons.count() <= nth) throw new Error(`${text} #${nth} not found`);
  await humanClickLocator(page, buttons.nth(nth)) // allow-raw-playwright: click visible LSI button
  await humanIdlePause('long');
}

async function saveVisibleForm() {
  await humanIdlePause('deliberate');
  await humanIdlePause('deliberate');
  await page.waitForFunction(() => Array.from(document.querySelectorAll('button')).some((b) => b.innerText.trim() === 'Zapisz' && !b.disabled && b.getClientRects().length), null, { timeout: 25000 }).catch(() => null); // allow-raw-playwright: wait for enabled LSI save
  await humanClickLocator(page, page.locator('button:visible:not([disabled])').filter({ hasText: /^Zapisz$/ }).last()) // allow-raw-playwright: save visible row/form only
  await humanIdlePause('long');
}

async function fillAny(names, value) {
  for (const name of names) {
    const visible = page.locator(`input[name="${name}"]:visible, textarea[name="${name}"]:visible`);
    const loc = (await visible.count() > 0) ? visible.last() : page.locator(`input[name="${name}"], textarea[name="${name}"]`).last();
    if (await loc.count() === 0) continue;
    return { name, ...(await setReactInputValue(loc, value)) };
  }
  throw new Error(`none of fields found: ${names.join(', ')}`);
}

async function fillByName(name, value) {
  return fillAny([name], value);
}

async function deleteRowsContaining(needle) {
  const deleted = [];
  while (await page.evaluate((text) => {
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    return Array.from(document.querySelectorAll('table tbody tr')).some((r) => norm(r.innerText).includes(text));
  }, needle)) {
    progress(`1.3:delete:${needle}`);
    const row = page.locator('table tbody tr').filter({ hasText: needle }).first();
    await humanClickLocator(page, row.locator('button[aria-label="overflow-options"]')) // allow-raw-playwright: open stale visible row menu
    await humanIdlePause('deliberate');
    const del = page.locator('[role="menuitem"], .MuiMenuItem-root').filter({ hasText: /Usuń|Usun|Delete/ }).first();
    if (await del.count() === 0) throw new Error(`delete menu item not found for ${needle}`);
    await del.dispatchEvent('click'); // allow-raw-playwright: delete stale visible row
    await humanIdlePause('deliberate');
    const confirm = page.locator('button').filter({ hasText: /Usuń|Usun|Potwierdź|Tak|Delete/ }).last();
    if (await confirm.count() > 0) await confirm.dispatchEvent('click'); // allow-raw-playwright: confirm visible delete dialog
    await humanIdlePause('long');
    deleted.push(needle);
  }
  return deleted;
}

async function fillEdoreczeniaIfPresent() {
  const result = await page.evaluate((value) => {
    const fields = Array.from(document.querySelectorAll('input, textarea'));
    const hit = fields.find((el) => {
      const id = el.id || '';
      const label = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent || '' : '';
      const hay = `${el.name || ''} ${label} ${el.placeholder || ''}`.toLowerCase();
      return hay.includes('doręc') || hay.includes('dorec') || hay.includes('ae:');
    });
    if (!hit || hit.disabled || hit.readOnly) return { found: Boolean(hit), filled: false };
    const proto = hit instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(hit, value);
    else hit.value = value;
    hit.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    hit.dispatchEvent(new Event('change', { bubbles: true }));
    hit.dispatchEvent(new Event('blur', { bubbles: true }));
    return { found: true, filled: true, name: hit.name || null, id: hit.id || null };
  }, EDORECZENIA); // allow-raw-playwright: fill visible e-Doreczenia field if present
  return result;
}

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

await login();
const out = { parsed: { features: FEATURES.length, factors: FACTORS.length }, actions: {} };
if (process.env.DIAG_13 === '1') {
  out.diag13 = await diag13();
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ out: OUT, diag13: out.diag13 }, null, 2));
  await session.ctx.close();
  process.exit(0);
}
if (process.env.DIAG_13_EDIT === '1') {
  out.diag13Edit = await diag13Edit();
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ out: OUT, diag13Edit: out.diag13Edit }, null, 2));
  await session.ctx.close();
  process.exit(0);
}
if (process.env.DIAG_13_CONTACT_EDIT === '1') {
  out.diag13ContactEdit = await diag13ContactEdit();
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ out: OUT, diag13ContactEdit: out.diag13ContactEdit }, null, 2));
  await session.ctx.close();
  process.exit(0);
}
out.actions['1.3'] = await repair13();
out.actions['2.2'] = await repair22();
writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(JSON.stringify({ out: OUT, parsed: out.parsed, readback: { '1.3': out.actions['1.3'].readback, '2.2': out.actions['2.2'].readback } }, null, 2));
await session.ctx.close();
process.exit(0);
