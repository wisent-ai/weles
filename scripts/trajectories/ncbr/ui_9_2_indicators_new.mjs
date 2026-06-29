// UI-only section 9.2 result indicators filler for the replacement NCBR STEP B draft.
// Edits existing rows by UI menus and adds missing own rows. Never submits.

import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { humanIdlePause } from '../../../dist/human/mouse.js';

const endpoint = process.env.NCBR_CDP_ENDPOINT || 'http://127.0.0.1:9223';
const projectId = process.env.NCBR_PROJECT_ID || '7ee80d9a-67dd-4d99-becd-8dda407221c1';
const SECTION_URL = `https://lsi2.ncbr.gov.pl/projekt/${projectId}/projekt_step/e95d0c23-8a39-4d56-96fa-ace3e4f0d23a`;
const MD = readFileSync('/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/backends/STEP_sciezka_A_Wisent/wersja_B_9.2_wskazniki.md', 'utf8');

function cell(block, label) {
  const re = new RegExp(`^\\|\\s*(?:\\*\\*)?${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\*\\*)?\\s*\\|\\s*([\\s\\S]*?)\\s*\\|\\s*$`, 'm');
  return (block.match(re)?.[1] || '').trim();
}

const numeric = (v) => String(v || '').replace(/\s/g, '').replace(',', '.');
const year = (v) => String(Number(String(v || '').trim()) || v || '');

function parseIndicators() {
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

const indicators = parseIndicators();
if (process.env.PARSE) {
  console.log(JSON.stringify({ count: indicators.length, names: indicators.map((i) => i.name) }, null, 2));
  process.exit(0);
}

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) { console.log(JSON.stringify({ error: 'NO_PAGE' }, null, 2)); process.exit(1); }
page.setDefaultTimeout(12000);

await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' }); // allow-raw-playwright: authenticated LSI section navigation
await humanIdlePause('long');
await page.evaluate(() => {
  const banner = Array.from(document.querySelectorAll('div')).find((d) => (d.innerText || '').includes('pliki cookies'));
  if (banner) banner.style.pointerEvents = 'none';
}); // allow-raw-playwright: neutralise cookie overlay only

if (process.env.INSPECT) {
  const data = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    buttons: Array.from(document.querySelectorAll('button')).map((b) => ({ text: b.innerText.trim(), aria: b.getAttribute('aria-label'), disabled: b.disabled })).filter((b) => b.text || b.aria).slice(0, 80),
    rows: Array.from(document.querySelectorAll('table tbody tr')).map((r) => Array.from(r.querySelectorAll('td')).map((td) => td.innerText.trim().replace(/\s+/g, ' ')).join(' | ')).slice(0, 40),
    fields: Array.from(document.querySelectorAll('input, textarea')).filter((el) => el.offsetParent !== null).map((el) => ({ name: el.name || '', role: el.getAttribute('role'), value: (el.value || '').slice(0, 140), len: (el.value || '').length, readOnly: el.readOnly, disabled: el.disabled })).slice(0, 80),
  })); // allow-raw-playwright: read current 9.2 UI state only
  console.log(JSON.stringify(data, null, 2));
  process.exit(0);
}

async function openRow(index) {
  await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' }); // allow-raw-playwright: refresh section table
  await humanIdlePause('long');
  const row = page.locator('table tbody tr').nth(index + 1);
  await row.locator('button[aria-label="overflow-options"]').first().dispatchEvent('click'); // allow-raw-playwright: open row menu
  await humanIdlePause('deliberate');
  await page.getByRole('menuitem', { name: 'Edytuj', exact: true }).first().dispatchEvent('click'); // allow-raw-playwright: edit existing row
  await humanIdlePause('long');
}

async function openRowByNeedles(needles) {
  await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' }); // allow-raw-playwright: refresh section table
  await humanIdlePause('long');
  await page.evaluate((items) => {
    const rows = Array.from(document.querySelectorAll('table tbody tr'));
    const row = rows.find((r) => items.some((needle) => (r.innerText || '').includes(needle)));
    if (!row) throw new Error(`row not found: ${items.join(' / ')}`);
    const btn = row.querySelector('button[aria-label="overflow-options"]');
    if (!btn) throw new Error(`row menu not found: ${items.join(' / ')}`);
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }, needles); // allow-raw-playwright: open exact 9.2 row menu by visible table text
  await humanIdlePause('deliberate');
  await page.getByRole('menuitem', { name: 'Edytuj', exact: true }).first().dispatchEvent('click'); // allow-raw-playwright: edit matched row
  await humanIdlePause('long');
}

async function clickAdd() {
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) => b.innerText.trim() === 'Dodaj' && !b.disabled);
    if (!btn) throw new Error('enabled Dodaj not found');
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }); // allow-raw-playwright: open add indicator form
  await humanIdlePause('long');
}

async function saveForm() {
  await humanIdlePause('deliberate');
  await humanIdlePause('deliberate');
  const state = await page.evaluate(() => {
    const saves = Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Zapisz' && !b.disabled);
    if (!saves.length) {
      const errors = Array.from(document.querySelectorAll('[aria-invalid="true"], .Mui-error')).map((e) => (e.getAttribute('name') || e.textContent || '').trim().slice(0, 80)).filter(Boolean).slice(0, 12);
      return { status: 'no-enabled-save', errors };
    }
    saves[saves.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return { status: 'saved', errors: [] };
  }); // allow-raw-playwright: save row through UI
  await humanIdlePause('long');
  if (state.status !== 'saved') {
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => b.innerText.trim() === 'Anuluj');
      if (btn) btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    }); // allow-raw-playwright: close unchanged or invalid row without saving
    await humanIdlePause('long');
  }
  return state;
}

async function fillField(suffix, value, { preserve = false } = {}) {
  const loc = page.locator(`[name$="${suffix}"]`).first();
  if (await loc.count() === 0) return null;
  if (await loc.evaluate((el) => el.readOnly || el.disabled)) return null; // allow-raw-playwright: check field mutability
  if (preserve) {
    const cur = await loc.inputValue().catch(() => '');
    if (cur) return `${suffix}:preserved`;
  }
  const max = Number(await loc.getAttribute('maxlength')) || String(value || '').length;
  let v = String(value || '');
  if (v.length > max) v = v.slice(0, max).replace(/\s+\S*$/, '');
  await loc.fill(v); // allow-raw-playwright: fill visible LSI field
  await loc.dispatchEvent('input'); // allow-raw-playwright: React dirty state
  await loc.dispatchEvent('change'); // allow-raw-playwright: React change state
  await humanIdlePause('short');
  return `${suffix}:${v.length}/${max}`;
}

async function pickName(value) {
  const input = page.locator('input[name$="nazwa_wskaznika"]').first();
  if (await input.count() === 0) return null;
  if (await input.evaluate((el) => el.readOnly || el.disabled).catch(() => true)) return null; // allow-raw-playwright: check field mutability
  await input.click(); // allow-raw-playwright: open indicator combobox
  await input.fill(value); // allow-raw-playwright: filter indicator name
  await humanIdlePause('deliberate');
  const opt = page.getByRole('option', { name: value, exact: true }).first();
  if (await opt.count() > 0) await opt.dispatchEvent('click'); // allow-raw-playwright: select exact indicator option
  else await fillField('nazwa_wskaznika', value);
  await humanIdlePause('short');
  return value;
}

async function fillIndicator(ind, index) {
  const filled = [];
  await pickName(ind.name);
  filled.push(await fillField('nazwa_wskaznika', ind.name));
  filled.push(await fillField('jednostka_miary', ind.unit));
  filled.push(await fillField('rok_bazowy', year(ind.baseYear)));
  filled.push(await fillField('wartosc_bazowa', ind.baseValue));
  filled.push(await fillField('rok_osiagniecia_wartosci_docelowej', year(ind.targetYear)));
  filled.push(await fillField('wartosc_docelowa', ind.targetValue, { preserve: index === 12 }));
  filled.push(await fillField('opis_metodologii', ind.methodology));
  filled.push(await fillField('opis_sposobu_weryfikacji', ind.verification));
  return filled.filter(Boolean);
}

if (process.env.VERIFY_DETAILS) {
  const count = await page.locator('button[aria-label="overflow-options"]').count();
  const rows = [];
  for (let i = 0; i < count; i++) {
    await openRow(i);
    rows.push(await page.evaluate(() => {
      const val = (suffix) => Array.from(document.querySelectorAll('input, textarea')).find((el) => (el.name || '').endsWith(suffix))?.value || '';
      return { name: val('nazwa_wskaznika'), methodologyLen: val('opis_metodologii').length, verificationLen: val('opis_sposobu_weryfikacji').length };
    })); // allow-raw-playwright: read visible row fields
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => b.innerText.trim() === 'Anuluj');
      if (btn) btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    }); // allow-raw-playwright: close row without saving
    await humanIdlePause('long');
  }
  console.log(JSON.stringify({ count, rows }, null, 2));
  process.exit(0);
}

if (process.env.TARGET_GRANTLAND) {
  const targets = [
    {
      indicator: indicators.find((i) => i.name === 'Liczba przedsięwzięć proekologicznych'),
      needles: ['Liczba przedsięwzięć proekologicznych'],
    },
    {
      indicator: indicators.find((i) => i.name.startsWith('Redukcja ilości tokenów treningowych')),
      needles: ['Redukcja ilości tokenów treningowych'],
    },
    {
      indicator: indicators.find((i) => i.name.startsWith('Udział cykli treningowych RNM z pomiarem energii')),
      needles: ['Udział cykli treningowych RNM z pomiarem energii', 'Udział cykli treningowych RNM z raportem energii'],
    },
  ];
  const results = [];
  for (const t of targets) {
    if (!t.indicator) throw new Error(`target indicator not parsed: ${t.needles.join(' / ')}`);
    await openRowByNeedles(t.needles);
    const filled = await fillIndicator(t.indicator, 99);
    const save = await saveForm();
    results.push({ name: t.indicator.name, save, filled });
  }
  const rows = await page.evaluate(() => Array.from(document.querySelectorAll('table tbody tr')).map((r) => r.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean)); // allow-raw-playwright: read updated 9.2 table
  console.log(JSON.stringify({ results, rows: rows.filter((r) => /proekologicznych|Redukcja ilości|Udział cykli/.test(r)) }, null, 2));
  process.exit(0);
}

const edited = [];
const rowCount = await page.locator('button[aria-label="overflow-options"]').count();
for (let i = 0; i < Math.min(rowCount, indicators.length); i++) {
  await openRow(i);
  const filled = await fillIndicator(indicators[i], i);
  const save = await saveForm();
  edited.push({ name: indicators[i].name, save, filled });
}

const added = [];
for (let i = rowCount; i < indicators.length; i++) {
  await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' }); // allow-raw-playwright: refresh before add
  await humanIdlePause('long');
  const body = await page.locator('body').innerText().catch(() => '');
  if (body.includes(indicators[i].name)) continue;
  await clickAdd();
  const filled = await fillIndicator(indicators[i], i);
  const save = await saveForm();
  added.push({ name: indicators[i].name, save, filled });
}

const rows = await page.evaluate(() => document.querySelector('table')?.querySelectorAll('tbody tr').length || 0); // allow-raw-playwright: read table row count
console.log(JSON.stringify({ edited: edited.length, added, rows }, null, 2));
process.exit(0);
