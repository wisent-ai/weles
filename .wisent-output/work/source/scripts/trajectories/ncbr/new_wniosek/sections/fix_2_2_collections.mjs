// Repairs section 2.2 missing collections and clears the chain-value field. UI-only.
// Never submits and never closes the page.

import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { humanIdlePause } from '../../../../../dist/human/mouse.js';

const endpoint = process.env.NCBR_CDP_ENDPOINT || 'http://127.0.0.1:9223';
const SECTION_URL = 'https://lsi2.ncbr.gov.pl/projekt/7ee80d9a-67dd-4d99-becd-8dda407221c1/projekt_step/80ebca16-a9dd-4798-a334-5ac007cecbf7';
const MD = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/backends/STEP_sciezka_A_Wisent/wersja_B_2.2_innowacyjnosc_i_zaleznosci.md';
const md = readFileSync(MD, 'utf8');

function clean(s) { return s.replace(/\s*<!--[\s\S]*?-->\s*/g, ' ').trim(); }
function featureBlock(n) {
  const start = `### Cecha/funkcjonalność ${n}:`;
  const a = md.indexOf(start);
  if (a < 0) throw new Error(`feature ${n} missing`);
  const b = md.indexOf(`### Cecha/funkcjonalność ${n + 1}:`, a + start.length);
  return clean(md.slice(a, b >= 0 ? b : md.indexOf('## Rezultat prac B+R spełnia', a)));
}
function tableVal(block, label) {
  for (const line of block.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
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
const factorRows = factorTable.split(/\r?\n/).filter((l) => l.trim().startsWith('|') && !/---|Wybrany czynnik/.test(l));
const FACTORS = factorRows.map((line) => {
  const cells = line.split('|').map((c) => c.trim());
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

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) { console.log(JSON.stringify({ error: 'NO_PAGE' })); process.exit(0); }
page.setDefaultTimeout(10000);

await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
await humanIdlePause('long');
await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll('div')).find((d) => (d.innerText || '').includes('pliki cookies'));
  if (b) b.style.pointerEvents = 'none';
}); // allow-raw-playwright: neutralise cookie banner

async function clickDodaj(nth = 0) {
  await page.evaluate((n) => {
    const btns = Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Dodaj' && b.getClientRects().length);
    if (!btns[n]) throw new Error(`Dodaj #${n} not found; count=${btns.length}`);
    btns[n].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }, nth); // allow-raw-playwright: open collection subform
  await humanIdlePause('long');
}

async function saveForm() {
  await humanIdlePause('deliberate');
  await humanIdlePause('deliberate');
  await page.evaluate(() => {
    const saves = Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Zapisz' && !b.disabled);
    if (!saves.length) throw new Error('no enabled Zapisz');
    saves[saves.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }); // allow-raw-playwright: save subform
  await humanIdlePause('long');
}

async function fillBySuffix(suffix, value) {
  const loc = page.locator(`textarea[name$="${suffix}"], input[name$="${suffix}"]`).first();
  await loc.waitFor({ state: 'visible' });
  const max = Number(await loc.getAttribute('maxlength')) || String(value).length;
  let v = String(value || '');
  if (v.length > max) v = v.slice(0, max).replace(/\s+\S*$/, '');
  await loc.fill(v); // allow-raw-playwright: 2.2 collection text field
  await humanIdlePause('short');
  return `${suffix} ${v.length}/${max}`;
}

async function fillByName(name, value) {
  const loc = page.locator(`[name="${name}"]`).first();
  await loc.waitFor({ state: 'visible' });
  const max = Number(await loc.getAttribute('maxlength')) || String(value).length;
  let v = String(value || '');
  if (v.length > max) v = v.slice(0, max).replace(/\s+\S*$/, '');
  await loc.fill(v); // allow-raw-playwright: 2.2 collection field by name
  await humanIdlePause('short');
  return `${name} ${v.length}/${max}`;
}

async function setAutoByName(name, search) {
  const inp = page.locator(`input[name="${name}"]`).first();
  await inp.click(); // allow-raw-playwright: open autocomplete
  await inp.fill(search); // allow-raw-playwright: filter option
  await humanIdlePause('deliberate');
  const opt = page.locator('[role="option"]').first();
  if (await opt.count() === 0) throw new Error(`no option for ${name}: ${search}`);
  const picked = (await opt.textContent())?.trim();
  await opt.click({ force: true }); // allow-raw-playwright: select option
  await humanIdlePause('short');
  return picked;
}

async function pickFactors() {
  const picked = [];
  for (const label of [
    'wiodącej pozycji Unii',
    'pozytywnych skutków transgranicznych',
  ]) {
    const inp = page.locator('input[name$="rezultat_prac_br_spelnia_nastepujace_czynniki"]').first();
    await inp.click(); // allow-raw-playwright: open factors multi
    await inp.fill(''); // allow-raw-playwright: clear previous factor filter
    await humanIdlePause('deliberate');
    const opt = page.locator('[role="option"]').filter({ hasText: label }).first();
    if (await opt.count() === 0) {
      const seen = await page.evaluate(() => Array.from(document.querySelectorAll('[role="option"]')).map((o) => o.textContent.trim()).filter(Boolean));
      throw new Error(`factor option not found: ${label}; seen=${seen.join(' | ')}`);
    }
    await opt.click({ force: true }); // allow-raw-playwright: pick factor
    picked.push(label);
    await humanIdlePause('short');
  }
  return picked;
}

if (process.env.DIAG_DODAJ) {
  await clickDodaj(Number(process.env.DIAG_DODAJ) || 0);
  const out = await page.evaluate(() => ({
    fields: Array.from(document.querySelectorAll('input, textarea')).map((el) => {
      const label = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent?.trim() : null;
      return { tag: el.tagName, name: el.name || null, type: el.type || null, role: el.getAttribute('role'), max: el.getAttribute('maxlength'), value: (el.value || '').slice(0, 80), label };
    }).filter((f) => f.name || f.label),
    buttons: Array.from(document.querySelectorAll('button')).map((b) => b.innerText.trim()).filter(Boolean),
  }));
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

if (process.env.DIAG_FACTOR_DODAJ) {
  const picked = await pickFactors();
  await clickDodaj(1);
  const out = await page.evaluate(() => ({
    picked: Array.from(document.querySelectorAll('.MuiChip-label')).map((e) => e.textContent.trim()),
    fields: Array.from(document.querySelectorAll('input, textarea')).map((el) => {
      const label = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent?.trim() : null;
      return { tag: el.tagName, name: el.name || null, type: el.type || null, role: el.getAttribute('role'), max: el.getAttribute('maxlength'), value: (el.value || '').slice(0, 80), label };
    }).filter((f) => f.name || f.label),
    buttons: Array.from(document.querySelectorAll('button')).map((b) => b.innerText.trim()).filter(Boolean),
  }));
  console.log(JSON.stringify({ picked, out }, null, 2));
  process.exit(0);
}

if (process.env.DIAG_FACTORS) {
  const inp = page.locator('input[name$="rezultat_prac_br_spelnia_nastepujace_czynniki"]').first();
  await inp.click(); // allow-raw-playwright: open factors multi
  await humanIdlePause('deliberate');
  const options = await page.evaluate(() => Array.from(document.querySelectorAll('[role="option"]')).map((o) => o.textContent.trim()).filter(Boolean));
  console.log(JSON.stringify({ options }, null, 2));
  process.exit(0);
}

if (process.env.CLEAR_POW) {
  const out = await page.evaluate(() => {
    const el = document.querySelector('textarea[name$="innowacja_produktowa_powiazanie_rezultatu_prac_br_z_lancuchem_wartosci"]');
    const before = el ? el.value : null;
    if (el && before) {
      el.value = '';
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.blur();
    }
    const saves = Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Zapisz');
    return {
      beforeLen: before?.length ?? null,
      afterLen: el ? el.value.length : null,
      saves: saves.map((b) => ({ disabled: b.disabled, text: b.innerText.trim(), visible: b.getClientRects().length > 0 })),
      errors: Array.from(document.querySelectorAll('[aria-invalid="true"], .Mui-error')).map((e) => (e.getAttribute('name') || e.textContent || '').trim().slice(0, 100)).filter(Boolean).slice(0, 20),
    };
  }); // allow-raw-playwright: clear forbidden field and inspect save state
  await humanIdlePause('deliberate');
  let saveResult = 'not-clicked';
  const clicked = await page.evaluate(() => {
    const saves = Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Zapisz' && !b.disabled && b.getClientRects().length);
    if (!saves.length) return false;
    saves[saves.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return true;
  }); // allow-raw-playwright: save main section after clearing forbidden field
  if (clicked) { saveResult = 'clicked'; await humanIdlePause('long'); }
  const readback = await page.evaluate(() => ({
    powLen: document.querySelector('textarea[name$="innowacja_produktowa_powiazanie_rezultatu_prac_br_z_lancuchem_wartosci"]')?.value.length ?? null,
    saves: Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Zapisz').map((b) => b.disabled),
  })); // allow-raw-playwright: read back field state
  console.log(JSON.stringify({ out, saveResult, readback }, null, 2));
  process.exit(0);
}

if (process.env.CLEAR_POW_KEYS) {
  const loc = page.locator('textarea[name$="innowacja_produktowa_powiazanie_rezultatu_prac_br_z_lancuchem_wartosci"]').first();
  const before = await loc.inputValue();
  await loc.click(); // allow-raw-playwright: focus the field that validation requires empty
  await loc.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A'); // allow-raw-playwright: select current value
  await loc.press('Backspace'); // allow-raw-playwright: remove current value through field keyboard handler
  await loc.press('Tab'); // allow-raw-playwright: blur so form validation runs
  await humanIdlePause('deliberate');
  const after = await loc.inputValue();
  const savesBefore = await page.evaluate(() => Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Zapisz').map((b) => b.disabled));
  let saveResult = 'not-clicked';
  const clicked = await page.evaluate(() => {
    const saves = Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Zapisz' && !b.disabled && b.getClientRects().length);
    if (!saves.length) return false;
    saves[saves.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return true;
  }); // allow-raw-playwright: save main section after keyboard-driven clear
  if (clicked) { saveResult = 'clicked'; await humanIdlePause('long'); }
  console.log(JSON.stringify({ beforeLen: before.length, afterLen: after.length, savesBefore, saveResult }, null, 2));
  process.exit(0);
}

if (process.env.DIAG_SET_KIND) {
  const inp = page.locator('input[name$="rodzaj_innowacji"]').first();
  await inp.click(); // allow-raw-playwright: open kind combobox
  await inp.fill('Innowacja produktowa'); // allow-raw-playwright: set kind text
  await humanIdlePause('deliberate');
  await inp.press('ArrowDown'); // allow-raw-playwright: highlight option
  await inp.press('Enter'); // allow-raw-playwright: accept highlighted option
  await humanIdlePause('deliberate');
  const out = await page.evaluate(() => ({
    kind: Array.from(document.querySelectorAll('input')).find((i) => i.name.endsWith('rodzaj_innowacji'))?.value || '',
    productVisible: Boolean(document.querySelector('input[name$="innowacja_produktowa_nazwa"]')),
    saves: Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Zapisz').map((b) => b.disabled),
  }));
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

const done = [];
for (const feature of FEATURES) {
  await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');
  const exists = await page.evaluate((needle) => (document.body.innerText || '').includes(needle.slice(0, 120)), feature.cecha);
  if (exists) { done.push({ collection: 'cecha', skippedExisting: feature.cecha.slice(0, 80) }); continue; }
  await clickDodaj(0);
  const filled = [];
  filled.push(await fillByName('cecha_funkcjonalnosc_rezultatu_projektu', feature.cecha));
  filled.push(await fillByName('wartosc_bazowa', feature.bazowa));
  filled.push(await fillByName('wartosc_docelowa', feature.docelowa));
  filled.push(await fillByName('produkt_proces_referencyjny', feature.referencyjny));
  filled.push(await fillByName('korzysc_przewaga', feature.korzysc));
  filled.push(await fillByName('sposob_weryfikacji_osiagniecia_wartosci_docelowej', feature.weryfikacja));
  await saveForm();
  done.push({ collection: 'cecha', added: feature.cecha.slice(0, 80), filled });
}

for (const factor of FACTORS) {
  await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');
  const exists = await page.evaluate((needle) => (document.body.innerText || '').includes(needle), factor.parametr);
  if (exists) { done.push({ collection: 'czynnik', skippedExisting: factor.parametr }); continue; }
  await clickDodaj(1);
  const picked = await setAutoByName('wybrany_czynnik', factor.czynnik);
  const filled = [];
  filled.push(await fillByName('nazwa_parametru', factor.parametr));
  filled.push(await fillByName('wartosc_bazowa', factor.bazowa));
  filled.push(await fillByName('rok_bazowy', factor.rokBazowy));
  filled.push(await fillByName('wartosc_docelowa', factor.docelowa));
  filled.push(await fillByName('rok_docelowy', factor.rokDocelowy));
  filled.push(await fillByName('metoda_szacowania_wartosci_docelowej', factor.metoda));
  filled.push(await fillByName('sposob_monitorowania_weryfikacji_osiagniecia_zaplanowanych_wartosci_docelowych', factor.weryfikacja));
  await saveForm();
  done.push({ collection: 'czynnik', added: factor.parametr, picked, filled });
}

await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
await humanIdlePause('long');
const pow = page.locator('textarea[name$="innowacja_produktowa_powiazanie_rezultatu_prac_br_z_lancuchem_wartosci"]').first();
if (await pow.count() > 0 && (await pow.inputValue()).length > 0) {
  await pow.fill(''); // allow-raw-playwright: validation requires this field empty for selected 1.2 project type
  await humanIdlePause('short');
  await page.evaluate(() => {
    const s = Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Zapisz' && !b.disabled);
    if (!s.length) throw new Error('no enabled main Zapisz');
    s[s.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }); // allow-raw-playwright: save main section after clearing chain-value field
  await humanIdlePause('long');
  done.push({ field: 'powiazanie_lancuch_wartosci', value: '' });
}

const readback = await page.evaluate(() => ({
  tables: Array.from(document.querySelectorAll('table')).map((t) => ({ rows: t.querySelectorAll('tbody tr').length, text: t.innerText.replace(/\s+/g, ' ').slice(0, 350) })),
  powLen: document.querySelector('textarea[name$="innowacja_produktowa_powiazanie_rezultatu_prac_br_z_lancuchem_wartosci"]')?.value.length ?? null,
}));
console.log(JSON.stringify({ done, readback }, null, 2));
process.exit(0);
