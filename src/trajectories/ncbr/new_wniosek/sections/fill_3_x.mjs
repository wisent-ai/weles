// Scalar-text section filler (3.2/3.3/3.4 wdrozenie, 10.2/10.3 horyzontalne).
// Texts parsed from prepared markdown via markers (Kimi references). Via UI.

import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { humanClickLocator, humanIdlePause } from '../../../../../dist/human/mouse.js';
import { humanFill } from '../../../../../dist/human/keyboard.js';

const endpoint = process.env.NCBR_CDP_ENDPOINT || 'http://127.0.0.1:9223';
const PROJ = 'https://lsi2.ncbr.gov.pl/projekt/7ee80d9a-67dd-4d99-becd-8dda407221c1/projekt_step/';
const SRC = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/backends/STEP_sciezka_A_Wisent/';
const clean = (s) => s
  .replace(/\s*<!--[\s\S]*?-->\s*/g, ' ')
  .replace(/\*\*([^*]+)\*\*/g, '$1')
  .replace(/^#{1,6}\s+/gm, '')
  .trim();

const WD = 'wersja_B_3.1_3.2_3.3_3.4_wdrozenie.md';
const REG = {
  '3.2': { id: '06a70163-2dcc-47a0-b64b-201656946538', md: WD, rodzaj: true, fields: [
    { suffix: 'innowacja_produktowa_nazwa', start: '**Nazwa produktu (limit 100 znaków)**\n\n', end: '**Plan wprowadzenia rezultatu projektu na rynek – innowacja produktowa' },
    { suffix: 'innowacja_produktowa_plan_wprowadzenia', start: '**Plan wprowadzenia rezultatu projektu na rynek – innowacja produktowa (limit 6 000 znaków)**\n\n', end: '---\n\n## 3.3.' },
  ], applicant: true },
  '3.3': { id: 'bb231ac1-d863-41a8-89a7-88c1db3a1bd7', md: WD, fields: [
    { suffix: 'analiza_oplacalnosci', start: '## 3.3. Analiza opłacalności wdrożenia (limit 4 000 znaków)\n\n', end: '---\n\n## 3.4.' },
  ] },
  '3.4': { id: '836f13ca-f474-4d5c-8388-6afd84eaf353', md: WD, fields: [
    { suffix: 'zasoby_kadrowe_niezbedne_do_wdrozenia', start: '### Zasoby kadrowe niezbędne do wdrożenia (limit 2 000 znaków)\n\n', end: '### Zasoby techniczne' },
    { suffix: 'zasoby_techniczne_niezbedne_do_wdrozenia', start: '### Zasoby techniczne niezbędne do wdrożenia (limit 2 000 znaków)\n\n', end: '### Pozostałe zasoby' },
    { suffix: 'pozostale_zasoby_niezbedne_do_wdrozenia', start: '### Pozostałe zasoby niezbędne do wdrożenia (limit 2 000 znaków)\n\n', end: '---\n\n## Podsumowanie zmian' },
  ] },
  '10.2': { id: '51455d27-6e3d-4629-9cc6-2a124f5432c8', md: 'wersja_B_10_2_karta_praw.md', fields: [
    { suffix: 'zgodnosc_z_karta_praw_podstawowych', start: '**Zgodność projektu z Kartą Praw Podstawowych** (limit 4 000 znaków)', end: null },
  ] },
  '10.3': { id: '256ac98a-bb3c-4715-ad13-e8dbcd3f94f4', md: 'wersja_B_10_3_niepelnosprawni.md', fields: [
    { suffix: 'zgodnosc_z_konwencja_o_prawach_osob_niepelnosprawnych', start: '## **Zgodność projektu z Konwencją o Prawach Osób Niepełnosprawnych**', end: null },
  ] },
  '10.1': { id: 'e5bd23d7-9d4d-4f2e-948a-97c95041ef18', md: 'wersja_B_10_1_rowność.md', fields: [
    { suffix: 'wplyw_projektu_zasady_rownosci', start: '**Pozytywny wpływ projektu na realizację zasady równości szans i niedyskryminacji, w tym dostępności dla osób z niepełnosprawnościami** (limit 4 000 znaków)', end: '**Dostępność produktu/usługi w projekcie**' },
    { suffix: 'rownosc_kobiet_i_mezczyzn', start: '**Zgodność projektu z zasadą równości kobiet i mężczyzn** (limit 3 000 znaków)', end: null },
  ] },
  '4.1': { id: '5af236aa-03b2-4650-b5a2-95c299dfeeaf', md: 'wersja_B_4_1_zespol.md', fields: [
    { suffix: 'udzial_procentowy_kobiet_w_kluczowym_zespole_projektowym', value: '60.00' },
    { suffix: 'pozostaly_personel_br', start: '## Pozostały personel B+R (jeśli dotyczy)', end: '---\n\n## Personel B+R planowany do zaangażowania' },
    { suffix: 'personel_planowany_br', start: '## Personel B+R planowany do zaangażowania (jeśli dotyczy)', end: '---\n\n## Sposób zarządzania projektem' },
    { suffix: 'sposob_zarzadzania_projektem', start: '## Sposób zarządzania projektem (ścieżka decyzyjna)', end: null },
  ] },
};

const SECTION = process.env.SECTION;
const cfg = REG[SECTION];
if (!cfg) throw new Error(`bad SECTION ${SECTION}`);
const md = readFileSync(SRC + cfg.md, 'utf8');
function bt(start, end) { let s = md.split(start)[1]; if (s === undefined) throw new Error(`marker missing: ${start}`); if (end) s = s.split(end)[0]; return clean(s); }
for (const f of cfg.fields) { if (f.value === undefined) f.value = bt(f.start, f.end); }

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) { console.log(JSON.stringify({ error: 'NO_PAGE' })); process.exit(0); }

await page.goto(PROJ + cfg.id, { waitUntil: 'domcontentloaded' });
await humanIdlePause('long');
await page.evaluate(() => { const b = Array.from(document.querySelectorAll('div')).find((d) => (d.innerText || '').includes('pliki cookies')); if (b) b.style.pointerEvents = 'none'; }); // allow-raw-playwright: cookie banner

if (process.env.DIAG) {
  const before = await page.evaluate(() => ({
    inputs: Array.from(document.querySelectorAll('input')).map((i) => ({
      name: i.name,
      role: i.getAttribute('role'),
      value: i.value,
      label: i.id ? document.querySelector(`label[for="${CSS.escape(i.id)}"]`)?.textContent?.trim() : null,
      html: i.closest('.MuiFormControl-root')?.outerHTML.slice(0, 900) || null,
    })).filter((x) => x.name.includes('rodzaj_innowacji') || x.name.includes('nazwa_skrocona')),
  }));
  const kind = page.locator('input[name$="rodzaj_innowacji"]').first();
  await humanClickLocator(page, kind); // allow-raw-playwright: open kind diag
  await humanFill(page, kind, 'Innowacja produktowa'); // allow-raw-playwright: filter kind diag
  await humanIdlePause('deliberate');
  const options = await page.evaluate(() => Array.from(document.querySelectorAll('[role="option"]')).map((o) => o.textContent.trim()).filter(Boolean));
  console.log(JSON.stringify({ before, options }, null, 2));
  process.exit(0);
}

if (process.env.DIAG_SELECT) {
  await setInnovationKind();
  const after = await page.evaluate(() => ({
    inputs: Array.from(document.querySelectorAll('input, textarea')).map((i) => ({
      tag: i.tagName,
      name: i.name,
      role: i.getAttribute('role'),
      value: (i.value || '').slice(0, 120),
      visible: Boolean(i.offsetParent),
    })).filter((x) => x.name.includes('rodzaj_innowacji') || x.name.includes('innowacja_produktowa')),
    bodyHasProductName: (document.body.innerText || '').includes('Nazwa produktu'),
  }));
  console.log(JSON.stringify(after, null, 2));
  process.exit(0);
}

if (process.env.DIAG_APP) {
  const info = await page.evaluate(() => {
    const inp = Array.from(document.querySelectorAll('input')).find((i) => i.name.includes('nazwa_skrocona_wnioskodawcy'));
    const fc = inp?.closest('.MuiFormControl-root');
    const root = inp?.closest('.MuiInputBase-root');
    const candidates = fc ? Array.from(fc.querySelectorAll('.MuiSelect-select, [role="combobox"], input, div, button')).map((e) => ({
      tag: e.tagName,
      cls: e.className || null,
      role: e.getAttribute('role'),
      text: (e.textContent || '').trim().slice(0, 120),
      name: e.getAttribute('name'),
    })).slice(0, 20) : [];
    return { input: inp ? { name: inp.name, type: inp.type, value: inp.value } : null, hasRoot: Boolean(root), html: fc?.outerHTML.slice(0, 3000) || null, candidates };
  });
  console.log(JSON.stringify(info, null, 2));
  process.exit(0);
}

async function setApplicant() {
  const applicant = page.locator('input[name*="nazwa_skrocona"]').first();
  const applicantSelect = applicant.locator('xpath=ancestor::*[contains(@class, "MuiInputBase-root")][1]').locator('.MuiSelect-select, [role="combobox"]').first();
  if (await applicantSelect.count()) await humanClickLocator(page, applicantSelect);
  await humanIdlePause('deliberate');
  const opt = page.getByRole('option', { name: 'Wisent Polska', exact: true }).first();
  if (await opt.count() === 0) throw new Error('Wisent Polska option not found');
  await opt.dispatchEvent('click'); // allow-raw-playwright: select applicant
  await humanIdlePause('short');
}

async function setInnovationKind() {
  const inp = page.locator('input[name$="rodzaj_innowacji"]').first();
  await humanClickLocator(page, inp); // allow-raw-playwright: open innovation kind combobox
  await humanFill(page, inp, 'Innowacja produktowa'); // allow-raw-playwright: filter to product innovation
  await humanIdlePause('deliberate');
  const opt = page.getByRole('option', { name: 'Innowacja produktowa', exact: true }).first();
  if (await opt.count() === 0) throw new Error('Innowacja produktowa option not found');
  await humanClickLocator(page, opt); // allow-raw-playwright: select innovation kind
  await humanIdlePause('deliberate');
}

if (process.env.APPLICANT_ONLY) {
  await setApplicant();
  await humanIdlePause('deliberate');
  await humanIdlePause('deliberate');
  let saveResult = 'saved';
  await humanClickLocator(page, page.getByRole('button', { name: 'Zapisz', exact: true }).filter({ visible: true }).last())
    .catch((e) => { saveResult = `NOT SAVED: ${String(e?.message || e).slice(0, 60)}`; }); // allow-raw-playwright: save applicant-only edit
  await humanIdlePause('long');
  const applicant = await page.evaluate(() => Array.from(document.querySelectorAll('input'))
    .find((i) => i.name.includes('nazwa_skrocona_wnioskodawcy'))?.value || null);
  console.log(JSON.stringify({ section: SECTION, saveResult, applicant }, null, 2));
  process.exit(0);
}

if (cfg.rodzaj) await setInnovationKind();

if (cfg.applicant) {
  try { await setApplicant(); } catch (e) { console.log(`APPLICANT SKIP ${String(e?.message || e).slice(0, 80)}`); }
}

const filled = [];
for (const f of cfg.fields) {
  const ta = page.locator(`textarea[name$="${f.suffix}"], input[name$="${f.suffix}"]`).first();
  await ta.waitFor({ state: 'visible' });
  const max = Number(await ta.getAttribute('maxlength')) || f.value.length;
  if (f.value.length > max) throw new Error(`${f.suffix} over limit: ${f.value.length}/${max}`);
  await humanFill(page, ta, f.value); // allow-raw-playwright: LSI text
  await humanIdlePause('short');
  filled.push(`${f.suffix} (${f.value.length}/${max})`);
}

await humanIdlePause('deliberate');
await humanIdlePause('deliberate');
let saveResult = 'saved';
await humanClickLocator(page, page.getByRole('button', { name: 'Zapisz', exact: true }).filter({ visible: true }).last())
  .catch((e) => { saveResult = `NOT SAVED: ${String(e?.message || e).slice(0, 60)}`; });
await humanIdlePause('long');

const readback = await page.evaluate((sufs) => sufs.map((s) => { const e = document.querySelector(`textarea[name$="${s}"], input[name$="${s}"]`); return e ? e.value.length : null; }), cfg.fields.map((f) => f.suffix));
console.log(JSON.stringify({ section: SECTION, saveResult, filled, readback }, null, 2));
process.exit(0);
