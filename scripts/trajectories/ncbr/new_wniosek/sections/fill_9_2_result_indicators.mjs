// Section 9.2 (Wskazniki rezultatu) filler for the NEW NCBR wniosek.
// Edits existing predefined indicator rows and adds own result indicators from the prepared markdown.
// Never closes the page.

import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { humanIdlePause } from '../../../../../dist/human/mouse.js';

const endpoint = process.env.NCBR_CDP_ENDPOINT || 'http://127.0.0.1:9223';
const SECTION_URL = 'https://lsi2.ncbr.gov.pl/projekt/7ee80d9a-67dd-4d99-becd-8dda407221c1/projekt_step/e95d0c23-8a39-4d56-96fa-ace3e4f0d23a';
const MD = readFileSync('/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/backends/STEP_sciezka_A_Wisent/wersja_B_9.2_wskazniki.md', 'utf8');

function cell(block, label) {
  const re = new RegExp(`^\\|\\s*(?:\\*\\*)?${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\*\\*)?\\s*\\|\\s*([\\s\\S]*?)\\s*\\|\\s*$`, 'm');
  const m = block.match(re);
  return m ? m[1].trim() : '';
}

function numeric(v) {
  return String(v || '').replace(/\s/g, '').replace(',', '.');
}

function lsiYearInput(year) {
  const n = Number(String(year || '').trim());
  return Number.isFinite(n) ? String(n) : String(year || '');
}

function indicators() {
  return MD.split(/^### /m).slice(1).map((raw) => {
    const block = `### ${raw}`;
    return {
      heading: raw.split('\n', 1)[0].trim(),
      name: cell(block, 'Nazwa wskaźnika'),
      unit: cell(block, 'Jednostka miary'),
      baseYear: cell(block, 'Rok bazowy'),
      baseValue: numeric(cell(block, 'Wartość bazowa')),
      targetYear: cell(block, 'Rok osiągnięcia wartości docelowej'),
      targetValue: numeric(cell(block, 'Wartość docelowa')),
      methodology: cell(block, 'Opis metodologii wyliczenia wskaźnika'),
      verification: cell(block, 'Opis sposobu weryfikacji osiągnięcia zaplanowanych wartości wskaźnika'),
    };
  }).filter((x) => x.name && !/HarmBench|attack success rate/i.test(x.name));
}

const allIndicators = indicators();
const existingIndicators = allIndicators.slice(0, 15);
const ownIndicators = allIndicators.slice(15);

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) { console.log(JSON.stringify({ error: 'NO_PAGE' })); process.exit(0); }
page.setDefaultTimeout(10000);

await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
await humanIdlePause('long');

async function openExistingRow(index) {
  const row = page.locator('table tbody tr').nth(index + 1);
  await row.locator('button[aria-label="overflow-options"]').first().dispatchEvent('click'); // allow-raw-playwright: open row menu
  await humanIdlePause('deliberate');
  await page.getByRole('menuitem', { name: 'Edytuj', exact: true }).first().dispatchEvent('click'); // allow-raw-playwright: edit row
  await humanIdlePause('long');
}

async function clickDodaj() {
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) => b.innerText.trim() === 'Dodaj' && !b.disabled);
    if (!btn) throw new Error('enabled Dodaj not found');
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }); // allow-raw-playwright: open new own-indicator row
  await humanIdlePause('long');
}

async function saveForm() {
  await humanIdlePause('deliberate');
  await humanIdlePause('deliberate');
  await page.evaluate(() => {
    const saves = Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Zapisz' && !b.disabled);
    if (!saves.length) throw new Error('no enabled Zapisz');
    saves[saves.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }); // allow-raw-playwright: save row
  await humanIdlePause('long');
}

async function fillField(suffix, value) {
  const loc = page.locator(`[name$="${suffix}"]`).first();
  if (await loc.count() === 0) return null;
  if (await loc.evaluate((el) => el.readOnly || el.disabled)) return null; // allow-raw-playwright: read field flags
  const max = Number(await loc.getAttribute('maxlength')) || String(value || '').length;
  const v = String(value || '');
  if (v.length > max) throw new Error(`${suffix} over limit: ${v.length}/${max}`);
  await loc.fill(v); // allow-raw-playwright: LSI indicator field
  await loc.dispatchEvent('input'); // allow-raw-playwright: force React dirty/input state
  await loc.dispatchEvent('change'); // allow-raw-playwright: force React dirty/change state
  await humanIdlePause('short');
  return `${suffix}:${v.length}/${max}`;
}

async function pickAutoByName(suffix, value) {
  const inp = page.locator(`input[name$="${suffix}"]`).first();
  if (await inp.count() === 0) return null;
  await inp.click(); // allow-raw-playwright: open autocomplete
  await inp.fill(value); // allow-raw-playwright: filter exact value
  await humanIdlePause('deliberate');
  const opt = page.getByRole('option', { name: value, exact: true }).first();
  if (await opt.count() > 0) {
    await opt.dispatchEvent('click'); // allow-raw-playwright: pick option
    await humanIdlePause('short');
    return value;
  }
  return null;
}

async function fillIndicator(ind, { preserveExistingTarget = false } = {}) {
  await pickAutoByName('nazwa_wskaznika', ind.name);
  await fillField('nazwa_wskaznika', ind.name);
  await fillField('jednostka_miary', ind.unit);
  await fillField('rok_bazowy', lsiYearInput(ind.baseYear));
  await fillField('wartosc_bazowa', ind.baseValue);
  await fillField('rok_osiagniecia_wartosci_docelowej', lsiYearInput(ind.targetYear));
  if (!preserveExistingTarget) await fillField('wartosc_docelowa', ind.targetValue);
  else {
    const target = page.locator('[name$="wartosc_docelowa"]').first();
    const cur = await target.inputValue().catch(() => '');
    if (!cur) await fillField('wartosc_docelowa', ind.targetValue);
  }
  await fillField('opis_metodologii', ind.methodology);
  await fillField('opis_sposobu_weryfikacji', ind.verification);
}

if (process.env.PARSE) {
  console.log(JSON.stringify({ count: allIndicators.length, existing: existingIndicators.map((x) => x.name), own: ownIndicators.map((x) => x.name) }, null, 2));
  process.exit(0);
}

if (process.env.DIAG_EDIT !== undefined) {
  const idx = Number(process.env.DIAG_EDIT);
  await openExistingRow(idx);
  const dump = await page.evaluate(() => ({
    fields: Array.from(document.querySelectorAll('input, textarea')).map((i) => ({
      tag: i.tagName,
      type: i.type || null,
      name: i.name || null,
      value: (i.value || '').slice(0, 140),
      max: i.getAttribute('maxlength'),
      readOnly: i.readOnly,
      label: i.id ? document.querySelector(`label[for="${CSS.escape(i.id)}"]`)?.textContent?.trim() : null,
    })).filter((x) => x.name || x.label),
    saves: Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Zapisz').map((b) => ({ disabled: b.disabled })),
  }));
  console.log(JSON.stringify({ idx, expected: existingIndicators[idx]?.name, dump }, null, 2));
  process.exit(0);
}

if (process.env.DIAG_ADD) {
  await clickDodaj();
  const dump = await page.evaluate(() => ({
    fields: Array.from(document.querySelectorAll('input, textarea')).map((i) => ({
      tag: i.tagName,
      type: i.type || null,
      name: i.name || null,
      role: i.getAttribute('role'),
      value: (i.value || '').slice(0, 140),
      max: i.getAttribute('maxlength'),
      readOnly: i.readOnly,
      label: i.id ? document.querySelector(`label[for="${CSS.escape(i.id)}"]`)?.textContent?.trim() : null,
    })).filter((x) => x.name || x.label),
  }));
  console.log(JSON.stringify({ ownCount: ownIndicators.length, firstOwn: ownIndicators[0]?.name, dump }, null, 2));
  process.exit(0);
}

if (process.env.VERIFY_DETAILS) {
  const details = [];
  const count = await page.locator('button[aria-label="overflow-options"]').count();
  for (let i = 0; i < count; i++) {
    await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
    await humanIdlePause('long');
    const buttons = page.locator('button[aria-label="overflow-options"]');
    if (await buttons.count() <= i) break;
    await buttons.nth(i).dispatchEvent('click'); // allow-raw-playwright: open indicator row menu for read-only verification
    await humanIdlePause('deliberate');
    await page.getByRole('menuitem', { name: 'Edytuj', exact: true }).first().dispatchEvent('click'); // allow-raw-playwright: open existing indicator row read-only verification
    await humanIdlePause('long');
    const item = await page.evaluate(() => {
      const v = (suffix) => {
        const el = Array.from(document.querySelectorAll('input, textarea')).find((e) => (e.name || '').endsWith(suffix));
        return el ? String(el.value || '') : '';
      };
      return {
        name: v('nazwa_wskaznika').slice(0, 160),
        methodologyLen: v('opis_metodologii').length,
        methodologySuffix: v('opis_metodologii').slice(-220),
        verificationLen: v('opis_sposobu_weryfikacji').length,
        verificationSuffix: v('opis_sposobu_weryfikacji').slice(-220),
      };
    }); // allow-raw-playwright: read existing 9.2 row fields without saving
    details.push(item);
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Anuluj' && b.getClientRects().length);
      if (buttons.length) buttons[buttons.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    }); // allow-raw-playwright: close opened row without saving
    await humanIdlePause('long');
  }
  console.log(JSON.stringify({ count, details }, null, 2));
  process.exit(0);
}

const edited = [];
const start = process.env.START ? Number(process.env.START) : 0;
const limit = process.env.LIMIT ? Number(process.env.LIMIT) : existingIndicators.length;
for (let i = start; i < Math.min(existingIndicators.length, start + limit); i++) {
  await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');
  await openExistingRow(i);
  if (process.env.BASE_YEAR_ONLY) {
    await fillField('rok_bazowy', existingIndicators[i].baseYear);
  } else {
    await fillIndicator(existingIndicators[i], { preserveExistingTarget: i === 12 });
  }
  await saveForm();
  edited.push(existingIndicators[i].name);
}

const added = [];
if (process.env.ADD_OWN !== '0') {
  for (const ind of ownIndicators) {
    await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
    await humanIdlePause('long');
    const body = await page.evaluate(() => document.body.innerText || '');
    if (body.includes(ind.name)) continue;
    await clickDodaj();
    await fillIndicator(ind);
    await saveForm();
    added.push(ind.name);
  }
}

const rows = await page.evaluate(() => {
  const table = document.querySelector('table');
  return table ? Array.from(table.querySelectorAll('tbody tr')).map((r) => r.innerText.replace(/\s+/g, ' ').trim()).slice(0, 25) : [];
});
console.log(JSON.stringify({ edited, added, rows: rows.length, firstRows: rows.slice(0, 5), lastRows: rows.slice(-5) }, null, 2));
process.exit(0);
