// Deletes rows from premium sections 5.1/5.2 when standalone project validation requires emptiness.
// UI-only, no direct API writes. Never submits and never closes the page.

import { chromium } from 'playwright';
import { humanClickLocator, humanIdlePause } from '../../../../../dist/human/mouse.js';

const endpoint = process.env.NCBR_CDP_ENDPOINT || 'http://127.0.0.1:9223';
const PROJ = 'https://lsi2.ncbr.gov.pl/projekt/7ee80d9a-67dd-4d99-becd-8dda407221c1/projekt_step/';
const IDS = {
  '5.1': '557f18a2-ec63-44bf-a429-88dfde7444e4',
  '5.2': '01ba2656-83fd-44d0-8908-bb31034018b0',
};

const SECTION = process.env.SECTION;
if (!IDS[SECTION]) throw new Error(`SECTION must be one of ${Object.keys(IDS).join(', ')}`);

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) { console.log(JSON.stringify({ error: 'NO_PAGE' })); process.exit(0); }
page.setDefaultTimeout(10000);

await page.goto(PROJ + IDS[SECTION], { waitUntil: 'domcontentloaded' });
await humanIdlePause('long');
await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll('div')).find((d) => (d.innerText || '').includes('pliki cookies'));
  if (b) b.style.pointerEvents = 'none';
}); // allow-raw-playwright: neutralise cookie banner

async function rowCount() {
  return page.evaluate(() => Array.from(document.querySelectorAll('table tbody tr'))
    .filter((r) => r.querySelector('button[aria-label="overflow-options"]')).length);
}

async function openFirstRowMenu() {
  const menu = page.locator('table tbody tr')
    .filter({ has: page.locator('button[aria-label="overflow-options"]') })
    .first()
    .locator('button[aria-label="overflow-options"]')
    .first();
  if (await menu.count() === 0) throw new Error('no data row');
  await humanClickLocator(page, menu);
  await humanIdlePause('deliberate');
}

if (process.env.DIAG) {
  await openFirstRowMenu();
  const menu = await page.evaluate(() => Array.from(document.querySelectorAll('[role="menuitem"], .MuiMenuItem-root'))
    .map((e) => e.textContent.trim()).filter(Boolean));
  console.log(JSON.stringify({ section: SECTION, rows: await rowCount(), menu }, null, 2));
  process.exit(0);
}

const deleted = [];
while (await rowCount() > 0) {
  await openFirstRowMenu();
  const item = page.getByRole('menuitem', { name: /usuń|usun/i }).first();
  const clicked = await item.count() > 0;
  if (clicked) await humanClickLocator(page, item);
  if (!clicked) throw new Error('delete menu item not found');
  await humanIdlePause('deliberate');
  const buttons = page.getByRole('button', { name: /^(usuń|usun|tak|potwierdź|potwierdz)$/i })
    .filter({ visible: true });
  const count = await buttons.count();
  if (count > 0) await humanClickLocator(page, buttons.nth(count - 1));
  await humanIdlePause('long');
  deleted.push(SECTION);
}

console.log(JSON.stringify({ section: SECTION, deleted: deleted.length, rows: await rowCount() }, null, 2));
process.exit(0);
