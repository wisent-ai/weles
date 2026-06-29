// Section 6.5 indirect costs collection filler for NEW NCBR wniosek.
// UI-only, no direct API writes. Never closes page.

import { chromium } from 'playwright';
import { humanIdlePause } from '../../../dist/human/mouse.js';

const endpoint = process.env.NCBR_CDP_ENDPOINT || 'http://127.0.0.1:9223';
const SECTION_URL = 'https://lsi2.ncbr.gov.pl/projekt/7ee80d9a-67dd-4d99-becd-8dda407221c1/projekt_step/bdb2c7b3-92d9-4778-9ecc-b4c5bda7d32b';

const ROWS = [
  {
    task: '0.',
    help: 'Badania przemysłowe',
    method: 'stawka ryczałtowa',
    category: 'Koszty pośrednie',
    total: '2575000.00',
    grant: '2060000.00',
    info: '25%',
    uz: 'Koszty pośrednie dla badań przemysłowych są wyliczone stawką ryczałtową 25% od bezpośrednich kosztów kwalifikowalnych BP, tj. od 10 300 000,00 zł. Obejmują administrację, księgowość, HR, obsługę prawną, IT support, utrzymanie siedziby, zarządzanie projektem oraz kierownictwo i koordynację prac B+R. Nie są wykazywane jako oddzielne koszty bezpośrednie w 6.3.',
  },
  {
    task: '0.',
    help: 'Prace rozwojowe',
    method: 'stawka ryczałtowa',
    category: 'Koszty pośrednie',
    total: '550000.00',
    grant: '330000.00',
    info: '25%',
    uz: 'Koszty pośrednie obejmują administrację, księgowość, HR, obsługę prawną, IT support, utrzymanie siedziby i zarządzanie projektem w części przypisanej do prac rozwojowych. Metoda uproszczona - stawka ryczałtowa 25% kosztów kwalifikowalnych - ogranicza ciężar rozliczeń.',
  },
];

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) { console.log(JSON.stringify({ error: 'NO_PAGE' })); process.exit(0); }
page.setDefaultTimeout(10000);

await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
await humanIdlePause('long');
await page.evaluate(() => { const b = Array.from(document.querySelectorAll('div')).find((d) => (d.innerText || '').includes('pliki cookies')); if (b) b.style.pointerEvents = 'none'; }); // allow-raw-playwright: cookie banner

async function clickDodaj() {
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) => b.innerText.trim() === 'Dodaj' && b.getClientRects().length);
    if (!btn) throw new Error('Dodaj not found');
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }); // allow-raw-playwright: open indirect-cost row
  await humanIdlePause('long');
}

async function openSelect(name) {
  await page.evaluate((name) => {
    const inp = document.querySelector(`input[name="${name}"]`);
    const root = inp && inp.closest('.MuiInputBase-root');
    const select = root && root.querySelector('.MuiSelect-select, [role="combobox"]');
    if (!select) throw new Error(`select not found: ${name}`);
    for (const t of ['mousedown', 'mouseup', 'click']) select.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
  }, name); // allow-raw-playwright: open MUI select
  await humanIdlePause('deliberate');
}

async function pickSelect(name, contains) {
  await openSelect(name);
  const opt = page.locator("[role='option']").filter({ hasText: contains }).first();
  if (await opt.count() === 0) throw new Error(`no select option ${name} -> ${contains}`);
  const picked = (await opt.textContent())?.trim()?.slice(0, 100);
  await opt.dispatchEvent('click'); // allow-raw-playwright: select option
  await humanIdlePause('short');
  return picked;
}

async function setAuto(name, search) {
  const inp = page.locator(`input[name="${name}"]`).first();
  const readonly = await inp.getAttribute('readonly');
  if (readonly === null) {
    await inp.click(); // allow-raw-playwright: open editable autocomplete
    await inp.fill(search); // allow-raw-playwright: filter editable autocomplete
  } else {
    await page.evaluate((name) => {
      const input = document.querySelector(`input[name="${name}"]`);
      const root = input && (input.closest('.MuiAutocomplete-root') || input.closest('.MuiFormControl-root'));
      const target = root && (root.querySelector('.MuiAutocomplete-popupIndicator') || root.querySelector('button') || input);
      if (!target) throw new Error(`autocomplete opener not found: ${name}`);
      for (const t of ['mousedown', 'mouseup', 'click']) target.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
    }, name); // allow-raw-playwright: open readonly autocomplete through MUI popup indicator
  }
  await humanIdlePause('deliberate');
  let opt = page.locator("[role='listbox'] [role='option']").filter({ hasText: search }).first();
  if (await opt.count() === 0) opt = page.locator("[role='listbox'] [role='option']").first();
  if (await opt.count() === 0) throw new Error(`no autocomplete option ${name} -> ${search}`);
  const picked = (await opt.textContent())?.trim()?.slice(0, 100);
  await opt.dispatchEvent('click'); // allow-raw-playwright: select filtered option
  await humanIdlePause('short');
  return picked;
}

async function fill(name, value) {
  const loc = page.locator(`[name="${name}"]`).first();
  await loc.waitFor({ state: 'visible' });
  if (await loc.evaluate((el) => el.readOnly || el.disabled)) {
    console.log(`SKIP READONLY ${name}`);
    return;
  }
  const max = Number(await loc.getAttribute('maxlength')) || String(value).length;
  let v = String(value);
  if (v.length > max) throw new Error(`${name} too long: ${v.length}/${max}`);
  await loc.fill(v); // allow-raw-playwright: text/number field
  await humanIdlePause('short');
}

async function saveForm() {
  await humanIdlePause('deliberate'); await humanIdlePause('deliberate');
  await page.evaluate(() => {
    const saves = Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Zapisz' && !b.disabled);
    if (!saves.length) throw new Error('no enabled Zapisz');
    saves[saves.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }); // allow-raw-playwright: save indirect-cost row
  await humanIdlePause('long');
}

if (process.env.DIAG) {
  await clickDodaj();
  if (process.env.AFTER_HELP) {
    try { await fill('nazwa_zadania', '0. Koszty pośrednie: Koszty pośrednie'); } catch (e) { /* may be read-only */ }
    try { await pickSelect('nazwa_skrocona_wnioskodawcy_samodzielnego_lidera_konsorcjum_konsorcjanta', 'Wisent Polska'); } catch (e) { /* may be auto */ }
    await setAuto('rodzaj_pomocy', process.env.HELP || 'Badania przemysłowe');
    await humanIdlePause('long');
  }
  const fields = await page.evaluate(() => Array.from(document.querySelectorAll('input, textarea')).map((i) => {
    const label = i.id ? document.querySelector(`label[for="${CSS.escape(i.id)}"]`)?.textContent?.trim() : null;
    const wrap = i.closest('label, .MuiFormControlLabel-root, .MuiFormGroup-root, .MuiBox-root');
    return { tag: i.tagName, type: i.type || null, name: i.name || null, value: i.value || null, readOnly: i.readOnly, disabled: i.disabled, role: i.getAttribute('role'), max: i.getAttribute('maxlength'), label, nearby: wrap ? wrap.textContent.trim().slice(0, 180) : null };
  }).filter((x) => x.name || x.label));
  const buttons = await page.evaluate(() => Array.from(document.querySelectorAll('button')).map((b) => b.innerText.trim()).filter(Boolean));
  const saveDisabled = await page.evaluate(() => Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Zapisz').map((b) => b.disabled));
  const optionDumps = {};
  for (const name of ['nazwa_zadania', 'nazwa_skrocona_wnioskodawcy_samodzielnego_lidera_konsorcjum_konsorcjanta']) {
    try {
      await openSelect(name);
      optionDumps[name] = await page.evaluate(() => Array.from(document.querySelectorAll('[role="option"]')).map((o) => o.textContent.trim()).slice(0, 20));
      await page.keyboard.press('Escape'); // allow-raw-playwright: close options dump
    } catch (e) { optionDumps[name] = String(e?.message || e); }
  }
  console.log(JSON.stringify({ fields, buttons, saveDisabled, optionDumps }, null, 2));
  process.exit(0);
}

if (process.env.MENU) {
  const contains = process.env.CONTAINS || 'badania przemysłowe';
  const row = page.locator('table').first().locator('tbody tr').filter({ hasText: contains }).first();
  await row.locator('button[aria-label="overflow-options"]').first().dispatchEvent('click'); // allow-raw-playwright: open row overflow menu for action discovery
  await humanIdlePause('deliberate');
  const menu = await page.evaluate(() => ({
    menuitems: Array.from(document.querySelectorAll('[role="menuitem"]')).map((e) => e.textContent.trim()).filter(Boolean),
    menus: Array.from(document.querySelectorAll('[role="menu"], .MuiPopover-root, .MuiMenu-paper')).map((e) => e.textContent.trim()).filter(Boolean),
    buttonsTail: Array.from(document.querySelectorAll('button')).map((e) => e.textContent.trim() || e.getAttribute('aria-label') || e.title).filter(Boolean).slice(-20),
  }));
  console.log(JSON.stringify({ contains, menu }, null, 2));
  process.exit(0);
}

if (process.env.EDIT) {
  const contains = process.env.CONTAINS;
  const grant = process.env.GRANT;
  if (!contains || !grant) throw new Error('EDIT requires CONTAINS and GRANT');
  const row = page.locator('table').first().locator('tbody tr').filter({ hasText: contains }).first();
  await row.locator('button[aria-label="overflow-options"]').first().dispatchEvent('click'); // allow-raw-playwright: open row overflow menu
  await humanIdlePause('deliberate');
  await page.getByRole('menuitem', { name: 'Edytuj', exact: true }).first().dispatchEvent('click'); // allow-raw-playwright: open edit form
  await humanIdlePause('long');
  await fill('dofinansowanie', grant);
  await saveForm();
  console.log(JSON.stringify({ edited: contains, grant }, null, 2));
  process.exit(0);
}

const wanted = process.env.ROWS ? new Set(process.env.ROWS.split(',').map((x) => Number(x.trim())).filter(Boolean)) : null;
const selectedRows = ROWS.map((r, i) => ({ ...r, rowNo: i + 1 })).filter((r) => !wanted || wanted.has(r.rowNo));
const added = [];

for (const r of selectedRows) {
  console.log(`START INDIRECT ${r.help}`);
  await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');
  await clickDodaj();
  await page.waitForSelector('[name="wydatki_ogolem"]');
  try { await fill('nazwa_zadania', '0. Koszty pośrednie: Koszty pośrednie'); } catch (e) { /* 6.5 may auto-bind task 0 */ }
  try { await pickSelect('nazwa_skrocona_wnioskodawcy_samodzielnego_lidera_konsorcjum_konsorcjanta', 'Wisent Polska'); } catch (e) { /* sometimes auto */ }
  await setAuto('rodzaj_pomocy', r.help);
  try { await setAuto('rodzaj_metody_uproszczonej', r.method); } catch (e) { console.log(`SKIP METHOD ${String(e?.message || e).slice(0, 90)}`); }
  try { await setAuto('kategoria_kosztu_feng', r.category); } catch (e) { console.log(`SKIP CATEGORY ${String(e?.message || e).slice(0, 90)}`); }
  await fill('wydatki_ogolem', r.total);
  await fill('wydatki_kwalifikowalne', r.total);
  await fill('dofinansowanie', r.grant);
  await fill('informacje_o_metodzie_uproszczone', r.info);
  await fill('uzasadnienie_kosztu', r.uz);
  await saveForm();
  added.push(r.help);
  console.log(`SAVED INDIRECT ${r.help}`);
}

console.log(JSON.stringify({ added }, null, 2));
process.exit(0);
