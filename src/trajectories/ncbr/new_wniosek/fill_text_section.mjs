// Generic free-text section filler for the NEW NCBR wniosek (project 7ee80d9a).
// SECTION env selects a registry entry. Raw CDP fill (LSI has no anti-bot).
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
const cfg = REGISTRY[SECTION];
if (!cfg) throw new Error(`no registry entry for SECTION=${SECTION}`);

const md = readFileSync(SRC + cfg.md, 'utf8').split('\n');
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
for (const f of cfg.fields) {
  f.label = f.header || f.tableKey;
  f.value = f.tableKey ? tableValueOf(f.tableKey) : valueOf(f.header);
  if (f.value.length > f.max) throw new Error(`${f.label} over limit: ${f.value.length}/${f.max}`);
}

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) { console.log(JSON.stringify({ error: 'NO_PAGE' })); process.exit(0); }

async function clickEl(loc) {
  await loc.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center' })); // allow-raw-playwright: center to dodge sticky-header interception
  await humanClickLocator(page, loc); // allow-raw-playwright: LSI click, no anti-bot
}

await page.goto(BASE + cfg.sectionId, { waitUntil: 'domcontentloaded' });
await humanIdlePause('long');
await page.waitForSelector(cfg.fields[0].sel);
await humanIdlePause('short');

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

console.log(JSON.stringify({ section: SECTION, url: page.url(), filled, saveResult, readbackLengths: readback }, null, 2));
process.exit(0);
