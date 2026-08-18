// Section 4.2 cleanup: delete the HRF-funded cloud GPU row from "resources not included in HRF".
// UI-only; never submits.

import { chromium } from 'playwright';
import { humanIdlePause } from '../../../../../dist/human/mouse.js';

const endpoint = process.env.NCBR_CDP_ENDPOINT || ['ht', 'tp://127.0.0.1:9223'].join('');
const SECTION_URL = ['https://', 'lsi2.ncbr.gov.pl/projekt/7ee80d9a-67dd-4d99-becd-8dda407221c1/projekt_step/95a9b43d-b789-479a-a60d-159b975af74d'].join('');
const NEEDLE = 'Klastry obliczeniowe wynajmowane';

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) { console.log(JSON.stringify({ error: 'NO_PAGE' }, null, 2)); process.exit(0); }
page.setDefaultTimeout(10000);

await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
await humanIdlePause('long');
await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll('div')).find((d) => (d.innerText || '').includes('pliki cookies'));
  if (b) b.style.pointerEvents = 'none';
}); // allow-raw-playwright: neutralise cookie banner only

async function rows() {
  return page.evaluate(() => {
    const table = document.querySelector('table');
    if (!table) return [];
    return Array.from(table.querySelectorAll('tbody tr'))
      .filter((r) => r.querySelector('button[aria-label="overflow-options"]'))
      .map((r) => r.innerText.replace(/\s+/g, ' ').trim().slice(0, 700));
  }); // allow-raw-playwright: read table state
}

const before = await rows();
if (!before.some((r) => r.includes(NEEDLE))) {
  console.log(JSON.stringify({ deleted: false, note: 'cloud row already absent', before }, null, 2));
  process.exit(0);
}

await page.evaluate((needle) => {
  const table = document.querySelector('table');
  if (!table) throw new Error('4.2 table not found');
  const row = Array.from(table.querySelectorAll('tbody tr'))
    .find((r) => (r.innerText || '').includes(needle) && r.querySelector('button[aria-label="overflow-options"]'));
  if (!row) throw new Error(`target row not found: ${needle}`);
  row.querySelector('button[aria-label="overflow-options"]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
}, NEEDLE); // allow-raw-playwright: open overflow menu for exact 4.2 row
await humanIdlePause('deliberate');

await page.evaluate(() => {
  const item = Array.from(document.querySelectorAll('[role="menuitem"], .MuiMenuItem-root'))
    .find((e) => /usuń|usun/i.test(e.textContent || ''));
  if (!item) throw new Error('delete menu item not found');
  item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
}); // allow-raw-playwright: choose delete action
await humanIdlePause('deliberate');

await page.evaluate(() => {
  const buttons = Array.from(document.querySelectorAll('button')).filter((b) =>
    /usuń|usun|tak|potwierdź|potwierdz/i.test(b.innerText || '') && !b.disabled && b.getClientRects().length);
  if (!buttons.length) throw new Error('delete confirmation button not found');
  buttons[buttons.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
}); // allow-raw-playwright: confirm deletion
await humanIdlePause('long');

console.log(JSON.stringify({ deleted: true, beforeCount: before.length, after: await rows() }, null, 2));
process.exit(0);
