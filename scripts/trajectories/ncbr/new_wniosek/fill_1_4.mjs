// Section 1.4 (Konkurencja) of the NEW NCBR wniosek — 5 competitor rows.
// Data from the working Kimi reference save_1_4_collection.py. Never closes page.

import { chromium } from 'playwright';
import { humanIdlePause } from '../../../../dist/human/mouse.js';

const endpoint = process.env.NCBR_CDP_ENDPOINT || 'http://127.0.0.1:9223';
const SECTION_URL = 'https://lsi2.ncbr.gov.pl/projekt/7ee80d9a-67dd-4d99-becd-8dda407221c1/projekt_step/4a6e9d5d-10e7-4436-8fd8-728a8e8b8ddc';

const ROWS = [
  { nazwa: 'Synerise S.A.', nip: '6793093292', opis: 'Synerise S.A. jest polskim konkurentem w obszarze zastosowań sztucznej inteligencji dla przedsiębiorstw, w szczególności analizy danych behawioralnych, personalizacji, predykcji zachowań użytkowników i automatyzacji decyzji biznesowych. Firma rozwija platformę AI przetwarzającą sygnały behawioralne w czasie rzeczywistym oraz rozwiązania oparte na modelach predykcyjnych i rekomendacyjnych. Konkurencja wobec Wisent dotyczy rynku europejskich odbiorców technologii AI dla biznesu oraz pozycji krajowego dostawcy zaawansowanego oprogramowania AI. Różnica polega na tym, że Synerise koncentruje się na warstwie zastosowań biznesowych i danych behawioralnych, natomiast projekt Wisent dotyczy bazowej architektury modeli generatywnych RNM, w której sterowalność i audytowalność wynikają z konstrukcji reprezentacji wewnętrznych modelu.' },
  { nazwa: 'Mistral AI', nip: '0000000000', opis: 'Mistral AI jest europejskim konkurentem w obszarze dużych modeli językowych, modeli otwartych wag i rozwiązań AI dla przedsiębiorstw. Firma rozwija klasyczne modele transformerowe oraz narzędzia wdrażania modeli i agentów AI, konkurując o tych samych europejskich odbiorców technologii generatywnej. Przewagą Mistral jest skala finansowania, rozpoznawalność i istniejąca dystrybucja rynkowa. Przewaga Wisent polega na innym poziomie innowacji: RNM nie są kolejnym transformerem, lecz architekturą projektowaną tak, aby kompetencje, zachowania i polityki bezpieczeństwa były zapisane jako stabilne reprezentacje możliwe do diagnozy i sterowania. Wisent oferuje możliwość modyfikacji zachowania modelu bez ponownego trenowania całej architektury, większą audytowalność i lepsze dopasowanie do wymogów regulowanych sektorów UE.' },
  { nazwa: 'Goodfire AI', nip: '0000000000', opis: 'Goodfire AI jest jednym z najbliższych konkurentów technologicznych Wisent. Działa w obszarze interpretowalności i inżynierii reprezentacji modeli AI, rozwijając narzędzia pozwalające rozumieć i projektować zachowanie zaawansowanych modeli przez analizę ich reprezentacji wewnętrznych. Konkurencja dotyczy warstwy kontroli, diagnostyki i bezpieczeństwa modeli. Przewagą Goodfire jest silne pozycjonowanie w interpretowalności i koncentracja na narzędziach dla zaawansowanych systemów AI. Przewaga Wisent polega na tym, że projekt RNM nie ogranicza się do analizy lub sterowania istniejącymi modelami po treningu, lecz rozwija architekturę, w której reprezentacje są stabilizowane i separowane już w czasie treningu. Audytowalność i możliwość modyfikacji zachowania modelu stają się cechą modelu, nie wyłącznie zewnętrznym narzędziem diagnostycznym.' },
  { nazwa: 'Anthropic', nip: '0000000000', opis: 'Anthropic jest jednym z głównych konkurentów Wisent w segmencie bezpiecznych modeli generatywnych dla przedsiębiorstw. Firma rozwija rodzinę modeli Claude i pozycjonuje się jako podmiot budujący niezawodne oraz sterowalne systemy AI. Podejście Constitutional AI kształtuje zachowanie modelu przez zestaw zasad używanych w procesie treningu i dostrajania, co stanowi konkurencyjne rozwiązanie wobec potrzeby kontroli zachowania modeli. Przewagą Anthropic jest marka, jakość modeli i zaufanie klientów enterprise. Przewaga Wisent polega na kontroli na poziomie geometrii reprezentacji wewnętrznych, nie wyłącznie przez reguły, polityki lub zamknięty proces dostawcy.' },
  { nazwa: 'Gray Swan AI', nip: '0000000000', opis: 'Gray Swan AI jest konkurentem Wisent w obszarze bezpieczeństwa, red-teamingu oraz ewaluacji modeli sztucznej inteligencji. Firma rozwija platformę do adversarial evaluation, testowania podatności modeli i agentów AI oraz ochrony wdrożeń produkcyjnych przed atakami takimi jak jailbreaki, prompt injection czy niepożądane wyjścia modelu. Rozwiązania kieruje do laboratoriów frontier AI i przedsiębiorstw wdrażających systemy AI w środowiskach o wysokich wymaganiach bezpieczeństwa. Przewagą Gray Swan jest pozycja w testowaniu bezpieczeństwa i ochronie runtime. Przewaga Wisent polega na przesunięciu kontroli głębiej, z warstwy zewnętrznego testowania i filtrowania na poziom samej architektury modelu.' },
];

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) { console.log(JSON.stringify({ error: 'NO_PAGE' })); process.exit(0); }

async function clickDodaj(nth) {
  await page.evaluate((n) => {
    const btns = Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Dodaj');
    if (!btns[n]) throw new Error(`Dodaj #${n} not found`);
    btns[n].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); // allow-raw-playwright: synthetic Dodaj click (Kimi reference)
  }, nth);
  await humanIdlePause('long');
}
async function saveForm() {
  await page.evaluate(() => {
    const s = Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Zapisz' && !b.disabled);
    if (!s.length) throw new Error('no enabled Zapisz');
    s[s.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); // allow-raw-playwright: synthetic save (Kimi reference)
  });
  await humanIdlePause('long');
  await humanIdlePause('deliberate');
}

async function editDataRow(index) {
  await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');
  const row = page.locator('table tbody tr').nth(index + 1);
  await row.locator('button[aria-label="overflow-options"]').first().dispatchEvent('click'); // allow-raw-playwright: open row action menu
  await humanIdlePause('deliberate');
  await page.getByRole('menuitem', { name: 'Edytuj', exact: true }).first().dispatchEvent('click'); // allow-raw-playwright: edit competitor row
  await humanIdlePause('long');
  await page.waitForSelector("[name='nazwa_podmiotu_konkurencyjnego']");
}

await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
await humanIdlePause('long');
await page.evaluate(() => { const b = Array.from(document.querySelectorAll('div')).find((d) => (d.innerText || '').includes('pliki cookies')); if (b) b.style.pointerEvents = 'none'; }); // allow-raw-playwright: neutralise cookie banner (Kimi reference)

async function setApplicant() {
  await page.evaluate((nm) => {
    const inp = document.querySelector(`input[name="${nm}"]`);
    const sel = inp && inp.closest('.MuiInputBase-root')?.querySelector('.MuiSelect-select, [role="combobox"]');
    if (sel) { for (const t of ['mousedown', 'mouseup', 'click']) sel.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })); } // allow-raw-playwright: open applicant MUI select
  }, 'nazwa_skrocona_wnioskodawcy_samodzielnego_lidera_konsorcjum_konsorcjanta');
  await humanIdlePause('deliberate');
  const opt = page.getByRole('option', { name: 'Wisent Polska', exact: true }).first();
  await opt.waitFor({ state: 'visible' });
  await opt.click({ force: true }); // allow-raw-playwright: select Wisent applicant
  await humanIdlePause('short');
}

if (process.env.DIAG) {
  await clickDodaj(0);
  await page.waitForSelector("[name='nazwa_podmiotu_konkurencyjnego']");
  await setApplicant();
  await page.locator("[name='nazwa_podmiotu_konkurencyjnego']").first().fill('TEST'); // allow-raw-playwright: diag
  await page.locator("[name='nip']").first().fill('0000000000'); // allow-raw-playwright: diag
  await page.locator("[name='opis']").first().fill('opis testowy diag'); // allow-raw-playwright: diag
  await humanIdlePause('deliberate');
  const state = await page.evaluate(() => {
    const inp = document.querySelector("input[name='nazwa_skrocona_wnioskodawcy_samodzielnego_lidera_konsorcjum_konsorcjanta']");
    const sel = inp && inp.closest('.MuiInputBase-root')?.querySelector('.MuiSelect-select');
    const applText = sel ? sel.textContent.trim() : null;
    const zapisz = Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Zapisz');
    const empties = Array.from(document.querySelectorAll('[aria-invalid="true"], .Mui-error')).map((e) => (e.getAttribute('name') || e.textContent || '').trim().slice(0, 50)).slice(0, 15);
    return { applText, zapiszDisabled: zapisz.map((b) => b.disabled), errors: empties };
  });
  console.log(JSON.stringify(state, null, 2));
  process.exit(0);
}

if (process.env.REPAIR) {
  const repaired = [];
  for (let i = 0; i < ROWS.length; i++) {
    const rowCount = await page.evaluate(() => {
      const table = document.querySelector('table');
      return table ? table.querySelectorAll('tbody tr').length - 1 : 0;
    });
    if (i >= rowCount) break;
    const r = ROWS[i];
    await editDataRow(i);
    try { await setApplicant(); } catch (e) { /* applicant may already be bound */ }
    await page.locator("[name='nazwa_podmiotu_konkurencyjnego']").first().fill(r.nazwa); // allow-raw-playwright: repair text
    await page.locator("[name='nip']").first().fill(r.nip); // allow-raw-playwright: repair text
    await page.locator("[name='opis']").first().fill(r.opis); // allow-raw-playwright: repair text
    await humanIdlePause('deliberate');
    await humanIdlePause('deliberate');
    await saveForm();
    repaired.push(r.nazwa);
  }
  await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');
  const hasGray = await page.evaluate(() => (document.body.innerText || '').includes('Gray Swan AI'));
  if (!hasGray) {
    const r = ROWS[4];
    await clickDodaj(0);
    await page.waitForSelector("[name='nazwa_podmiotu_konkurencyjnego']");
    try { await setApplicant(); } catch (e) { /* applicant may auto bind */ }
    await page.locator("[name='nazwa_podmiotu_konkurencyjnego']").first().fill(r.nazwa); // allow-raw-playwright: add missing competitor
    await page.locator("[name='nip']").first().fill(r.nip); // allow-raw-playwright: add missing competitor
    await page.locator("[name='opis']").first().fill(r.opis); // allow-raw-playwright: add missing competitor
    await humanIdlePause('deliberate');
    await humanIdlePause('deliberate');
    await saveForm();
    repaired.push(r.nazwa);
  }
  const readback = await page.evaluate(() => {
    const tbl = document.querySelector('table');
    return {
      rows: tbl ? tbl.querySelectorAll('tbody tr').length : -1,
      text: (tbl?.innerText || '').replace(/\s+/g, ' ').slice(0, 1200),
    };
  });
  console.log(JSON.stringify({ repaired, readback }, null, 2));
  process.exit(0);
}

let added = 0;
for (const r of ROWS) {
  await clickDodaj(0);
  await page.waitForSelector("[name='nazwa_podmiotu_konkurencyjnego']");
  await humanIdlePause('short');
  try { await setApplicant(); } catch (e) { /* applicant is auto-assigned for a single applicant */ }
  await page.locator("[name='nazwa_podmiotu_konkurencyjnego']").first().fill(r.nazwa); // allow-raw-playwright: text
  await page.locator("[name='nip']").first().fill(r.nip); // allow-raw-playwright: text
  await page.locator("[name='opis']").first().fill(r.opis); // allow-raw-playwright: text
  await humanIdlePause('deliberate');
  await humanIdlePause('deliberate');
  await saveForm();
  added += 1;
}

const readback = await page.evaluate(() => {
  const tbl = document.querySelector('table');
  let rows = -1;
  if (tbl) rows = tbl.querySelectorAll('tbody tr').length;
  return { rows };
});
console.log(JSON.stringify({ added, readback }, null, 2));
process.exit(0);
