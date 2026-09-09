// Criterion-1 attachments for the NCBR wniosek (project 7ee80d9a). Never submits.
// MODE=read (default) lists what the Dokumenty view shows and compares it with the
// declared package. MODE=apply uploads the declared files. PACKAGE selects the package.
// DIAG=1 opens the criterion-1 subform and dumps controls without uploading.

import { chromium } from 'playwright';
import { statSync } from 'node:fs';
import { humanClickLocator, humanIdlePause } from '../../../dist/human/mouse.js';

const endpoint = process.env.NCBR_CDP_ENDPOINT || 'http://127.0.0.1:9223';
const projectId = process.env.NCBR_PROJECT_ID || '7ee80d9a-67dd-4d99-becd-8dda407221c1';
const projectUrl = `https://lsi2.ncbr.gov.pl/projekt/${projectId}`;
const criterionNeedle = 'Załączniki potwierdzające spełnienie warunku określonego w kryterium nr 1';

// Both packages of criterion-1 evidence, one file per document, in attachment order.
const PACKAGES = {
  controlai: {
    dir: '/Users/lukaszbartoszcze/Desktop/Wisent - wariant ControlAI 14.04.2026/',
    files: [
      '01_porozumienie_ControlAI_wspolnik.pdf',
      '02_umowa_o_zarzadzanie_ControlAI.pdf',
      '03_uchwaly_zarzadu_ControlAI.pdf',
      '04_zawiadomienie_o_stosunku_dominacji.pdf',
      '05_umowa_zbycia_9_udzialow_13.04.2026.pdf',
      '06_lista_wspolnikow_podpisana_13.04.2026.pdf',
      '07_odpis_aktualny_KRS_19.06.2026.pdf',
      '08_ControlAI_Certificate_of_Incorporation.pdf',
      '08a_tlumaczenie_aktu_ControlAI.pdf',
      '09_ControlAI_EIN_147C.pdf',
      '10_sprawozdanie_finansowe_ControlAI_2024.pdf',
      '11_sprawozdanie_finansowe_ControlAI_2025.pdf',
      '12_ControlAI_Form_1120_2024_EN.pdf',
      '13_ControlAI_Form_1120_2025_EN.pdf',
      '14_oswiadczenie_o_dzialalnosci_ControlAI.pdf',
      '15_zestawienie_dowodow_dzialalnosci.pdf',
    ],
  },
  'wisent-ai': {
    dir: '/Users/lukaszbartoszcze/Desktop/Wisent - dokumenty korporacyjne 14.04.2026/',
    files: [
      '01_porozumienie_wspolnikow.pdf',
      '02_umowa_o_zarzadzanie_spolka_zalezna.pdf',
      '03_zawiadomienie_o_stosunku_dominacji.pdf',
      '04_uchwala_zarzadu_Wisent_AI_14.04.2026.pdf',
      '05_umowa_zbycia_9_udzialow_13.04.2026.pdf',
      '06_lista_wspolnikow_podpisana_13.04.2026.pdf',
      '07_odpis_aktualny_KRS_19.06.2026.pdf',
      '08_certificate_of_incorporation.pdf',
      '09_certificate_of_good_standing.pdf',
      '10_Financial_Statements_2024_EN.pdf',
      '11_Financial_Statements_2025_EN.pdf',
      '13_oswiadczenie_o_dzialalnosci_spolki_dominujacej.pdf',
      '14_zestawienie_dowodow_dzialalnosci.pdf',
      '15_wyciag_Mercury_wplyw_SAFE_2025-01.pdf',
      '16_Form_1120_2024_EN.pdf',
      '17_Form_1120_2025_EN.pdf',
    ],
  },
};

// Limits declared by the live field zalaczniki_potwierdzajace_kryterium_nr1_zalacznik
// in the submitted application: at most ten PDFs per collection row, ten million bytes each.
const MAX_FILES = Number('10');
const MAX_FILE_BYTES = Number('10000000');
const MODE = process.env.MODE || 'read';
const PACKAGE = process.env.PACKAGE || 'controlai';
const pack = PACKAGES[PACKAGE];
if (!pack) throw new Error(`unknown PACKAGE=${PACKAGE}, expected one of ${Object.keys(PACKAGES).join(', ')}`);
const declared = pack.files.map((name) => ({ name, path: pack.dir + name }));
const missingFiles = [];
const oversizeFiles = [];
for (const file of declared) {
  try {
    const info = statSync(file.path);
    if (info.size > MAX_FILE_BYTES) oversizeFiles.push(`${file.name} (${info.size} B)`);
  } catch (error) {
    missingFiles.push(`${file.name}: ${String(error?.message || error).slice(0, Number('70'))}`);
  }
}
if (missingFiles.length) throw new Error(`brakujace pliki paczki ${PACKAGE}: ${missingFiles.join('; ')}`);
if (oversizeFiles.length) throw new Error(`pliki ponad limit ${MAX_FILE_BYTES} B: ${oversizeFiles.join('; ')}`);
if (MODE === 'apply' && declared.length > MAX_FILES) {
  throw new Error(`paczka ${PACKAGE} ma ${declared.length} plikow, a pole przyjmuje ${MAX_FILES} na wiersz kolekcji; rozloz zestaw na dwa wiersze kolekcji albo polacz dokumenty w rodziny wedlug FENG.05.01-IP.01-007N-26_KRYTERIUM_1_LISTA_ZMIAN.md`);
}

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) {
  console.log(JSON.stringify({ error: 'NO_PAGE' }, null, 2));
  process.exit(1);
}
page.setDefaultTimeout(20000);

await page.goto(projectUrl, { waitUntil: 'domcontentloaded' }); // allow-raw-playwright: navigate to draft
await humanIdlePause('long');
if (page.url().includes('/logowanie')) {
  throw new Error(`sesja LSI2 wygasla i przegladarka jest na ${page.url()}; zaloguj sie ponownie w tym oknie i powtorz przebieg`);
}
await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll('div')).find((d) => (d.innerText || '').includes('pliki cookies'));
  if (b) b.style.pointerEvents = 'none';
}); // allow-raw-playwright: neutralise cookie overlay

const documentsButton = page.getByText('Dokumenty', { exact: true }).filter({ visible: true }).first();
if (!await documentsButton.count()) throw new Error('Dokumenty control not found');
await humanClickLocator(page, documentsButton);
await humanIdlePause('long');

if (MODE === 'read') {
  const view = await page.evaluate(() => {
    const text = document.body.innerText || '';
    const names = text.match(/[\wĄĆĘŁŃÓŚŹŻąćęłńóśźż\-. ]+\.pdf/gi) || [];
    return { url: location.href, pdfs: Array.from(new Set(names.map((name) => name.trim()))) };
  }); // allow-raw-playwright: read-only list of attachment names visible in the Dokumenty view
  const declaredNames = declared.map((file) => file.name);
  console.log(JSON.stringify({
    mode: MODE,
    paczka: PACKAGE,
    url: view.url,
    limity: { maxPlikow: MAX_FILES, maxBajtowNaPlik: MAX_FILE_BYTES },
    zadeklarowanePliki: declaredNames.length,
    widoczneZalaczniki: view.pdfs,
    brakuje: declaredNames.filter((name) => !view.pdfs.includes(name)),
    nadmiarowe: view.pdfs.filter((name) => !declaredNames.includes(name)),
  }, null, Number('2')));
  process.exit(0);
}

async function openExistingCriterion1Edit() {
  const menu = page.locator('button[aria-label*="overflow-options"], [role="button"][aria-label*="overflow-options"]').filter({ visible: true }).first();
  if (!await menu.count()) throw new Error('no existing criterion-1 row menu found');
  await humanClickLocator(page, menu);
  await humanIdlePause('short');
  const item = page.getByText(/^Edytuj$/i, { exact: true }).filter({ visible: true }).first();
  if (!await item.count()) throw new Error('Edytuj menu item not found');
  await humanClickLocator(page, item);
  await humanIdlePause('long');
}

async function openCriterion1Add() {
  const label = page.getByText(criterionNeedle, { exact: false }).filter({ visible: true }).first();
  if (!await label.count()) throw new Error('criterion-1 label not found');
  const labelBox = await label.boundingBox();
  const addButtons = page.getByRole('button', { name: 'Dodaj', exact: true }).filter({ visible: true });
  let addButton = null;
  for (let i = 0; i < await addButtons.count(); i += 1) {
    const candidate = addButtons.nth(i);
    const box = await candidate.boundingBox();
    if (box && labelBox && box.y > labelBox.y) { addButton = candidate; break; }
  }
  if (!addButton) throw new Error('criterion-1 Dodaj not found');
  await humanClickLocator(page, addButton);
  await humanIdlePause('long');
}

if (process.env.EDIT_EXISTING) await openExistingCriterion1Edit();
else await openCriterion1Add();

if (process.env.DIAG) {
  const out = await page.evaluate(() => {
    const text = (document.body.innerText || '').slice(0, 12000);
    const controls = Array.from(document.querySelectorAll('input, textarea, select')).map((e) => {
      const label = e.id ? document.querySelector(`label[for="${CSS.escape(e.id)}"]`)?.textContent?.trim() : null;
      const wrap = e.closest('label, .MuiFormControl-root, .MuiBox-root, form, section');
      return {
        tag: e.tagName,
        type: e.type || null,
        name: e.name || null,
        role: e.getAttribute('role'),
        accept: e.accept || null,
        multiple: Boolean(e.multiple),
        value: (e.value || '').slice(0, 140),
        label,
        nearby: wrap ? wrap.textContent.trim().replace(/\s+/g, ' ').slice(0, 600) : null,
      };
    }).filter((e) => e.name || e.type === 'file' || e.label || e.nearby);
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]')).map((b) => ({
      text: (b.textContent || b.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 160),
      disabled: Boolean(b.disabled || b.getAttribute('aria-disabled') === 'true'),
    })).filter((b) => b.text);
    return { url: location.href, text, controls, buttons };
  }); // allow-raw-playwright: read-only subform inspection
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

async function selectApplicant() {
  const input = page.locator("input[name*='nazwa_skrocona']").first();
  if (await input.count() === 0) return 'no applicant input';
  const applicantSelect = page.locator('.MuiInputBase-root:has(input[name*="nazwa_skrocona"])').locator('.MuiSelect-select, [role="combobox"]').first();
  if (await applicantSelect.count()) await humanClickLocator(page, applicantSelect);
  await humanIdlePause('deliberate');
  const opt = page.getByRole('option', { name: 'Wisent Polska', exact: true }).first();
  if (await opt.count() === 0) return 'no Wisent Polska option';
  await opt.dispatchEvent('click'); // allow-raw-playwright: select applicant
  await humanIdlePause('short');
  return 'selected';
}

const applicant = await selectApplicant();
async function attachDeclared() {
  const paths = declared.map((file) => file.path);
  const zones = page.getByText('Upuść plik lub pobierz z dysku');
  const zoneCount = await zones.count();
  if (zoneCount > 0) {
    const chooserPromise = page.waitForEvent('filechooser', { timeout: 5000 });
    await humanClickLocator(page, zones.nth(zoneCount - 1));
    const chooser = await chooserPromise;
    await chooser.setFiles(paths); // allow-raw-playwright: attach the declared criterion-1 documents through the chooser
    return;
  }
  const fileInput = page.locator('input[type="file"][accept*=".pdf"]').last();
  if (await fileInput.count() === 0) throw new Error('PDF file input not found in criterion-1 subform');
  await fileInput.setInputFiles(paths); // allow-raw-playwright: attach the declared criterion-1 documents through the input
}
await attachDeclared();
await humanIdlePause('long');
await humanIdlePause('deliberate');
const declaredNames = declared.map((file) => file.name);
const uploadState = await page.evaluate(({ names, needle }) => {
  const text = document.body.innerText || '';
  const start = Math.max(Number('0'), text.indexOf(needle));
  return {
    widoczne: names.filter((name) => text.includes(name)),
    brakuje: names.filter((name) => !text.includes(name)),
    snippet: text.slice(start, start + Number('1800')),
  };
}, { names: declaredNames, needle: criterionNeedle }); // allow-raw-playwright: verify the declared files entered the widget before saving
if (uploadState.brakuje.length) {
  throw new Error(`widget nie pokazuje ${uploadState.brakuje.length} zadeklarowanych plikow (${uploadState.brakuje.join(', ')}): ${uploadState.snippet}`);
}

let saveResult = 'saved';
const saves = page.getByRole('button', { name: 'Zapisz', exact: true }).filter({ visible: true });
const saveCount = await saves.count();
if (!saveCount) saveResult = 'NOT SAVED: no enabled Zapisz';
else await humanClickLocator(page, saves.nth(saveCount - 1)).catch((e) => { saveResult = `NOT SAVED: ${String(e?.message || e).slice(0, 90)}`; });
await humanIdlePause('long');

const readback = await page.evaluate(({ needle, names }) => {
  const body = document.body.innerText || '';
  const idx = body.indexOf(needle);
  return {
    zapisanePliki: names.filter((name) => body.includes(name)),
    brakujacePliki: names.filter((name) => !body.includes(name)),
    criterionBlock: idx >= Number('0') ? body.slice(idx, idx + Number('2500')) : body.slice(Number('0'), Number('2500')),
  };
}, { needle: criterionNeedle, names: declaredNames }); // allow-raw-playwright: read the persisted visible document rows

console.log(JSON.stringify({ applicant, uploadState, saveResult, readback }, null, 2));
process.exit(0);
