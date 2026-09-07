// Attach criterion-1 supporting PDF to the replacement NCBR draft. Never submits.
// DIAG=1 opens the criterion-1 subform and dumps controls without uploading.

import { chromium } from 'playwright';
import { humanClickLocator, humanIdlePause } from '../../../dist/human/mouse.js';

const endpoint = process.env.NCBR_CDP_ENDPOINT || 'http://127.0.0.1:9223';
const projectId = process.env.NCBR_PROJECT_ID || '7ee80d9a-67dd-4d99-becd-8dda407221c1';
const projectUrl = `https://lsi2.ncbr.gov.pl/projekt/${projectId}`;
const pdfPath = '/Users/lukaszbartoszcze/Downloads/NCBR_Wisent_docs_combined_clean.pdf';
const criterionNeedle = 'Załączniki potwierdzające spełnienie warunku określonego w kryterium nr 1';

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) {
  console.log(JSON.stringify({ error: 'NO_PAGE' }, null, 2));
  process.exit(1);
}
page.setDefaultTimeout(20000);

await page.goto(projectUrl, { waitUntil: 'domcontentloaded' }); // allow-raw-playwright: navigate to draft
await humanIdlePause('long');
await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll('div')).find((d) => (d.innerText || '').includes('pliki cookies'));
  if (b) b.style.pointerEvents = 'none';
}); // allow-raw-playwright: neutralise cookie overlay

const documentsButton = page.getByText('Dokumenty', { exact: true }).filter({ visible: true }).first();
if (!await documentsButton.count()) throw new Error('Dokumenty control not found');
await humanClickLocator(page, documentsButton);
await humanIdlePause('long');

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
async function attachPdf() {
  const zones = page.getByText('Upuść plik lub pobierz z dysku');
  const zoneCount = await zones.count();
  if (zoneCount > 0) {
    const chooserPromise = page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null);
    await humanClickLocator(page, zones.nth(zoneCount - 1));
    const chooser = await chooserPromise;
    if (chooser) {
      await chooser.setFiles(pdfPath); // allow-raw-playwright: attach vetted criterion-1 PDF through chooser
    } else {
      const fileInput = page.locator('input[type="file"][accept*=".pdf"]').last();
      if (await fileInput.count() === 0) throw new Error('PDF file input not found in criterion-1 subform');
      await fileInput.setInputFiles(pdfPath); // allow-raw-playwright: attach vetted criterion-1 PDF through input
    }
  } else {
    const fileInput = page.locator('input[type="file"][accept*=".pdf"]').last();
    if (await fileInput.count() === 0) throw new Error('PDF file input not found in criterion-1 subform');
    await fileInput.setInputFiles(pdfPath); // allow-raw-playwright: attach vetted criterion-1 PDF through input
  }
}
await attachPdf();
await humanIdlePause('long');
await humanIdlePause('deliberate');
const uploadState = await page.evaluate(() => {
  const text = document.body.innerText || '';
  return {
    hasOneOfTen: text.includes('(1/10)'),
    hasFileName: text.includes('NCBR_Wisent_docs_combined_clean') || text.includes('combined_clean'),
    snippet: text.slice(Math.max(0, text.indexOf('Załączniki potwierdzające spełnienie warunku określonego w kryterium nr 1')), Math.max(0, text.indexOf('Załączniki potwierdzające spełnienie warunku określonego w kryterium nr 1')) + 1800),
  };
}); // allow-raw-playwright: verify upload state before saving
if (!uploadState.hasOneOfTen && !uploadState.hasFileName) {
  throw new Error(`PDF did not appear in upload widget: ${uploadState.snippet}`);
}

let saveResult = 'saved';
const saves = page.getByRole('button', { name: 'Zapisz', exact: true }).filter({ visible: true });
const saveCount = await saves.count();
if (!saveCount) saveResult = 'NOT SAVED: no enabled Zapisz';
else await humanClickLocator(page, saves.nth(saveCount - 1)).catch((e) => { saveResult = `NOT SAVED: ${String(e?.message || e).slice(0, 90)}`; });
await humanIdlePause('long');

const readback = await page.evaluate((needle) => {
  const body = document.body.innerText || '';
  const idx = body.indexOf(needle);
  return {
    status: Array.from(document.querySelectorAll('button')).find((b) => (b.innerText || '').trim() === 'Złóż wniosek')?.disabled ? 'draft_not_submittable_button_disabled' : 'draft_submit_button_enabled',
    hasPdfName: body.includes('NCBR_Wisent_docs_combined_clean') || body.includes('combined_clean'),
    criterionBlock: idx >= 0 ? body.slice(idx, idx + 2500) : body.slice(0, 2500),
  };
}, criterionNeedle); // allow-raw-playwright: read persisted visible document row

console.log(JSON.stringify({ applicant, uploadState, saveResult, readback }, null, 2));
process.exit(0);
