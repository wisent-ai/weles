// Deletes rows from premium sections 5.1/5.2 when standalone project validation requires emptiness.
// UI-only, no direct API writes. Never submits and never closes the page.

import { chromium } from 'playwright';
import { humanIdlePause } from '../../../../../dist/human/mouse.js';

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
  await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('table tbody tr'));
    const row = rows.find((r) => r.querySelector('button[aria-label="overflow-options"]'));
    if (!row) throw new Error('no data row');
    row.querySelector('button[aria-label="overflow-options"]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }); // allow-raw-playwright: open row menu
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
  const clicked = await page.evaluate(() => {
    const item = Array.from(document.querySelectorAll('[role="menuitem"], .MuiMenuItem-root'))
      .find((e) => /usuń|usun/i.test(e.textContent || ''));
    if (!item) return false;
    item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return true;
  }); // allow-raw-playwright: choose delete action from row menu
  if (!clicked) throw new Error('delete menu item not found');
  await humanIdlePause('deliberate');
  await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button')).filter((b) =>
      /usuń|usun|tak|potwierdź|potwierdz/i.test(b.innerText || '') && !b.disabled && b.getClientRects().length);
    if (buttons.length) buttons[buttons.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }); // allow-raw-playwright: confirm deletion dialog
  await humanIdlePause('long');
  deleted.push(SECTION);
}

console.log(JSON.stringify({ section: SECTION, deleted: deleted.length, rows: await rowCount() }, null, 2));
process.exit(0);
