// Attach criterion-1 supporting PDF to the replacement NCBR draft. Never submits.
// DIAG=1 opens the criterion-1 subform and dumps controls without uploading.

import { chromium } from 'playwright';
import { humanIdlePause } from '../../../dist/human/mouse.js';

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

await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('button, a, [role="button"]')).find((e) => (e.textContent || '').trim() === 'Dokumenty');
  if (!btn) throw new Error('Dokumenty control not found');
  btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
}); // allow-raw-playwright: open Dokumenty tab
await humanIdlePause('long');

async function openExistingCriterion1Edit() {
  await page.evaluate(() => {
    const menu = Array.from(document.querySelectorAll('button, [role="button"]')).find((e) =>
      (e.textContent || e.getAttribute('aria-label') || '').trim().includes('overflow-options')
    );
    if (!menu) throw new Error('no existing criterion-1 row menu found');
    menu.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }); // allow-raw-playwright: open saved criterion-1 row menu
  await humanIdlePause('short');
  await page.evaluate(() => {
    const item = Array.from(document.querySelectorAll('li, button, [role="menuitem"]')).find((e) =>
      /^Edytuj$/i.test((e.textContent || '').trim())
    );
    if (!item) throw new Error('Edytuj menu item not found');
    item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }); // allow-raw-playwright: edit saved criterion-1 row
  await humanIdlePause('long');
}

async function openCriterion1Add() {
  await page.evaluate((needle) => {
    const labels = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,p,span,div'))
      .filter((e) => e.offsetParent && (e.innerText || e.textContent || '').includes(needle))
      .map((e) => ({ e, text: (e.innerText || e.textContent || '').trim(), top: e.getBoundingClientRect().top }))
      .filter((x) => x.text.length < 500)
      .sort((a, b) => a.top - b.top);
    const label = labels[0];
    if (!label) throw new Error('criterion-1 label not found');
    const buttons = Array.from(document.querySelectorAll('button'))
      .filter((b) => (b.innerText || '').trim() === 'Dodaj' && !b.disabled)
      .map((b) => ({ b, top: b.getBoundingClientRect().top }))
      .filter((x) => x.top > label.top)
      .sort((a, b) => a.top - b.top);
    if (buttons[0]) {
      buttons[0].b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return;
    }
    throw new Error('criterion-1 Dodaj not found');
  }, criterionNeedle); // allow-raw-playwright: open the exact criterion-1 attachment row
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
  await page.evaluate(() => {
    const inp = document.querySelector("input[name*='nazwa_skrocona']");
    const sel = inp && inp.closest('.MuiInputBase-root')?.querySelector('.MuiSelect-select, [role="combobox"]');
    if (sel) for (const t of ['mousedown', 'mouseup', 'click']) sel.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
  }); // allow-raw-playwright: open applicant select
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
    await zones.nth(zoneCount - 1).click({ force: true }); // allow-raw-playwright: open LSI upload control
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
await page.evaluate(() => {
  const saves = Array.from(document.querySelectorAll('button')).filter((b) => (b.innerText || '').trim() === 'Zapisz' && !b.disabled);
  if (!saves.length) throw new Error('no enabled Zapisz');
  saves[saves.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
}).catch((e) => { saveResult = `NOT SAVED: ${String(e?.message || e).slice(0, 90)}`; }); // allow-raw-playwright: save attachment row
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
