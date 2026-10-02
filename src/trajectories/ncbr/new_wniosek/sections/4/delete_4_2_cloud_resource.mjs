// Section 4.2 cleanup: delete the HRF-funded cloud GPU row from "resources not included in HRF".
// UI-only; never submits.

import { chromium } from 'playwright';
import { humanClickLocator, humanIdlePause } from '../../../../../../dist/human/mouse.js';

const endpoint = (await import('#ncbr-settings')).cdpEndpoint();
const SECTION_URL = (await import('#ncbr-settings')).sectionUrl('4_2');
const NEEDLE = 'Klastry obliczeniowe wynajmowane';

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) {
  console.log(JSON.stringify({ error: 'NO_PAGE' }, null, 2));
  process.exit(1);
}


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
      .map((r) => r.innerText.replace(/\s+/g, ' ').trim());
  }); // allow-raw-playwright: read table state
}

const before = await rows();
if (!before.some((r) => r.includes(NEEDLE))) {
  console.log(JSON.stringify({ deleted: false, note: 'cloud row already absent', before }, null, 2));
  process.exit(0);
}

const targetRow = page.locator('table tbody tr', { hasText: NEEDLE }).filter({ has: page.locator('button[aria-label="overflow-options"]') }).first();
if (await targetRow.count() === 0) throw new Error(`target row not found: ${NEEDLE}`);
await humanClickLocator(page, targetRow.locator('button[aria-label="overflow-options"]'));
await humanIdlePause('deliberate');

const deleteItem = page.locator('[role="menuitem"], .MuiMenuItem-root').filter({ hasText: /usuń|usun/i }).first();
if (await deleteItem.count() === 0) throw new Error('delete menu item not found');
await humanClickLocator(page, deleteItem);
await humanIdlePause('deliberate');

const confirmations = page.getByRole('button', { name: /usuń|usun|tak|potwierdź|potwierdz/i }).filter({ visible: true });
if (await confirmations.count() === 0) throw new Error('delete confirmation button not found');
await humanClickLocator(page, confirmations.last());
await humanIdlePause('long');

console.log(JSON.stringify({ deleted: true, beforeCount: before.length, after: await rows() }, null, 2));
process.exit(0);
