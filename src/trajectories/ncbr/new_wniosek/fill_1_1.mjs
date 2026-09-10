// Section 1.1 filler for fresh STEP B draft. UI-only, never submits.

import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';
import { humanFill } from '../../../../dist/human/keyboard.js';

const endpoint = process.env.NCBR_CDP_ENDPOINT || 'http://127.0.0.1:9223';
const PROJECT_ID = process.env.NCBR_PROJECT_ID || '7ee80d9a-67dd-4d99-becd-8dda407221c1';
const SECTION_URL = `https://lsi2.ncbr.gov.pl/projekt/${PROJECT_ID}/projekt_step/71acd162-e35d-4aff-88a6-ea2fe179a259`;
const MD = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/backends/STEP_sciezka_A_Wisent/wersja_B_1_1_informacje_ogolne.md';
const NB = 'MODUL_DANE_PAKIETU.czesc_ogolna.informacje_ogolne_o_projekcie.';

const md = readFileSync(MD, 'utf8');
function afterHeader(header, nextHeader) {
  let part = md.split(header)[1];
  if (part === undefined) throw new Error(`missing header: ${header}`);
  if (nextHeader) part = part.split(nextHeader)[0];
  return part.replace(/\s*<!--[\s\S]*?-->\s*/g, ' ').trim();
}

const title = 'Duże modele językowe oparte na reprezentacjach jako nowa europejska architektura AI z wbudowaną audytowalnością, sterowaniem i zgodnością z AI Act';
let summary = afterHeader('## Streszczenie projektu', '## Wniosek dotyczący projektu składany jest ponownie');
summary = summary.replace(/^\s*\([^)]*limit[^)]*\)\s*/i, '');
summary = summary.replace(/^\*\*Streszczenie projektu.*?\*\*\s*/s, '').trim();
if (summary.length > 4000) summary = summary.slice(0, 4000).replace(/\s+\S*$/, '');
if (title.length > 150) throw new Error(`title too long: ${title.length}/150`);

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) { console.log(JSON.stringify({ error: 'NO_PAGE' }, null, 2)); process.exit(1); }

await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
await humanIdlePause('long');
await page.waitForSelector(`textarea[name="${NB}tytul_projektu"]`);

await page.locator('input[type="radio"][value="samodzielnie"]').first().dispatchEvent('click'); // allow-raw-playwright: select single applicant mode
await humanIdlePause('short');
await humanFill(page, page.locator(`textarea[name="${NB}tytul_projektu"]`).first(), title);
await humanIdlePause('short');
await humanFill(page, page.locator(`input[name="${NB}data_rozpoczecia_realizacji_projektu"]`).first(), '01.09.2026');
await humanIdlePause('short');
await humanFill(page, page.locator(`input[name="${NB}data_zakonczenia_realizacji_projektu"]`).first(), '31.08.2029');
await humanIdlePause('short');
await humanFill(page, page.locator(`textarea[name="${NB}streszczenie_projektu"]`).first(), summary);
await humanIdlePause('short');
await page.locator('input[type="radio"][value="Nie"]').last().dispatchEvent('click'); // allow-raw-playwright: resubmission answer
await humanIdlePause('deliberate');

let saveResult = 'saved';
try {
  const saves = page.getByRole('button', { name: 'Zapisz', exact: true }).filter({ visible: true });
  const count = await saves.count();
  if (!count) throw new Error('no enabled Zapisz');
  await humanClickLocator(page, saves.nth(count - 1));
  await humanIdlePause('long');
} catch (e) {
  saveResult = `NOT SAVED: ${String(e?.message || e).slice(0, 80)}`;
}

const readback = await page.evaluate((nb) => ({
  titleLen: document.querySelector(`textarea[name="${nb}tytul_projektu"]`)?.value.length ?? null,
  summaryLen: document.querySelector(`textarea[name="${nb}streszczenie_projektu"]`)?.value.length ?? null,
  start: document.querySelector(`input[name="${nb}data_rozpoczecia_realizacji_projektu"]`)?.value ?? null,
  end: document.querySelector(`input[name="${nb}data_zakonczenia_realizacji_projektu"]`)?.value ?? null,
  checked: Array.from(document.querySelectorAll('.MuiRadio-root.Mui-checked input[type="radio"]')).map((r) => r.value),
}), NB); // allow-raw-playwright: read back 1.1 fields

console.log(JSON.stringify({ saveResult, readback }, null, 2));
process.exit(0);
