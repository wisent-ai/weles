// Section 9.2 cleanup: delete the obsolete audit-completeness own indicator.
// UI-only; never submits.

import { chromium } from 'playwright';
import { humanClickLocator, humanIdlePause } from '../../../../../dist/human/mouse.js';

const endpoint = process.env.NCBR_CDP_ENDPOINT || ['ht', 'tp://127.0.0.1:9223'].join('');
const SECTION_URL = ['https://', 'lsi2.ncbr.gov.pl/projekt/7ee80d9a-67dd-4d99-becd-8dda407221c1/projekt_step/e95d0c23-8a39-4d56-96fa-ace3e4f0d23a'].join('');
const NEEDLES = [
  'Kompletność strukturalnego raportu audytowego',
  'procent kompletności',
  'strukturalnego raportu audytowego decyzji modelu RNM',
];

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

async function rows() {
  return page.evaluate(() => {
    const table = document.querySelector('table');
    if (!table) return [];
    return Array.from(table.querySelectorAll('tbody tr'))
      .filter((r) => r.querySelector('button[aria-label="overflow-options"]'))
      .map((r) => r.innerText.replace(/\s+/g, ' ').trim().slice(0, 1200));
  }); // allow-raw-playwright: read table state
}

const before = await rows();
const targetBefore = before.find((row) => NEEDLES.some((needle) => row.includes(needle)));
if (!targetBefore) {
  console.log(JSON.stringify({ deleted: false, note: 'audit indicator already absent', beforeCount: before.length }, null, 2));
  process.exit(0);
}

const targetRow = page.locator('table tbody tr')
  .filter({ has: page.locator('button[aria-label="overflow-options"]') })
  .filter({ hasText: new RegExp(NEEDLES.map((needle) => needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')) })
  .first();
if (await targetRow.count() === 0) throw new Error('target audit indicator row not found');
await humanClickLocator(page, targetRow.locator('button[aria-label="overflow-options"]').first());
await humanIdlePause('deliberate');

const deleteItem = page.locator('[role="menuitem"], .MuiMenuItem-root')
  .filter({ hasText: /usuń|usun/i }).filter({ visible: true }).first();
if (await deleteItem.count() === 0) throw new Error('delete menu item not found');
await humanClickLocator(page, deleteItem);
await humanIdlePause('deliberate');

const confirm = page.locator('button:not([disabled])')
  .filter({ hasText: /usuń|usun|tak|potwierdź|potwierdz/i })
  .filter({ visible: true }).last();
if (await confirm.count() === 0) throw new Error('delete confirmation button not found');
await humanClickLocator(page, confirm);
await humanIdlePause('long');

const after = await rows();
const stillPresent = after.some((row) => NEEDLES.some((needle) => row.includes(needle)));
console.log(JSON.stringify({ deleted: !stillPresent, beforeCount: before.length, afterCount: after.length, targetBefore, stillPresent }, null, 2));
process.exit(stillPresent ? 2 : 0);
