// Filler for section 1.2 (Klasyfikacja projektu) of the NEW NCBR wniosek.
// Replicates the working Kimi reference (cdp_fill_1_2.py): autocomplete =
// click + fill(full value) + wait + click matching li; radios + option clicks
// via synthetic dispatchEvent to bypass sticky-header interception.
// Never closes the page.

import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { humanIdlePause } from '../../../../dist/human/mouse.js';

const endpoint = process.env.NCBR_CDP_ENDPOINT || 'http://127.0.0.1:9223';
const SECTION_URL = 'https://lsi2.ncbr.gov.pl/projekt/7ee80d9a-67dd-4d99-becd-8dda407221c1/projekt_step/0ca77e3d-373e-464f-9e9d-a35f5193864d';
const MD = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/backends/STEP_sciezka_A_Wisent/wersja_B_1_2_klasyfikacja.md';
const NB = 'MODUL_DANE_PAKIETU.czesc_ogolna.klasyfikacja_projektu.';

const md = readFileSync(MD, 'utf8').split('\n');
const isHeader = (l) => /^\*\*.+\*\*\s*$/.test(l.trim());
function valueOf(key) {
  let start = -1;
  for (let i = 0; i < md.length; i++) { if (isHeader(md[i]) && md[i].toLowerCase().includes(key.toLowerCase())) { start = i; break; } }
  if (start < 0) throw new Error(`header not found: ${key}`);
  let end = md.length;
  for (let i = start + 1; i < md.length; i++) { if (isHeader(md[i])) { end = i; break; } }
  return md.slice(start + 1, end).join('\n').replace(/\s*<!--[\s\S]*?-->\s*/g, ' ').trim();
}

// Char limits mirror live LSI maxlength config.
const texts = [
  { sel: `textarea[name="${NB}nazwa_technologii"]`, key: 'Nazwa technologii', max: 200 },
  { sel: `textarea[name="${NB}produkt_koncowy_technologii_krytycznej"]`, key: 'Produkt końcowy technologii krytycznej', max: 500 },
  { sel: `textarea[name="${NB}uzasadnienie_wybranej_technologii"]`, key: 'Uzasadnienie wybranej technologii', max: 6000 },
  { sel: `textarea[name="${NB}uzasadnienie_do_pkd"]`, key: 'Uzasadnienie (limit 4 000', max: 4000 },
];
for (const t of texts) { t.value = valueOf(t.key); if (t.value.length > t.max) throw new Error(`${t.key} too long`); }

// search = comma-free prefix that filters the LSI dictionary to one option;
// value = the exact option text clicked.
const autocompletes = [
  { name: 'obszar_technologii', search: 'Technologie sztucznej', value: 'Technologie sztucznej inteligencji' },
  { name: 'technologia_danego_obszaru', search: 'algorytmy sztucznej', value: 'algorytmy sztucznej inteligencji' },
  { name: 'zakres_interwencji', search: 'Działania badawcze i innowacyjne w MŚP', value: 'Działania badawcze i innowacyjne w MŚP, w tym tworzenie sieci kontaktów' },
  { name: 'rodzaj_dzialnosci_gospodarczej', search: 'Działalność informacyjno-komunikacyjna', value: 'Działalność informacyjno-komunikacyjna, w tym telekomunikacja' },
  { name: 'kis', search: 'KIS 10. TECHNOLOGIE INFORMACYJNE', value: 'KIS 10. TECHNOLOGIE INFORMACYJNE, KOMUNIKACYJNE ORAZ GEOINFORMACYJNE' },
  { name: 'obszar_kis', search: 'VII. ROZWÓJ SZTUCZNEJ', value: 'VII. ROZWÓJ SZTUCZNEJ INTELIGENCJI' },
  { name: 'pkd_2025', search: '62.10.B', value: '62.10.B Pozostała działalność w zakresie programowania' },
];
const slowa = ['AI', 'ALGORYTMY AI', 'SI (SZTUCZNA INTELIGENCJA)', 'SYSTEM SAMOUCZĄCY SIĘ/SZTUCZNA INTELIGENCJA'];
const radios = ['rozwoj_technologii_krytycznej', 'produkt_koncowy', 'pkd_2025'];

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) { console.log(JSON.stringify({ error: 'NO_PAGE' })); process.exit(0); }

async function pickOption(name, search, value) {
  const loc = page.locator(`input[name="${NB}${name}"]`).first();
  await loc.click(); // allow-raw-playwright: open combobox
  await loc.fill(search); // allow-raw-playwright: comma-free prefix triggers LSI dictionary filter
  await humanIdlePause('deliberate');
  const opt = page.getByRole('option', { name: value, exact: true }).first();
  if (await opt.count() === 0) throw new Error(`option not found: ${name} -> ${value}`);
  await opt.dispatchEvent('click'); // allow-raw-playwright: synthetic click bypasses sticky-header interception
  await humanIdlePause('short');
}

await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
await humanIdlePause('long');
await page.waitForSelector(`textarea[name="${NB}nazwa_technologii"]`);
await humanIdlePause('short');

const log = { radios: [], autocompletes: {}, slowa: [], texts: [] };

for (const r of radios) {
  await page.locator(`input[type="radio"][value="${r}"]`).first().dispatchEvent('click'); // allow-raw-playwright: Kimi radio method
  await humanIdlePause('short');
  log.radios.push(r);
}

for (const a of autocompletes) {
  try { await pickOption(a.name, a.search, a.value); log.autocompletes[a.name] = 'ok'; }
  catch (e) { log.autocompletes[a.name] = String(e?.message || e).slice(0, 80); }
}

const kw = page.locator(`input[name="${NB}slowa_kluczowe"]`).first();
await kw.click(); // allow-raw-playwright: open multi-select once
for (const s of slowa) {
  await kw.fill(s); // allow-raw-playwright: keyword search
  await humanIdlePause('deliberate');
  const opt = page.getByRole('option', { name: s, exact: true }).first();
  if (await opt.count() > 0) { await opt.dispatchEvent('click'); log.slowa.push(s); } // allow-raw-playwright: add keyword tag
  else log.slowa.push(`MISS:${s}`);
  await humanIdlePause('short');
}

for (const t of texts) {
  await page.locator(t.sel).first().fill(t.value); // allow-raw-playwright: LSI gov form, no anti-bot; instant fill
  await humanIdlePause('short');
  log.texts.push(`${t.key} (${t.value.length})`);
}

let saveResult = 'clicked';
try { await page.locator('button:has-text("Zapisz")').first().click(); await humanIdlePause('long'); } // allow-raw-playwright: save via UI
catch (e) { saveResult = `NOT SAVED: ${String(e?.message || e).slice(0, 70)}`; }

const readback = await page.evaluate((nb) => {
  const cv = (n) => { const el = document.querySelector(`input[name="${nb}${n}"]`); return el ? el.value : null; };
  const tl = (n) => { const el = document.querySelector(`textarea[name="${nb}${n}"]`); return el ? (el.value || '').length : null; };
  return {
    nazwaLen: tl('nazwa_technologii'), uzasadTechLen: tl('uzasadnienie_wybranej_technologii'),
    obszarTech: cv('obszar_technologii'), zakres: cv('zakres_interwencji'), rodzaj: cv('rodzaj_dzialnosci_gospodarczej'),
    kis: cv('kis'), obszarKis: cv('obszar_kis'), pkd: cv('pkd_2025'), technologia: cv('technologia_danego_obszaru'),
    slowaChips: (() => { const i = document.querySelector("input[name$='slowa_kluczowe']"); const r = i && i.closest('.MuiAutocomplete-root'); return r ? Array.from(r.querySelectorAll('.MuiChip-label')).map((c) => c.textContent.trim()) : []; })(),
    checkedRadios: Array.from(document.querySelectorAll('.MuiRadio-root.Mui-checked input[type="radio"]')).map((r) => r.value),
  };
}, NB);

console.log(JSON.stringify({ saveResult, autocompletes: log.autocompletes, slowaPicked: log.slowa, readback }, null, 2));
process.exit(0);
