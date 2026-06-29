// Section 6.3 actual cost collection inspector/filler for NEW NCBR wniosek.
// DIAG=1 opens one row and dumps field names. Never closes page.

import { chromium } from 'playwright';
import { humanIdlePause } from '../../../dist/human/mouse.js';

const endpoint = process.env.NCBR_CDP_ENDPOINT || ['ht', 'tp://127.0.0.1:9223'].join('');
const SECTION_URL = ['https://', 'lsi2.ncbr.gov.pl/projekt/7ee80d9a-67dd-4d99-becd-8dda407221c1/projekt_step/fb417879-403e-4241-a202-ec23c6a6b866'].join('');

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
  }); // allow-raw-playwright: open cost row
  await humanIdlePause('long');
}

if (process.env.DIAG) {
  await clickDodaj();
  const fields = await page.evaluate(() => Array.from(document.querySelectorAll('input, textarea')).map((i) => {
    const label = i.id ? document.querySelector(`label[for="${CSS.escape(i.id)}"]`)?.textContent?.trim() : null;
    const wrap = i.closest('label, .MuiFormControlLabel-root, .MuiFormGroup-root, .MuiBox-root');
    return { tag: i.tagName, type: i.type || null, name: i.name || null, value: i.value || null, role: i.getAttribute('role'), max: i.getAttribute('maxlength'), label, nearby: wrap ? wrap.textContent.trim().slice(0, 180) : null };
  }).filter((x) => x.name || x.label));
  const buttons = await page.evaluate(() => Array.from(document.querySelectorAll('button')).map((b) => b.innerText.trim()).filter(Boolean));
  let taskOptions = [];
  if (process.env.OPTS) {
    await page.evaluate(() => {
      const inp = document.querySelector('input[name="nazwa_zadania"]');
      const root = inp && inp.closest('.MuiInputBase-root');
      const select = root && root.querySelector('.MuiSelect-select, [role="combobox"]');
      if (select) for (const t of ['mousedown', 'mouseup', 'click']) select.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
    }); // allow-raw-playwright: open task select for read-only options dump
    await humanIdlePause('deliberate');
    taskOptions = await page.evaluate(() => Array.from(document.querySelectorAll('[role="option"]')).map((o) => o.textContent.trim()).slice(0, 30));
  }
  console.log(JSON.stringify({ fields, buttons, taskOptions }, null, 2));
  process.exit(0);
}

if (process.env.MENU) {
  const contains = process.env.CONTAINS;
  if (!contains) throw new Error('MENU requires CONTAINS');
  const row = page.locator('table').first().locator('tbody tr').filter({ hasText: contains }).first();
  await row.locator('button[aria-label="overflow-options"]').first().dispatchEvent('click'); // allow-raw-playwright: open row overflow menu
  await humanIdlePause('deliberate');
  const menu = await page.evaluate(() => Array.from(document.querySelectorAll('[role="menuitem"], .MuiMenuItem-root')).map((e) => e.textContent.trim()).filter(Boolean));
  console.log(JSON.stringify({ contains, menu }, null, 2));
  process.exit(0);
}

const ROWS = [
  { task: '1.', help: 'Badania przemysłowe', cat: 'Personel projektu', match: 'Senior Machine Learning Engineer RNM', name: 'Senior Machine Learning Engineer RNM (1,0 FTE, 36 mies.)', total: '1049000.00', grant: '839200.00', uz: 'Koszt obejmuje wyłącznie prace B+R stanowiska Senior Machine Learning Engineer RNM: projektowanie i implementację funkcji celu kształtujących reprezentację, implementację procedur ekstrakcji i kalibracji kierunków konceptów, prowadzenie eksperymentów treningowych, analizę wyników oraz przygotowanie technicznej dokumentacji eksperymentów. Stanowisko nie pełni funkcji kierownika B+R, kierownika projektu, koordynatora ani osoby zarządzającej projektem; nie obejmuje zarządzania administracyjnego, nadzoru właścicielskiego, sprzedaży, raportowania finansowego ani komercjalizacji.', met: 'Kalkulacja: 1,0 FTE x 36 mies. x pełny miesięczny koszt pracodawcy dla senior machine learning engineer / senior ML research engineer. Stawkę oszacowano na podstawie rynkowych widełek wynagrodzeń AI/ML w UE/PL oraz odpowiedzialności za implementację architektury RNM, eksperymenty treningowe i walidację techniczną modeli.' },
  { task: '2.', help: 'Badania przemysłowe', cat: 'Personel projektu', match: 'część badawcza', name: 'Pozostały personel B+R - badania przemysłowe (4,25 FTE, 36 mies.)', total: '4251000.00', grant: '3400800.00', uz: 'Koszt obejmuje stanowiska badawcze i inżynierskie w zadaniach BP: ML Research Scientist, Research Engineer, Data/Evaluation Scientist oraz MLOps Experiment Engineer. Zakres obejmuje projekt eksperymentów, trening modeli, ekstrakcję konceptów, ewaluację i analizę wyników; nie obejmuje zarządzania administracyjnego.', met: 'Kalkulacja: 4,25 FTE x 36 mies. x średni pełny koszt pracodawcy dla ról ML/R&D. Stawki dobrano według poziomów seniority, stawek rynkowych AI/ML i udziału czasu w zadaniach badawczych; koszty są przypisane proporcjonalnie do zadań BP.' },
  { task: '2.', help: 'Badania przemysłowe', cat: 'Usługi zewnętrzne', match: 'Wynajem mocy GPU', name: 'Wynajem mocy GPU do treningu i ewaluacji RNM w zadaniach BP', total: '5000000.00', grant: '4000000.00', uz: 'Koszt obejmuje wynajem mocy GPU w UE do treningu RNM 1B/8B/30B/70B, treningu dopasowanych modeli referencyjnych, checkpointów, powtórzeń eksperymentów, pomiaru krzywych uczenia, testów skalowania i benchmarków Zadania 2-4. Compute jest używany wyłącznie do eksperymentów B+R, nie do produkcyjnej obsługi klientów, sprzedaży, hostingu usług komercyjnych ani działań marketingowych.', met: 'Szacunek obejmuje około 450 tys. GPU-godzin równoważnika B300/H100/H200 dla treningów skalujących, modeli referencyjnych, powtórzeń i ewaluacji. Kwotę oszacowano na podstawie ofert/on-demand europejskich dostawców GPU, rezerwy na checkpointy i przechowywanie artefaktów oraz konieczności wykonania porównań RNM z transformerem przy tych samych warunkach treningowych.' },
  { task: '5.', help: 'Prace rozwojowe', cat: 'Personel projektu', match: 'Personel B+R - prace rozwojowe', name: 'Personel B+R - prace rozwojowe: integracja modeli RNM, biblioteka i dokumentacja', total: '2200000.00', grant: '1320000.00', uz: 'Koszt obejmuje wyłącznie wynagrodzenia personelu B+R wykonującego prace rozwojowe w Zadaniu 5: integrację wyników badań w działającą bibliotekę RNM, przygotowanie narzędzi API, uporządkowanie katalogu konceptów, testy techniczne implementacji, poprawki kodu oraz dokumentację techniczną. Nie obejmuje zewnętrznych pilotaży, publikacji, marketingu, compliance, obsługi klienta ani utrzymania komercyjnego.', met: 'Kalkulacja: 2,15 FTE w okresie prac rozwojowych x pełny koszt pracodawcy ról ML Engineer, Software Engineer i Evaluation Engineer. Stawki oszacowano na podstawie widełek wynagrodzeń AI/software w UE/PL, wymaganego seniority i udziału tych osób w Zadaniu 5.' },
];

const OBSOLETE_ROWS = [
  'Licencje oprogramowania',
  'Ekspertyzy IP/AI Act',
  'Koszty walidacji PR',
];

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
  await inp.click(); await inp.fill(search); // allow-raw-playwright: filter autocomplete
  await humanIdlePause('deliberate');
  const opt = page.locator("[role='listbox'] [role='option']").first();
  if (await opt.count() === 0) throw new Error(`no autocomplete option ${name} -> ${search}`);
  const picked = (await opt.textContent())?.trim()?.slice(0, 100);
  await opt.dispatchEvent('click'); // allow-raw-playwright: select filtered option
  await humanIdlePause('short');
  return picked;
}

async function fill(name, value) {
  const loc = page.locator(`[name="${name}"]`).first();
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
  }); // allow-raw-playwright: save cost row
  await humanIdlePause('long');
}

if (process.env.EDIT) {
  const contains = process.env.CONTAINS;
  const grant = process.env.GRANT;
  if (!contains || !grant) throw new Error('EDIT requires CONTAINS and GRANT');
  const row = page.locator('table').first().locator('tbody tr').filter({ hasText: contains }).first();
  await row.locator('button[aria-label="overflow-options"]').first().dispatchEvent('click'); // allow-raw-playwright: open cost row menu
  await humanIdlePause('deliberate');
  await page.getByRole('menuitem', { name: 'Edytuj', exact: true }).first().dispatchEvent('click'); // allow-raw-playwright: edit existing cost row
  await humanIdlePause('long');
  await fill('dofinansowanie', grant);
  await saveForm();
  console.log(JSON.stringify({ edited: contains, grant }, null, 2));
  process.exit(0);
}

if (process.env.REWRITE) {
  const rewritten = [];
  const rewriteRows = process.env.REWRITE_MATCH ? ROWS.filter((r) => r.match.includes(process.env.REWRITE_MATCH) || r.name.includes(process.env.REWRITE_MATCH)) : ROWS;
  if (!rewriteRows.length) throw new Error(`no rewrite rows match: ${process.env.REWRITE_MATCH}`);
  for (const r of rewriteRows) {
    await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
    await humanIdlePause('long');
    const row = page.locator('table').first().locator('tbody tr').filter({ hasText: r.match }).first();
    if (await row.count() === 0) throw new Error(`existing cost row not found: ${r.match}`);
    await row.locator('button[aria-label="overflow-options"]').first().dispatchEvent('click'); // allow-raw-playwright: open cost row menu for rewrite
    await humanIdlePause('deliberate');
    await page.getByRole('menuitem', { name: 'Edytuj', exact: true }).first().dispatchEvent('click'); // allow-raw-playwright: edit existing cost row
    await humanIdlePause('long');
    await fill('nazwa_kosztu', r.name);
    await fill('wydatki_ogolem', r.total);
    await fill('wydatki_kwalifikowalne', r.total);
    await fill('w_tym_vat', '0.00');
    await fill('dofinansowanie', r.grant);
    await fill('uzasadnienie_kosztu', r.uz);
    await fill('metoda_szacowania', r.met);
    await saveForm();
    rewritten.push(r.name);
  }
  const rows = await page.evaluate(() => {
    const table = document.querySelector('table');
    return table ? Array.from(table.querySelectorAll('tbody tr')).map((r) => r.innerText.replace(/\s+/g, ' ').trim()).slice(0, 20) : [];
  }); // allow-raw-playwright: read back cost table after rewrite
  console.log(JSON.stringify({ rewritten: rewritten.length, rows: rows.length, names: rewritten, firstRows: rows.slice(0, 8) }, null, 2));
  process.exit(0);
}

if (process.env.DELETE_OBSOLETE) {
  const deleted = [];
  const targets = process.env.DELETE_MATCHES ? process.env.DELETE_MATCHES.split(',').map((x) => x.trim()).filter(Boolean) : OBSOLETE_ROWS;
  for (const target of targets) {
    await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
    await humanIdlePause('long');
    const row = page.locator('table').first().locator('tbody tr').filter({ hasText: target }).first();
    if (await row.count() === 0) { deleted.push({ target, status: 'not_found' }); continue; }
    await row.locator('button[aria-label="overflow-options"]').first().dispatchEvent('click'); // allow-raw-playwright: open obsolete cost row menu
    await humanIdlePause('deliberate');
    const item = page.locator('[role="menuitem"], .MuiMenuItem-root').filter({ hasText: /Usuń|Usun|Delete/i }).first();
    if (await item.count() === 0) throw new Error(`delete menu item not found for ${target}`);
    await item.dispatchEvent('click'); // allow-raw-playwright: choose delete for obsolete cost row
    await humanIdlePause('deliberate');
    const confirm = page.locator('button').filter({ hasText: /Usuń|Usun|Potwierdź|Tak|Delete/i }).last();
    if (await confirm.count() > 0) await confirm.dispatchEvent('click'); // allow-raw-playwright: confirm deletion dialog
    await humanIdlePause('long');
    deleted.push({ target, status: 'deleted' });
  }
  console.log(JSON.stringify({ deleted }, null, 2));
  process.exit(0);
}

if (process.env.VERIFY_DETAILS) {
  const details = [];
  for (const r of ROWS) {
    await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
    await humanIdlePause('long');
    const row = page.locator('table').first().locator('tbody tr').filter({ hasText: r.name }).first();
    if (await row.count() === 0) throw new Error(`verified cost row not found: ${r.name}`);
    await row.locator('button[aria-label="overflow-options"]').first().dispatchEvent('click'); // allow-raw-playwright: open cost row menu for verification
    await humanIdlePause('deliberate');
    await page.getByRole('menuitem', { name: 'Edytuj', exact: true }).first().dispatchEvent('click'); // allow-raw-playwright: open existing cost row read-only verification
    await humanIdlePause('long');
    const item = await page.evaluate(() => {
      const v = (name) => document.querySelector(`[name="${name}"]`)?.value || '';
      return {
        nazwa: v('nazwa_kosztu'),
        uzLen: v('uzasadnienie_kosztu').length,
        uz: v('uzasadnienie_kosztu').slice(0, 180),
        uzSuffix: v('uzasadnienie_kosztu').slice(-220),
        metLen: v('metoda_szacowania').length,
        met: v('metoda_szacowania').slice(0, 180),
        metSuffix: v('metoda_szacowania').slice(-220),
      };
    }); // allow-raw-playwright: read existing cost row fields without saving
    details.push(item);
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Anuluj' && b.getClientRects().length);
      if (buttons.length) buttons[buttons.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    }); // allow-raw-playwright: close read-only opened cost row without saving
    await humanIdlePause('long');
  }
  console.log(JSON.stringify({ details }, null, 2));
  process.exit(0);
}

if (process.env.VERIFY_MATCH) {
  const contains = process.env.VERIFY_MATCH;
  const row = page.locator('table').first().locator('tbody tr').filter({ hasText: contains }).first();
  if (await row.count() === 0) throw new Error(`verified cost row not found: ${contains}`);
  await row.locator('button[aria-label="overflow-options"]').first().dispatchEvent('click'); // allow-raw-playwright: open cost row menu for single-row verification
  await humanIdlePause('deliberate');
  await page.getByRole('menuitem', { name: 'Edytuj', exact: true }).first().dispatchEvent('click'); // allow-raw-playwright: open existing cost row read-only verification
  await humanIdlePause('long');
  const item = await page.evaluate(() => {
    const read = (name) => {
      const el = document.querySelector(`[name="${name}"]`);
      return el ? { value: el.value || '', max: el.getAttribute('maxlength'), readOnly: el.readOnly, disabled: el.disabled } : null;
    };
    return {
      nazwa: read('nazwa_kosztu'),
      wydatki: read('wydatki_kwalifikowalne'),
      dofinansowanie: read('dofinansowanie'),
      uzasadnienie: read('uzasadnienie_kosztu'),
      metoda: read('metoda_szacowania'),
    };
  }); // allow-raw-playwright: read existing cost row fields without saving
  console.log(JSON.stringify({ contains, item }, null, 2));
  process.exit(0);
}

const added = [];
const wanted = process.env.COSTS ? new Set(process.env.COSTS.split(',').map((x) => Number(x.trim())).filter(Boolean)) : null;
const selectedRows = ROWS.map((r, i) => ({ ...r, rowNo: i + 1 })).filter((r) => !wanted || wanted.has(r.rowNo));
for (const r of selectedRows) {
  console.log(`START COST ${r.name.slice(0, 60)}`);
  await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');
  await clickDodaj();
  await page.waitForSelector('[name="nazwa_kosztu"]');
  await pickSelect('nazwa_zadania', r.task);
  try { await pickSelect('nazwa_skrocona_wnioskodawcy_samodzielnego_lidera_konsorcjum_konsorcjanta', 'Wisent Polska'); } catch (e) { /* sometimes auto */ }
  await fill('nazwa_kosztu', r.name);
  await setAuto('rodzaj_pomocy', r.help);
  await setAuto('kategoria_kosztu_feng', r.cat);
  await fill('wydatki_ogolem', r.total);
  await fill('wydatki_kwalifikowalne', r.total);
  await fill('w_tym_vat', '0.00');
  await fill('dofinansowanie', r.grant);
  await fill('uzasadnienie_kosztu', r.uz);
  await fill('metoda_szacowania', r.met);
  try {
    await saveForm();
    added.push(r.name);
    console.log(`SAVED COST ${r.name.slice(0, 60)}`);
  } catch (e) {
    console.log(`NOT SAVED COST ${r.name.slice(0, 60)}: ${String(e?.message || e).slice(0, 220)}`);
    break;
  }
}

console.log(JSON.stringify({ added: added.length }, null, 2));
process.exit(0);
