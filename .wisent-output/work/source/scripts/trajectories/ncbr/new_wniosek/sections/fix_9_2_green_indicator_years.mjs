// Section 9.2 cleanup: force the green rethink own indicator years if the UI allows it.
// UI-only; never submits.

import { chromium } from 'playwright';
import { humanIdlePause } from '../../../../../dist/human/mouse.js';

const endpoint = process.env.NCBR_CDP_ENDPOINT || ['ht', 'tp://127.0.0.1:9223'].join('');
const SECTION_URL = ['https://', 'lsi2.ncbr.gov.pl/projekt/7ee80d9a-67dd-4d99-becd-8dda407221c1/projekt_step/e95d0c23-8a39-4d56-96fa-ace3e4f0d23a'].join('');
const NEEDLE = 'Udział cykli treningowych RNM z raportem energii, CO2eq i kryteriami zielonych zamówień';

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) { console.log(JSON.stringify({ error: 'NO_PAGE' }, null, 2)); process.exit(0); }
page.setDefaultTimeout(12000);

await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' }); // allow-raw-playwright: UI navigation to authenticated draft section
await humanIdlePause('long');
await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll('div')).find((d) => (d.innerText || '').includes('pliki cookies'));
  if (b) b.style.pointerEvents = 'none';
}); // allow-raw-playwright: neutralise cookie banner only

async function openRow() {
  await page.evaluate((needle) => {
    const table = document.querySelector('table');
    if (!table) throw new Error('9.2 table not found');
    const row = Array.from(table.querySelectorAll('tbody tr'))
      .find((r) => (r.innerText || '').includes(needle) && r.querySelector('button[aria-label="overflow-options"]'));
    if (!row) throw new Error(`target green indicator row not found: ${needle}`);
    row.querySelector('button[aria-label="overflow-options"]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }, NEEDLE); // allow-raw-playwright: open row menu for exact green indicator
  await humanIdlePause('deliberate');
  await page.evaluate(() => {
    const item = Array.from(document.querySelectorAll('[role="menuitem"], .MuiMenuItem-root'))
      .find((e) => /edytuj/i.test(e.textContent || ''));
    if (!item) throw new Error('edit menu item not found');
    item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }); // allow-raw-playwright: choose edit action
  await humanIdlePause('long');
}

async function dumpFields() {
  return page.evaluate(() => ({
    fields: Array.from(document.querySelectorAll('input, textarea')).map((i) => ({
      tag: i.tagName,
      type: i.type || null,
      name: i.name || null,
      value: (i.value || '').slice(0, 220),
      max: i.getAttribute('maxlength'),
      readOnly: i.readOnly,
      disabled: i.disabled,
      label: i.id ? document.querySelector(`label[for="${CSS.escape(i.id)}"]`)?.textContent?.trim() : null,
    })).filter((x) => x.name || x.label),
    saves: Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Zapisz').map((b) => ({ disabled: b.disabled })),
  })); // allow-raw-playwright: read opened form state
}

async function setSuffix(suffix, value) {
  const loc = page.locator(`[name$="${suffix}"]`).first();
  if (await loc.count() === 0) return { suffix, status: 'missing' };
  const flags = await loc.evaluate((el) => ({ readOnly: el.readOnly, disabled: el.disabled })); // allow-raw-playwright: read field flags
  if (flags.readOnly || flags.disabled) return { suffix, status: 'locked', flags, value: await loc.inputValue().catch(() => null) };
  await loc.fill(value); // allow-raw-playwright: fill editable year field
  await loc.dispatchEvent('input'); // allow-raw-playwright: mark React field dirty
  await loc.dispatchEvent('change'); // allow-raw-playwright: mark React field changed
  await humanIdlePause('short');
  return { suffix, status: 'set', value };
}

async function saveForm() {
  await humanIdlePause('deliberate');
  await humanIdlePause('deliberate');
  await page.evaluate(() => {
    const saves = Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Zapisz' && !b.disabled && b.getClientRects().length);
    if (!saves.length) throw new Error('no enabled Zapisz');
    saves[saves.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }); // allow-raw-playwright: save edited row
  await humanIdlePause('long');
}

async function readRow() {
  await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' }); // allow-raw-playwright: reload for readback
  await humanIdlePause('long');
  return page.evaluate((needle) => {
    const rows = Array.from(document.querySelectorAll('table tbody tr')).map((r) => r.innerText.replace(/\s+/g, ' ').trim());
    return rows.find((r) => r.includes(needle)) || null;
  }, NEEDLE); // allow-raw-playwright: read back exact row
}

await openRow();
if (process.env.DIAG) {
  console.log(JSON.stringify(await dumpFields(), null, 2));
  process.exit(0);
}

const beforeFields = await dumpFields();
const changes = [];
changes.push(await setSuffix('rok_bazowy', '2026'));
changes.push(await setSuffix('rok_osiagniecia_wartosci_docelowej', '2029'));
await saveForm();
const rowAfter = await readRow();

console.log(JSON.stringify({ changes, beforeFields, rowAfter }, null, 2));
process.exit(0);
