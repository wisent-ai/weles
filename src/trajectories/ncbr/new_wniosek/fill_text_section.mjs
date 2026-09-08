// Plan-driven text filler and verifier for the NCBR wniosek (project 7ee80d9a).
// SECTION selects a plan section, a plan collection label, or a markdown registry entry.
// MODE=read compares live values with the plan and never types or saves; plan collections
// are verify-only here, writing their rows stays in apply_correction.mjs.
// Never closes the page.

import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';
import { humanFill } from '../../../../dist/human/keyboard.js';

const endpoint = process.env.NCBR_CDP_ENDPOINT || 'http://127.0.0.1:9223';
const BASE = 'https://lsi2.ncbr.gov.pl/projekt/7ee80d9a-67dd-4d99-becd-8dda407221c1/projekt_step/';
const SRC = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/backends/STEP_sciezka_A_Wisent/';

// Char-limit constants mirror the live LSI maxlength config per field.
const REGISTRY = {
  '2.1': {
    sectionId: 'c048ab30-3dda-4228-bf71-4ec6904cffda',
    md: 'wersja_B_2.1_cel_i_potrzeba.md',
    fields: [
      { sel: 'textarea[name$="cel_projektu.cel_projektu"]', header: 'Cel projektu', max: 2000 },
      { sel: 'textarea[name$="strategiczna_potrzeba_na_poziomie_ue"]', header: 'Strategiczna potrzeba', max: 10000 },
    ],
  },
  '2.4': {
    sectionId: '94fb1adb-38a5-4949-b4c1-b0a79472bfd3',
    md: 'wersja_B_2.4_efekty_zewnetrzne.md',
    fields: [
      { sel: 'textarea[name$="dodatkowe_efekty_zewnetrzne"]', header: 'Dodatkowe efekty zewnętrzne innowacji', max: 3000 },
    ],
  },
  '3.5': {
    sectionId: '41b2184d-76e9-4b79-8ece-b2e227dc471f',
    md: 'wersja_B_3.5_prawa_wlasnosci.md',
    fields: [
      { sel: 'textarea[name$="wykazanie_braku_barier"]', header: 'Wykazanie braku barier', max: 3000 },
      { sel: 'textarea[name$="z_jakich_baz_danych"]', tableKey: 'Bazy danych', max: 300 },
      { sel: 'textarea[name$="klasyfikacja_mkp"]', tableKey: 'Klasyfikacja MKP', max: 400 },
      { sel: 'textarea[name$="slowa_kluczowe_lub_nazwy_firm_lub_nazwisk_tworcow_uzyto"]', tableKey: 'Słowa kluczowe', max: 400 },
      { sel: 'textarea[name$="prawa_wlasnosci_intelektualnej.opis_wynikow"]', tableKey: 'Wyniki', max: 6000 },
      { sel: 'textarea[name$="przedmiot_ochrony"]', header: 'Przedmiot ochrony', max: 4000 },
      { sel: 'textarea[name$="opis_sposobu"]', header: 'Opis sposobu uregulowania', max: 4000 },
    ],
  },
};

const SECTION = process.env.SECTION || '2.1';
const PLAN_FILE = process.env.NCBR_CORRECTION_PLAN_FILE || '';
const MODE = process.env.MODE || 'apply';

// A correction plan (weles.ncbr.correction-plan.v1) is the single source of truth for
// fields it declares: value and character limit come from the plan, not from markdown.
function planSection(file, label) {
  const plan = JSON.parse(readFileSync(file, 'utf8'));
  const section = (plan.sections || []).find((s) => s.label === label);
  if (!section) throw new Error(`plan ${file} has no section labelled ${label}`);
  const fields = section.fields || [];
  if (!fields.length) throw new Error(`plan section ${label} declares no scalar fields`);
  return {
    sectionId: section.id,
    fields: fields.map((f) => ({ sel: `textarea[name$="${f.name}"]`, label: f.name, value: f.value, max: f.maxLength })),
  };
}

function planCollection(file, label) {
  const plan = JSON.parse(readFileSync(file, 'utf8'));
  return (plan.collections || []).find((c) => c.label === label) || null;
}

const collection = PLAN_FILE ? planCollection(PLAN_FILE, SECTION) : null;
const cfg = collection ? null : (PLAN_FILE ? planSection(PLAN_FILE, SECTION) : REGISTRY[SECTION]);
if (!cfg && !collection) throw new Error(`no registry entry, plan section or plan collection for SECTION=${SECTION}`);
if (MODE === 'read' && !PLAN_FILE) throw new Error('MODE=read compares against a plan: set NCBR_CORRECTION_PLAN_FILE');
if (collection && MODE !== 'read') throw new Error(`${SECTION} is a plan collection: this runner verifies its rows with MODE=read`);

const md = cfg?.md ? readFileSync(SRC + cfg.md, 'utf8').split('\n') : [];
const plain = (s) => s
  .replace(/\s*<!--[\s\S]*?-->\s*/g, ' ')
  .replace(/\*\*([^*]+)\*\*/g, '$1')
  .trim();
function valueOf(key) {
  let start = -1;
  for (let i = 0; i < md.length; i++) { if (md[i].startsWith('## ') && md[i].toLowerCase().includes(key.toLowerCase())) { start = i; break; } }
  if (start < 0) throw new Error(`heading not found: ${key}`);
  let end = md.length;
  for (let i = start + 1; i < md.length; i++) { if (md[i].startsWith('## ') || md[i].trim() === '---' || md[i].startsWith('# ')) { end = i; break; } }
  return plain(md.slice(start + 1, end).join('\n'));
}
function tableValueOf(key) {
  for (const line of md) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    const cells = t.split('|').map((c) => c.trim());
    if (cells[1] && cells[1].toLowerCase().includes(key.toLowerCase())) return plain(cells[2]);
  }
  throw new Error(`table row not found: ${key}`);
}
for (const f of cfg?.fields || []) {
  if (typeof f.value !== 'string') {
    f.label = f.header || f.tableKey;
    f.value = f.tableKey ? tableValueOf(f.tableKey) : valueOf(f.header);
  }
  if (f.value.length > f.max) throw new Error(`${f.label} over limit: ${f.value.length}/${f.max}`);
}

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) { console.log(JSON.stringify({ error: 'NO_PAGE' })); process.exit(0); }

async function clickEl(loc) {
  await loc.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center' })); // allow-raw-playwright: center to dodge sticky-header interception
  await humanClickLocator(page, loc); // allow-raw-playwright: LSI click, no anti-bot
}

async function readDeclared(name, value, scope) {
  const locator = page.locator(`[name$="${name}"]`).first();
  await locator.waitFor({ state: 'visible' });
  const actual = await locator.inputValue();
  return `${scope} ${name}: ${actual === value ? 'zgodne' : `ROZBIEZNE (${actual.length} vs ${value.length})`}`;
}

// LSI2 drops an expired session onto /logowanie, where every field selector times out.
// Say that instead of reporting an empty section.
async function assertRendered(scope, selector) {
  try {
    await page.waitForSelector(selector, { state: 'attached', timeout: Number('45000') });
  } catch (error) {
    const url = page.url();
    if (url.includes('/logowanie')) {
      throw new Error(`${scope}: sesja LSI2 wygasla i przegladarka jest na ${url}; zaloguj sie ponownie w tym oknie i powtorz przebieg`);
    }
    throw new Error(`${scope}: strona nie wyrenderowala "${selector}" (${String(error?.message || error).slice(0, Number('80'))}); adres ${url}`);
  }
}

async function openRow(row) {
  await page.goto(collection.url, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');
  await assertRendered(collection.label, 'textarea, table, [role="row"]');
  const ROWS = 'table tbody tr, [role="row"], .MuiDataGrid-row, li[role="listitem"]';
  const seen = await page.evaluate(({ needle, rowSelector }) => {
    const norm = (v) => String(v || '').replace(/\s+/g, ' ').trim();
    const menuOf = (node) => node.querySelector('button[aria-label="overflow-options"], button[title="overflow-options"], [role="button"][aria-label*="overflow"], [aria-label*="overflow"]');
    const textOf = (node) => norm(Array.from(node.querySelectorAll('td, [role="cell"], [role="gridcell"]')).map((cell) => `${cell.getAttribute('title') || ''} ${cell.textContent || ''}`).join(' ') || node.textContent);
    const all = Array.from(document.querySelectorAll(rowSelector));
    const described = all.map((node) => ({ tag: node.tagName.toLowerCase(), menu: Boolean(menuOf(node)), text: textOf(node).slice(0, Number('110')) }));
    const rows = all.filter((node) => textOf(node).includes(norm(needle)));
    const inventory = {
      url: location.href,
      title: document.title,
      widok: norm(document.body ? document.body.innerText : '').slice(0, Number('160')),
      tables: document.querySelectorAll('table').length,
      tableRows: document.querySelectorAll('table tbody tr').length,
      roleRows: document.querySelectorAll('[role="row"]').length,
      overflowButtons: document.querySelectorAll('[aria-label*="overflow"]').length,
      textareas: document.querySelectorAll('textarea').length,
    };
    if (rows.length === Number('1')) {
      const menu = menuOf(rows[Number('0')]);
      if (menu) menu.setAttribute('data-weles-row-menu', 'open');
      return { count: Number('1'), menu: Boolean(menu), inventory, described };
    }
    return { count: rows.length, menu: false, inventory, described };
  }, { needle: row.rowNeedle, rowSelector: ROWS }); // allow-raw-playwright: locate the one row named by the plan and report what the page shows
  if (seen.count !== Number('1') || !seen.menu) {
    throw new Error(`${collection.label}: needle "${row.rowNeedle}" matched ${seen.count} rows, menu found: ${seen.menu}; stan strony ${JSON.stringify(seen.inventory)}; wiersze ${JSON.stringify(seen.described)}`);
  }
  const menuButton = page.locator('[data-weles-row-menu="open"]').first();
  await clickEl(menuButton);
  await menuButton.evaluate((el) => el.removeAttribute('data-weles-row-menu')); // allow-raw-playwright: drop the marker used for the humanized click
  const edit = page.getByRole('menuitem', { name: 'Edytuj', exact: true }).filter({ visible: true }).first();
  await edit.waitFor({ state: 'visible' });
  await clickEl(edit);
  await page.waitForSelector(`[name$="${row.matchField}"]`);
  await humanIdlePause('short');
}

async function nestedPrefix(nested) {
  const names = await page.locator(`[name$="${nested.matchFieldSuffix}"]`).evaluateAll(
    (els, needle) => els
      .filter((el) => String(el.value || '').replace(/\s+/g, ' ').trim().includes(needle))
      .map((el) => el.getAttribute('name')),
    nested.matchNeedle,
  ); // allow-raw-playwright: resolve the nested row prefix from its declared name field
  if (names.length !== Number('1')) throw new Error(`nested needle matched ${names.length} rows: ${nested.matchNeedle}`);
  return names[0].slice(0, -nested.matchFieldSuffix.length);
}

async function closeDrawer() {
  const cancel = page.getByRole('button', { name: 'Anuluj', exact: true }).filter({ visible: true });
  if (await cancel.count() > 0) {
    await clickEl(cancel.last());
    await humanIdlePause('long');
  }
}

if (collection) {
  const checks = [];
  for (const row of collection.rows || []) {
    await openRow(row);
    for (const f of row.fields || []) checks.push(await readDeclared(f.name, f.value, collection.label));
    if (row.nested) {
      const prefix = await nestedPrefix(row.nested);
      for (const f of row.nested.fields || []) checks.push(await readDeclared(`${prefix}${f.nameSuffix}`, f.value, collection.label));
    }
    await closeDrawer();
  }
  console.log(JSON.stringify({ collection: SECTION, url: page.url(), checks }, null, Number('2')));
  process.exit(0);
}

await page.goto(BASE + cfg.sectionId, { waitUntil: 'domcontentloaded' });
await humanIdlePause('long');
await assertRendered(SECTION, cfg.fields[0].sel);
await humanIdlePause('short');

if (MODE === 'read') {
  const checks = [];
  for (const f of cfg.fields) checks.push(await readDeclared(f.label, f.value, SECTION));
  console.log(JSON.stringify({ section: SECTION, url: page.url(), mode: MODE, checks }, null, Number('2')));
  process.exit(0);
}

const filled = [];
for (const f of cfg.fields) {
  await humanFill(page, page.locator(f.sel).first(), f.value); // allow-raw-playwright: LSI gov form, no anti-bot; instant fill
  await humanIdlePause('short');
  filled.push(`${f.label} (${f.value.length}/${f.max})`);
}

if (SECTION === '3.5') {
  const dateInput = page.locator('input[placeholder*="rrrr"], input[placeholder*="yyyy"]').first();
  if (await dateInput.count() > 0) {
    await humanFill(page, dateInput, '01.06.2026'); // allow-raw-playwright: prior-art search date from prepared content
    await humanIdlePause('short');
    filled.push('Data badania (01.06.2026)');
  }
  const radio = page.locator('input[type="radio"][value="konsorcjant"]').first();
  if (await radio.count() > 0) {
    await radio.dispatchEvent('click'); // allow-raw-playwright: applicant/consortium performed the search
    await humanIdlePause('short');
    filled.push('Badanie: konsorcjant');
  }
}

let saveResult = 'clicked';
try { await clickEl(page.locator('button:has-text("Zapisz")').first()); await humanIdlePause('long'); }
catch (e) { saveResult = `NOT SAVED: ${String(e?.message || e).slice(0, 70)}`; }

const readback = await page.evaluate((sels) => sels.map((s) => { const el = document.querySelector(s); return el ? (el.value || '').length : null; }), cfg.fields.map((f) => f.sel));

await page.reload({ waitUntil: 'domcontentloaded' });
await humanIdlePause('long');
await page.waitForSelector(cfg.fields[0].sel);
await humanIdlePause('short');
const persistedLengths = await page.evaluate((sels) => sels.map((s) => { const el = document.querySelector(s); return el ? (el.value || '').length : null; }), cfg.fields.map((f) => f.sel));
const persisted = cfg.fields.map((f, i) => `${f.label}: ${persistedLengths[i] === f.value.length ? 'persisted' : `NOT PERSISTED (${persistedLengths[i]} vs ${f.value.length})`}`);

console.log(JSON.stringify({ section: SECTION, url: page.url(), filled, saveResult, readbackLengths: readback, persisted }, null, Number('2')));
process.exit(0);
