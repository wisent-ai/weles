// Repairs section 2.2 missing collections and clears the chain-value field. UI-only.
// Never submits and never closes the page.

import { chromium } from 'playwright';
import { humanClickLocator, humanIdlePause } from '../../../../../../dist/human/mouse.js';
import { humanFill } from '../../../../../../dist/human/keyboard.js';
import { FACTORS, FEATURES } from './fix_2_2_collections/source.mjs';
import { collectionsForm } from './fix_2_2_collections/form.mjs';
import { runDiagnostics } from './fix_2_2_collections/diagnostics.mjs';

const endpoint = process.env.NCBR_CDP_ENDPOINT || 'http://127.0.0.1:9223';
const SECTION_URL = 'https://lsi2.ncbr.gov.pl/projekt/7ee80d9a-67dd-4d99-becd-8dda407221c1/projekt_step/80ebca16-a9dd-4798-a334-5ac007cecbf7';
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

const { clickDodaj, saveForm, fillByName, setAutoByName, pickFactors } = collectionsForm({ page });
await runDiagnostics({ page, clickDodaj, pickFactors });

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
  await humanFill(page, pow, '');
  await humanIdlePause('short');
  const saves = page.getByRole('button', { name: 'Zapisz', exact: true }).filter({ visible: true });
  if (await saves.count() === 0) throw new Error('no enabled main Zapisz');
  await humanClickLocator(page, saves.last());
  await humanIdlePause('long');
  done.push({ field: 'powiazanie_lancuch_wartosci', value: '' });
}

const readback = await page.evaluate(() => ({
  tables: Array.from(document.querySelectorAll('table')).map((t) => ({ rows: t.querySelectorAll('tbody tr').length, text: t.innerText.replace(/\s+/g, ' ').slice(0, 350) })),
  powLen: document.querySelector('textarea[name$="innowacja_produktowa_powiazanie_rezultatu_prac_br_z_lancuchem_wartosci"]')?.value.length ?? null,
}));
console.log(JSON.stringify({ done, readback }, null, 2));
process.exit(0);
