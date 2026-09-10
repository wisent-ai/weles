// Section 1.3 cleanup: delete the second duplicate "Opis dzialalnosci" row only.
// UI-only. Never closes the page and never submits.

import { chromium } from 'playwright';
import { humanClickLocator, humanIdlePause } from '../../../../../dist/human/mouse.js';
import { humanFill } from '../../../../../dist/human/keyboard.js';

const endpoint = process.env.NCBR_CDP_ENDPOINT || 'http://127.0.0.1:9223';
const SECTION_URL = 'https://lsi2.ncbr.gov.pl/projekt/7ee80d9a-67dd-4d99-becd-8dda407221c1/projekt_step/317a21dd-e798-4115-ab53-6ab5a2912fb0';

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) { console.log(JSON.stringify({ error: 'NO_PAGE' })); process.exit(0); }
page.setDefaultTimeout(10000);

await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
await humanIdlePause('long');
await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll('div')).find((d) => (d.innerText || '').includes('pliki cookies'));
  if (b) b.style.pointerEvents = 'none';
}); // allow-raw-playwright: neutralise cookie banner overlay only

async function activityRows() {
  return page.evaluate(() => {
    const table = document.querySelectorAll('table')[2];
    if (!table) return [];
    return Array.from(table.querySelectorAll('tbody tr'))
      .filter((r) => r.querySelector('button[aria-label="overflow-options"]'))
      .map((r) => r.innerText.trim().replace(/\s+/g, ' '));
  }); // allow-raw-playwright: read table state
}

const before = await activityRows();
if (before.length <= 1) {
  console.log(JSON.stringify({ before, deleted: false, note: 'no duplicate activity rows' }, null, 2));
  process.exit(0);
}

const activityTable = page.locator('table').nth(2);
const duplicateRow = activityTable.locator('tbody tr').filter({ has: page.locator('button[aria-label="overflow-options"]') }).nth(1);
await humanClickLocator(page, duplicateRow.locator('button[aria-label="overflow-options"]'));
await humanIdlePause('deliberate');

const deleteItem = page.locator('[role="menuitem"], .MuiMenuItem-root').filter({ hasText: /usuń|usun/i }).first();
await humanClickLocator(page, deleteItem);
await humanIdlePause('deliberate');

const confirmDelete = page.getByRole('button', { name: /usuń|usun|tak|potwierdź|potwierdz/i }).filter({ visible: true }).last();
await humanClickLocator(page, confirmDelete);
await humanIdlePause('long');

console.log(JSON.stringify({ before, deleted: true, after: await activityRows() }, null, 2));
process.exit(0);
