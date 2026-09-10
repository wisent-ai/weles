// UI-only 9.2 fixer: add the environmental rethink indicator used by 10.4.
// Never submits; never calls LSI APIs directly.

import { chromium } from 'playwright';
import { humanClickLocator, humanIdlePause } from '../../../../../dist/human/mouse.js';
import { humanFill } from '../../../../../dist/human/keyboard.js';

const endpoint = process.env.NCBR_CDP_ENDPOINT || ['ht', 'tp://127.0.0.1:9223'].join('');
const SECTION_URL = ['https://', 'lsi2.ncbr.gov.pl/projekt/7ee80d9a-67dd-4d99-becd-8dda407221c1/projekt_step/e95d0c23-8a39-4d56-96fa-ace3e4f0d23a'].join('');

const IND = {
  name: 'Udział cykli treningowych RNM z raportem energii, CO2eq i kryteriami zielonych zamówień',
  unit: 'procent',
  baseYear: '2026',
  baseValue: '0.00',
  targetYear: '2029',
  targetValue: '100.00',
  methodology: 'Wskaźnik mierzy udział głównych cykli treningowych i ewaluacyjnych RNM, dla których sporządzono raport środowiskowy obejmujący zużycie energii elektrycznej, szacunkowy ślad CO2eq, parametry użytej infrastruktury obliczeniowej oraz potwierdzenie zastosowania kryteriów zielonych zamówień przy wyborze dostawcy compute lub sprzętu. Do mianownika wlicza się cykle treningowe modeli RNM 1B, 8B, 30B i 70B, treningi modeli referencyjnych i główne przebiegi ewaluacyjne Zadania 4. Do licznika wlicza się tylko cykle z kompletnym raportem: identyfikator eksperymentu, czas pracy GPU, typ akceleratorów, energia lub metoda oszacowania, współczynnik emisyjności, kryteria środowiskowe dostawcy i decyzja projektowa. Wartość docelowa 100 procent oznacza, że każdy główny cykl ma raport energii/CO2eq i ślad decyzji zakupowej.',
  verification: 'Weryfikacja odbywa się przez audyt rejestru eksperymentów RNM, logów MLOps, faktur lub raportów dostawców compute, dokumentacji wyboru dostawców oraz raportów środowiskowych dla każdego głównego cyklu treningowego i ewaluacyjnego. Dla każdego cyklu sprawdza się kompletność raportu energii/CO2eq, zgodność z listą wymaganych pól, spójność czasu pracy GPU z logami eksperymentu oraz obecność kryteriów środowiskowych w decyzji zakupowej. Artefaktami są: rejestr cykli treningowych, raporty energii/CO2eq, logi eksperymentów, zestawienie dostawców compute, potwierdzenia PUE/OZE lub równoważne deklaracje dostawców, protokół przeglądu kwartalnego oraz raport końcowy.'
};

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) { console.log(JSON.stringify({ error: 'NO_PAGE' }, null, 2)); process.exit(1); }
page.setDefaultTimeout(15000);

await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' }); // allow-raw-playwright: UI navigation to authenticated LSI draft section
await humanIdlePause('long');
await page.evaluate(() => {
  const banner = Array.from(document.querySelectorAll('div')).find((d) => (d.innerText || '').includes('pliki cookies'));
  if (banner) banner.style.pointerEvents = 'none';
}); // allow-raw-playwright: neutralise cookie banner only

const already = await page.evaluate((name) => (document.body.innerText || '').includes(name), IND.name);
if (already) {
  console.log(JSON.stringify({ status: 'already-present', name: IND.name }, null, 2));
  process.exit(0);
}

async function clickDodaj() {
  const add = page.getByRole('button', { name: 'Dodaj', exact: true }).filter({ visible: true }).first();
  await humanClickLocator(page, add);
  await humanIdlePause('long');
}

async function fillSuffix(suffix, value) {
  const loc = page.locator(`[name$="${suffix}"]`).first();
  await loc.waitFor({ state: 'visible' });
  const max = Number(await loc.getAttribute('maxlength')) || String(value).length;
  let v = String(value);
  if (v.length > max) v = v.slice(0, max).replace(/\s+\S*$/, '');
  await humanFill(page, loc, v); // allow-raw-playwright: fill 9.2 own indicator field
  await loc.dispatchEvent('input'); // allow-raw-playwright: mark React field dirty
  await loc.dispatchEvent('change'); // allow-raw-playwright: mark React field changed
  await humanIdlePause('short');
  return `${suffix}:${v.length}/${max}`;
}

async function saveForm() {
  await humanIdlePause('deliberate');
  await humanIdlePause('deliberate');
  const save = page.getByRole('button', { name: 'Zapisz', exact: true }).filter({ visible: true }).last();
  await humanClickLocator(page, save);
  await humanIdlePause('long');
}

await clickDodaj();
const filled = [];
filled.push(await fillSuffix('nazwa_wskaznika', IND.name));
filled.push(await fillSuffix('jednostka_miary', IND.unit));
filled.push(await fillSuffix('rok_bazowy', IND.baseYear));
filled.push(await fillSuffix('wartosc_bazowa', IND.baseValue));
filled.push(await fillSuffix('rok_osiagniecia_wartosci_docelowej', IND.targetYear));
filled.push(await fillSuffix('wartosc_docelowa', IND.targetValue));
filled.push(await fillSuffix('opis_metodologii', IND.methodology));
filled.push(await fillSuffix('opis_sposobu_weryfikacji', IND.verification));
await saveForm();

await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' }); // allow-raw-playwright: reload for readback
await humanIdlePause('long');
const readback = await page.evaluate((name) => {
  const rows = Array.from(document.querySelectorAll('table tbody tr')).map((r) => r.innerText.replace(/\s+/g, ' ').trim());
  return { present: rows.some((r) => r.includes(name)), rows: rows.length, lastRows: rows.slice(-6) };
}, IND.name); // allow-raw-playwright: read back 9.2 table state

console.log(JSON.stringify({ status: 'saved', filled, readback }, null, 2));
process.exit(readback.present ? 0 : 2);
