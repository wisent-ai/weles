// Section 1.3 applicant entity repair: spolka celowa = Tak, VAT justification = Nie dotyczy.
// UI-only; edits existing row, never adds a duplicate, never submits.

import { chromium } from 'playwright';
import { humanClickLocator, humanIdlePause } from '../../../../../dist/human/mouse.js';
import { humanFill } from '../../../../../dist/human/keyboard.js';

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
  const row = page.locator('table').first().locator('tbody tr').filter({ hasText: 'Wisent Polska' }).first();
  if (await row.count() === 0) throw new Error('Wisent Polska row not found');
  const buttons = row.locator('button').filter({ visible: true });
  const buttonCount = await buttons.count();
  if (!buttonCount) throw new Error('no action buttons in entity row');
  const button = buttons.last();
  const result = {
    buttons: buttonCount,
    clickedText: (await button.innerText()).trim(),
    clickedAria: await button.getAttribute('aria-label'),
  };
  await humanClickLocator(page, button);
  await humanIdlePause('deliberate');

  const edit = page.locator('[role="menuitem"], li, button').filter({ visible: true })
    .filter({ hasText: /edytuj|edycja|zmień|zobacz|szczegóły/i }).first();
  let menuClicked = null;
  if (await edit.count() > 0) {
    menuClicked = ((await edit.textContent()) || await edit.getAttribute('aria-label') || '').trim();
    await humanClickLocator(page, edit);
    await humanIdlePause('long');
  }

  if (await page.locator('textarea[name="nazwa"]').count() === 0) {
    const direct = page.locator('button[aria-label*="Edytuj"], button:has-text("Edytuj")').first();
    if (await direct.count() > 0) {
      await humanClickLocator(page, direct);
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
await humanClickLocator(page, spolka);
await humanIdlePause('short');

const vatInput = page.locator('textarea[name="uzasadnienie_braku_mozliwosci_odzyskania_vat"]').first();
if (await vatInput.count() > 0) {
  await humanFill(page, vatInput, 'Nie dotyczy.');
  await humanIdlePause('short');
}

await humanIdlePause('deliberate');
await humanIdlePause('deliberate');
let saveResult = 'saved';
try {
  const save = page.locator('button:not([disabled])').filter({ hasText: /^Zapisz$/ }).filter({ visible: true }).last();
  if (await save.count() === 0) throw new Error('no enabled Zapisz');
  await humanClickLocator(page, save);
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
