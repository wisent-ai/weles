// Criterion-1 attachments for the NCBR wniosek (project 7ee80d9a). Never submits.
// MODE=read (default) lists what the Dokumenty view shows and compares it with the
// declared package. MODE=apply uploads the declared files. PACKAGE selects the package.
// DIAG=1 opens the criterion-1 subform and dumps controls without uploading.

import { chromium } from 'playwright';
import { statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { humanClickLocator, humanIdlePause } from '../../../dist/human/mouse.js';

const endpoint = process.env.NCBR_CDP_ENDPOINT || 'http://127.0.0.1:9223';
const projectId = process.env.NCBR_PROJECT_ID || '7ee80d9a-67dd-4d99-becd-8dda407221c1';
const projectUrl = `https://lsi2.ncbr.gov.pl/projekt/${projectId}`;
const criterionNeedle = 'Załączniki potwierdzające spełnienie warunku określonego w kryterium nr 1';

// Declared criterion-1 files in attachment order; ControlAI groups sixteen documents into ten PDFs.
const PACKAGES = {
  controlai: {
    dir: '/Users/lukaszbartoszcze/Desktop/FENG.05.01-IP.01-007N-26 - pakiet do wgrania/',
    files: [
      '01-04_dokumenty_dominacji_podpisane.pdf',
      '05_umowa_zbycia_9_udzialow_13.04.2026.pdf',
      '06_lista_wspolnikow_podpisana_13.04.2026.pdf',
      '07_odpis_aktualny_KRS_19.06.2026.pdf',
      '08_ControlAI_Certificate_of_Incorporation.pdf',
      '08a_tlumaczenie_aktu_ControlAI.pdf',
      '09_ControlAI_EIN_147C_PL_EN.pdf',
      '10-11_sprawozdania_finansowe_2024-2025_PL_EN.pdf',
      '12-13_Form_1120_2024-2025_PL_EN.pdf',
      '14-15_dzialalnosc_ControlAI_podpisane_oswiadczenie_i_dowody.pdf',
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
if (!['read', 'apply'].includes(MODE)) throw new Error(`Unsupported MODE=${MODE}`);
const resumeStaged = process.env.RESUME_STAGED === '1';
if (resumeStaged && MODE !== 'apply') throw new Error('RESUME_STAGED requires MODE=apply');
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
    if (!info.isFile()) throw new Error('not a regular file');
    file.bytes = info.size;
    file.sha256 = createHash('sha256').update(readFileSync(file.path)).digest('hex');
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
const page = browser.contexts()[0]?.pages().find((candidate) => candidate.url().startsWith('https://lsi2.ncbr.gov.pl/'));
if (!page) {
  console.log(JSON.stringify({ error: 'NO_PAGE' }, null, 2));
  process.exit(1);
}
page.setDefaultTimeout(20000);

if (!resumeStaged) {
  await page.goto(projectUrl, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');
  if (page.url().includes('/logowanie')) throw new Error(`LSI2 login required at ${page.url()}`);
  const documentsButton = page.getByText('Dokumenty', { exact: true }).filter({ visible: true }).first();
  if (!await documentsButton.count()) throw new Error('Dokumenty control not found');
  await documentsButton.click();
  await humanIdlePause('long');
} else if (!page.url().startsWith(`${projectUrl}/dokumenty/`)
  || await page.locator('#collection-obj-form-save-btn').count() !== 1) {
  throw new Error('RESUME_STAGED requires the existing open attachment drawer; nothing changed');
}

const declaredNames = declared.map((file) => file.name);
const reportDir = process.env.REPORT_DIR;
const report = { mode: MODE, resumeStaged, package: PACKAGE, projectId, startedAt: new Date().toISOString(), files: declared, events: [], submitted: false };
function record(phase, data = {}) {
  report.events.push({ at: new Date().toISOString(), phase, ...data });
  if (reportDir) {
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(join(reportDir, 'report.json'), JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify({ phase, ...data }));
}

function fileLabel(name) {
  return page.locator(`p[title=${JSON.stringify(name)}]`).filter({ visible: true });
}

async function readUploaded() {
  return page.locator('p[title$=".pdf"]').filter({ visible: true }).evaluateAll((labels) => labels.map((label) => ({
    name: label.getAttribute('title'),
    detail: label.parentElement.innerText,
    ready: Boolean(label.parentElement.querySelector('svg[data-testid="CheckCircleIcon"]')),
  })));
}

function compareFiles(rows) {
  const names = rows.map((row) => row.name);
  return {
    rows,
    missing: declaredNames.filter((name) => !names.includes(name)),
    extra: names.filter((name) => !declaredNames.includes(name)),
    complete: names.length === declaredNames.length && new Set(names).size === names.length
      && declaredNames.every((name) => names.includes(name)) && rows.every((row) => row.ready),
  };
}

async function downloadFile(name, folder) {
  mkdirSync(folder, { recursive: true });
  const pending = page.waitForEvent('download', { timeout: 60000 });
  await fileLabel(name).click();
  const download = await pending;
  const path = join(folder, name);
  await download.saveAs(path);
  const failure = await download.failure();
  if (failure) throw new Error(`Download failed for ${name}: ${failure}`);
  const bytes = readFileSync(path);
  return { name, path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

async function openExistingCriterion1Edit() {
  const menu = page.locator('table tbody tr').filter({ hasText: 'Wisent Polska' })
    .locator('button[aria-label="overflow-options"]').filter({ visible: true });
  if (await menu.count() !== 1) throw new Error('Expected one existing Wisent Polska criterion-1 attachment row');
  await menu.click();
  const item = page.getByRole('menuitem', { name: 'Edytuj', exact: true });
  await item.waitFor({ state: 'visible' });
  await item.click();
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

if (!resumeStaged) {
  if (MODE === 'read' || process.env.EDIT_EXISTING) await openExistingCriterion1Edit();
  else await openCriterion1Add();
}
const before = await readUploaded();
record('before', { state: compareFiles(before) });
if (MODE === 'read') {
  const state = compareFiles(before);
  if (reportDir) await page.screenshot({ path: join(reportDir, 'page.png'), fullPage: true });
  await page.getByRole('button', { name: 'close side drawer', exact: true }).click();
  console.log(JSON.stringify(state, null, 2));
  process.exit(state.complete ? 0 : 1);
}

if (process.env.DIAG) { record('diagnostic', { url: page.url(), text: await page.locator('body').innerText(), buttons: await page.locator('button').evaluateAll((buttons) => buttons.map((button) => ({ id: button.id, text: button.innerText, label: button.getAttribute('aria-label'), disabled: button.disabled }))) }); process.exit(0); }

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

if (!reportDir) throw new Error('MODE=apply requires REPORT_DIR to retain the original attachment and upload evidence');
const replaceName = process.env.REPLACE_FILE || '';
const unexpected = before.filter((file) => !declaredNames.includes(file.name) && file.name !== replaceName);
if (unexpected.length) throw new Error(`Unexpected attachments; nothing changed: ${unexpected.map((file) => file.name).join(', ')}`);
const applicant = process.env.EDIT_EXISTING ? 'existing Wisent Polska row' : await selectApplicant();
const documentsUrl = page.url();

try {
  let changed = resumeStaged;
  if (replaceName && before.some((file) => file.name === replaceName)) {
    const backup = await downloadFile(replaceName, join(reportDir, 'previous'));
    record('backed-up-original', backup);
    const row = fileLabel(replaceName).locator('..');
    await row.locator('button:has(svg[data-testid="CloseIcon"])').click();
    await fileLabel(replaceName).waitFor({ state: 'detached' });
    changed = true;
    record('removed-from-form', { name: replaceName });
  }

  for (const file of declared) {
    const existing = (await readUploaded()).find((row) => row.name === file.name);
    if (existing?.ready) continue;
    if (existing) throw new Error(`Existing attachment is not ready: ${file.name}`);
    // This widget accepts one file per selection even though the row holds ten PDFs.
    await page.locator('input[type="file"][accept*=".pdf"]').last().setInputFiles(file.path);
    await page.waitForFunction((name) => {
      const label = Array.from(document.querySelectorAll('p[title]')).find((element) => element.title === name);
      return Boolean(label?.parentElement.querySelector('svg[data-testid="CheckCircleIcon"]'));
    }, file.name, { timeout: 120000 });
    changed = true;
    record('uploaded', { name: file.name, bytes: file.bytes, sha256: file.sha256 });
  }

  const staged = compareFiles(await readUploaded());
  record('staged', { state: staged });
  if (!staged.complete) throw new Error('The staged attachments do not match the complete declared package');
  await page.screenshot({ path: join(reportDir, 'staged.png'), fullPage: true });

  if (changed) {
    const save = page.getByRole('button', { name: 'Zapisz', exact: true }).filter({ visible: true }).last();
    if (!await save.isEnabled()) throw new Error('The attachment-row Save button is disabled');
    await save.press('Enter'); // activate only this Save button; the cookie notice covers its click target
    await page.getByRole('button', { name: 'close side drawer', exact: true }).waitFor({ state: 'hidden' });
    record('saved-row');
    await humanIdlePause('long');
    const parentSave = page.locator('#section-form-save-btn');
    await parentSave.waitFor({ state: 'visible' });
    await page.screenshot({ path: join(reportDir, 'parent-before-save.png'), fullPage: true });
    if (await parentSave.isEnabled()) {
      await parentSave.press('Enter');
      await page.waitForFunction(() => {
        const button = Array.from(document.querySelectorAll('button')).find((element) => element.innerText.trim() === 'Zapisz');
        return button?.disabled === true;
      });
      record('saved-document-section');
    }
  } else {
    await page.getByRole('button', { name: 'close side drawer', exact: true }).click();
  }

  // Prove persistence from a newly loaded page, not the unsaved drawer's local state.
  await page.goto(documentsUrl, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');
  const status = await page.locator('body').innerText();
  if (!status.includes('Rekomendacje poprawy przekazane wnioskodawcy')) {
    throw new Error('Unexpected application status after attachment save; no submission was requested');
  }
  await openExistingCriterion1Edit();
  const persisted = compareFiles(await readUploaded());
  record('persisted', { state: persisted });
  if (!persisted.complete) throw new Error('Reloaded LSI2 attachments do not match the declared package');
  await page.screenshot({ path: join(reportDir, 'persisted.png'), fullPage: true });

  for (const file of declared) {
    const downloaded = await downloadFile(file.name, join(reportDir, 'downloaded'));
    if (downloaded.sha256 !== file.sha256 || downloaded.bytes !== file.bytes) {
      throw new Error(`The saved PDF bytes differ from the declared source: ${file.name}`);
    }
    record('download-verified', downloaded);
  }
  await page.getByRole('button', { name: 'close side drawer', exact: true }).click();
  record('complete', { applicant, url: page.url(), attachmentCount: persisted.rows.length, submitted: false });
} catch (error) {
  record('failed', { error: String(error?.message || error), url: page.url() });
  throw error;
}
process.exit(0);
