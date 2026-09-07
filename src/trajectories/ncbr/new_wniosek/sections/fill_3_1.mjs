// Section 3.1 (Sposob wdrozenia) collection row for the replacement draft.
// Data is parsed from wersja_B_3.1_3.2_3.3_3.4_wdrozenie.md. Never submits.

import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { humanClickLocator, humanIdlePause } from '../../../../../dist/human/mouse.js';
import { humanFill } from '../../../../../dist/human/keyboard.js';

const endpoint = process.env.NCBR_CDP_ENDPOINT || 'http://127.0.0.1:9223';
const SECTION_URL = 'https://lsi2.ncbr.gov.pl/projekt/7ee80d9a-67dd-4d99-becd-8dda407221c1/projekt_step/574f07ed-d631-4536-bfd0-e1f7e469415c';
const MD = readFileSync('/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/backends/STEP_sciezka_A_Wisent/wersja_B_3.1_3.2_3.3_3.4_wdrozenie.md', 'utf8');

const clean = (s) => s.replace(/\s*<!--[\s\S]*?-->\s*/g, ' ').trim();
function between(start, end) {
  const a = MD.split(start);
  if (a.length < 2) throw new Error(`marker not found: ${start}`);
  let rest = a[1];
  if (end) rest = rest.split(end)[0];
  return clean(rest);
}
let UZAS = between('**Uzasadnienie (limit 3 000 znaków)**', '---\n\n## 3.2.');
if (UZAS.length > 3000) UZAS = UZAS.slice(0, 3000).replace(/\s+\S*$/, '');

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) { console.log(JSON.stringify({ error: 'NO_PAGE' })); process.exit(0); }
page.setDefaultTimeout(12000);

await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
await humanIdlePause('long');
await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll('div')).find((d) => (d.innerText || '').includes('pliki cookies'));
  if (b) b.style.pointerEvents = 'none';
}); // allow-raw-playwright: neutralise cookie banner

async function clickDodaj() {
  const button = page.getByRole('button', { name: 'Dodaj', exact: true }).filter({ visible: true }).first();
  if (await button.count() === 0) throw new Error('Dodaj not found');
  await humanClickLocator(page, button);
  await humanIdlePause('long');
}

async function setApplicant() {
  const applicant = page.locator('input[name*="nazwa_skrocona_wnioskodawcy"]')
    .locator('xpath=ancestor::*[contains(@class, "MuiInputBase-root")][1]')
    .locator('.MuiSelect-select, [role="combobox"]').first();
  if (await applicant.count() > 0) await humanClickLocator(page, applicant);
  await humanIdlePause('deliberate');
  const opt = page.getByRole('option', { name: 'Wisent Polska', exact: true }).first();
  if (await opt.count() > 0) await opt.dispatchEvent('click'); // allow-raw-playwright: select applicant
  await humanIdlePause('short');
}

async function multiPick(suffix, searches) {
  const picked = [];
  for (const search of searches) {
    const inp = page.locator(`input[name$="${suffix}"]`).first();
    await humanClickLocator(page, inp);
    await humanFill(page, inp, search);
    await humanIdlePause('deliberate');
    const opt = page.locator("[role='listbox'] [role='option'], [role='option']").first();
    if (await opt.count() === 0) throw new Error(`no option for ${suffix}: ${search}`);
    picked.push((await opt.textContent())?.trim());
    await opt.dispatchEvent('click'); // allow-raw-playwright: select dictionary option
    await humanIdlePause('short');
  }
  return picked;
}

async function saveEnabled() {
  await humanIdlePause('deliberate');
  await humanIdlePause('deliberate');
  const saves = page.getByRole('button', { name: 'Zapisz', exact: true }).filter({ visible: true });
  if (await saves.count() === 0) throw new Error('no enabled Zapisz');
  await humanClickLocator(page, saves.last());
  await humanIdlePause('long');
}

if (process.env.DIAG) {
  await clickDodaj();
  const fields = await page.evaluate(() => Array.from(document.querySelectorAll('input, textarea')).map((el) => ({
    tag: el.tagName,
    name: el.name || null,
    role: el.getAttribute('role'),
    type: el.getAttribute('type'),
    value: (el.value || '').slice(0, 80),
    max: el.getAttribute('maxlength'),
  })).filter((f) => f.name));
  console.log(JSON.stringify({ fields }, null, 2));
  process.exit(0);
}

if (!(await page.evaluate(() => (document.body.innerText || '').includes('Wprowadzenie wyników do własnej działalności gospodarczej')))) {
  await clickDodaj();
  try { await setApplicant(); } catch (e) { /* single applicant may be auto-selected */ }
  const sposob = await multiPick('sposob_wdrozenia_wynikow_prac_br', ['Wprowadzenie wyników do własnej', 'Udzielenie licencji']);
  const miejsce = await multiPick('miejsce_wdrozenia_wynikow_projektu', ['na terenie RP', 'na terenie innego']);
  await humanFill(page, page.locator('input[name$="przewidywana_data_wdrozenia"]').first(), '09.2029');
  await humanIdlePause('short');
  await humanFill(page, page.locator('textarea[name$="uzasadnienie"]').first(), UZAS);
  await saveEnabled();
  console.log(JSON.stringify({ saveResult: 'saved', sposob, miejsce, uzasLen: UZAS.length }, null, 2));
} else {
  console.log(JSON.stringify({ saveResult: 'already-present' }, null, 2));
}
process.exit(0);
