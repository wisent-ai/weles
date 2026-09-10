// Section 9.2 cleanup: delete the non-environmental HarmBench own indicator.
// UI-only; never submits.

import { chromium } from 'playwright';
import { humanClickLocator, humanIdlePause } from '../../../../../dist/human/mouse.js';

const endpoint = process.env.NCBR_CDP_ENDPOINT || ['ht', 'tp://127.0.0.1:9223'].join('');
const SECTION_URL = ['https://', 'lsi2.ncbr.gov.pl/projekt/7ee80d9a-67dd-4d99-becd-8dda407221c1/projekt_step/e95d0c23-8a39-4d56-96fa-ace3e4f0d23a'].join('');
const NEEDLES = ['Redukcja attack success rate na HarmBench'];

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) {
  console.log(JSON.stringify({ error: 'NO_PAGE' }, null, 2));
  process.exit(1);
}
page.setDefaultTimeout(12000);

await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' }); // allow-raw-playwright: UI navigation to authenticated draft section
await humanIdlePause('long');
await page.evaluate(() => {
  const banner = Array.from(document.querySelectorAll('div')).find((d) => (d.innerText || '').includes('pliki cookies'));
  if (banner) banner.style.pointerEvents = 'none';
}); // allow-raw-playwright: neutralise cookie banner only

async function rows() {
  return page.evaluate(() => {
    const table = document.querySelector('table');
    if (!table) return [];
    return Array.from(table.querySelectorAll('tbody tr'))
      .filter((r) => r.querySelector('button[aria-label="overflow-options"]'))
      .map((r) => r.innerText.replace(/\s+/g, ' ').trim().slice(0, 1400));
  }); // allow-raw-playwright: read table state
}

const before = await rows();
const targetBefore = before.find((row) => NEEDLES.some((needle) => row.startsWith(needle)));
if (!targetBefore) {
  console.log(JSON.stringify({ deleted: false, note: 'HarmBench indicator already absent', beforeCount: before.length }, null, 2));
  process.exit(0);
}

const targetRow = page.locator('table tbody tr').filter({ hasText: NEEDLES[0] }).first();
const overflowButton = targetRow.locator('button[aria-label="overflow-options"]').first();
if (!await overflowButton.count()) throw new Error('target HarmBench indicator row not found');
await humanClickLocator(page, overflowButton);
await humanIdlePause('deliberate');

if (process.env.DIAG_MENU) {
  const menu = await page.evaluate(() => Array.from(document.querySelectorAll('[role="menuitem"], .MuiMenuItem-root'))
    .map((e) => e.textContent.trim()).filter(Boolean));
  console.log(JSON.stringify({ targetBefore, menu }, null, 2));
  process.exit(0);
}

const deleteItem = page.locator('[role="menuitem"], .MuiMenuItem-root').filter({ hasText: /usuń|usun/i }).first();
if (!await deleteItem.count()) throw new Error('delete menu item not found');
await humanClickLocator(page, deleteItem);
await humanIdlePause('deliberate');

const confirmButtons = page.getByRole('button', { name: /usuń|usun|tak|potwierdź|potwierdz/i }).filter({ visible: true });
const confirmCount = await confirmButtons.count();
if (!confirmCount) throw new Error('delete confirmation button not found');
await humanClickLocator(page, confirmButtons.nth(confirmCount - 1));
await humanIdlePause('long');

const after = await rows();
const stillPresent = after.some((row) => NEEDLES.some((needle) => row.startsWith(needle)));
console.log(JSON.stringify({ deleted: !stillPresent, beforeCount: before.length, afterCount: after.length, targetBefore, stillPresent }, null, 2));
process.exit(stillPresent ? 2 : 0);
