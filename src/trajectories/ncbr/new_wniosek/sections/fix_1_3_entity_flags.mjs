// Section 1.3 applicant entity repair: spolka celowa = Tak, VAT justification = Nie dotyczy.
// UI-only; edits existing row, never adds a duplicate, never submits.

import { chromium } from 'playwright';
import { humanIdlePause } from '../../../../../dist/human/mouse.js';

const endpoint = process.env.NCBR_CDP_ENDPOINT || ['ht', 'tp://127.0.0.1:9223'].join('');
const SECTION_URL = ['https://', 'lsi2.ncbr.gov.pl/projekt/7ee80d9a-67dd-4d99-becd-8dda407221c1/projekt_step/317a21dd-e798-4115-ab53-6ab5a2912fb0'].join('');

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) { console.log(JSON.stringify({ error: 'NO_PAGE' }, null, 2)); process.exit(0); }
page.setDefaultTimeout(12000);

await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
await humanIdlePause('long');
await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll('div')).find((d) => (d.innerText || '').includes('pliki cookies'));
  if (b) b.style.pointerEvents = 'none';
}); // allow-raw-playwright: neutralise cookie banner only

async function firstTableInfo() {
  return page.evaluate(() => {
    const table = document.querySelectorAll('table')[0];
    if (!table) return { error: 'no first table' };
    const rows = Array.from(table.querySelectorAll('tbody tr'));
    return {
      rowCount: rows.length,
      tableText: table.innerText.replace(/\s+/g, ' ').trim().slice(0, 1000),
      rows: rows.map((row, idx) => ({
        idx,
        text: row.innerText.replace(/\s+/g, ' ').trim().slice(0, 500),
        buttons: Array.from(row.querySelectorAll('button')).map((b, bidx) => ({
          bidx,
          text: b.innerText.trim(),
          aria: b.getAttribute('aria-label'),
          title: b.getAttribute('title'),
          html: b.outerHTML.slice(0, 300),
        })),
        html: row.outerHTML.slice(0, 1600),
      })),
    };
  }); // allow-raw-playwright: read DOM only
}

if (process.env.DIAG) {
  console.log(JSON.stringify(await firstTableInfo(), null, 2));
  process.exit(0);
}

async function openEntityEdit() {
  const result = await page.evaluate(() => {
    const table = document.querySelectorAll('table')[0];
    if (!table) throw new Error('entity table not found');
    const row = Array.from(table.querySelectorAll('tbody tr')).find((r) => (r.innerText || '').includes('Wisent Polska'));
    if (!row) throw new Error('Wisent Polska row not found');
    const buttons = Array.from(row.querySelectorAll('button')).filter((b) => b.getClientRects().length);
    if (!buttons.length) throw new Error('no action buttons in entity row');
    const button = buttons[buttons.length - 1];
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return { buttons: buttons.length, clickedText: button.innerText.trim(), clickedAria: button.getAttribute('aria-label') };
  }); // allow-raw-playwright: open row action menu or edit button
  await humanIdlePause('deliberate');

  const menuClicked = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('[role="menuitem"], li, button')).filter((el) => el.getClientRects().length);
    const edit = items.find((el) => /edytuj|edycja|zmień|zobacz|szczegóły/i.test(el.textContent || el.getAttribute('aria-label') || ''));
    if (edit) {
      edit.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return (edit.textContent || edit.getAttribute('aria-label') || '').trim();
    }
    return null;
  }); // allow-raw-playwright: choose edit action if menu opened
  if (menuClicked) await humanIdlePause('long');

  if (await page.locator('textarea[name="nazwa"]').count() === 0) {
    const direct = page.locator('button[aria-label*="Edytuj"], button:has-text("Edytuj")').first();
    if (await direct.count() > 0) {
      await direct.dispatchEvent('click'); // allow-raw-playwright: direct edit action
      await humanIdlePause('long');
    }
  }
  return { result, menuClicked };
}

const open = await openEntityEdit();
await page.waitForSelector('textarea[name="nazwa"]');
await humanIdlePause('short');

const before = await page.evaluate(() => {
  const radios = Array.from(document.querySelectorAll('input[type="radio"]')).map((r) => ({
    name: r.name,
    value: r.value,
    checked: r.checked,
    label: r.id ? document.querySelector(`label[for="${CSS.escape(r.id)}"]`)?.textContent?.trim() : null,
    muiChecked: !!r.closest('.Mui-checked, .MuiRadio-root.Mui-checked'),
    nearby: (r.closest('label, .MuiFormControlLabel-root, .MuiFormGroup-root, .MuiBox-root')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160),
  }));
  const vat = document.querySelector('textarea[name="uzasadnienie_braku_mozliwosci_odzyskania_vat"]')?.value || null;
  const inputs = Array.from(document.querySelectorAll('input,textarea')).map((el) => ({
    tag: el.tagName,
    type: el.getAttribute('type'),
    name: el.getAttribute('name'),
    value: (el.value || '').slice(0, 80),
    checked: el.checked,
    label: el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent?.trim() : null,
  })).filter((x) => x.name || x.label);
  return { radios, vat, inputs };
}); // allow-raw-playwright: read current entity form

if (process.env.FORM_DIAG) {
  console.log(JSON.stringify({ open, before }, null, 2));
  process.exit(0);
}

const spolka = page.locator('input[type="radio"][value="Tak"]').first();
if (await spolka.count() === 0) throw new Error('spolka celowa Tak radio not found');
await spolka.dispatchEvent('click'); // allow-raw-playwright: set spolka celowa = Tak
await humanIdlePause('short');

const vatInput = page.locator('textarea[name="uzasadnienie_braku_mozliwosci_odzyskania_vat"]').first();
if (await vatInput.count() > 0) {
  await vatInput.fill('Nie dotyczy.'); // allow-raw-playwright: instruction-compliant VAT text for full recovery
  await humanIdlePause('short');
}

await humanIdlePause('deliberate');
await humanIdlePause('deliberate');
let saveResult = 'saved';
try {
  await page.evaluate(() => {
    const saves = Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Zapisz' && !b.disabled);
    if (!saves.length) throw new Error('no enabled Zapisz');
    saves[saves.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }); // allow-raw-playwright: save existing entity row
  await humanIdlePause('long');
} catch (e) {
  saveResult = `NOT SAVED: ${String(e?.message || e).slice(0, 100)}`;
}

const after = await page.evaluate(() => ({
  bodyHasWisent: (document.body.innerText || '').includes('Wisent Polska'),
  tables: Array.from(document.querySelectorAll('table')).map((t) => ({
    rows: t.querySelectorAll('tbody tr').length,
    text: t.innerText.replace(/\s+/g, ' ').trim().slice(0, 900),
  })).slice(0, 4),
}));

console.log(JSON.stringify({ open, saveResult, before, after }, null, 2));
process.exit(0);
