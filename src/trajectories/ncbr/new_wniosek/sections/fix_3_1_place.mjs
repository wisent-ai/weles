// Repair section 3.1 existing implementation row: fill required implementation place. UI-only.

import { chromium } from 'playwright';
import { humanClickLocator, humanIdlePause } from '../../../../../dist/human/mouse.js';
import { humanFill } from '../../../../../dist/human/keyboard.js';

const endpoint = process.env.NCBR_CDP_ENDPOINT || 'http://127.0.0.1:9223';
const SECTION_URL = 'https://lsi2.ncbr.gov.pl/projekt/7ee80d9a-67dd-4d99-becd-8dda407221c1/projekt_step/574f07ed-d631-4536-bfd0-e1f7e469415c';

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) { console.log(JSON.stringify({ error: 'NO_PAGE' })); process.exit(0); }
page.setDefaultTimeout(10000);

await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
await humanIdlePause('long');
await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll('div')).find((d) => (d.innerText || '').includes('pliki cookies'));
  if (b) b.style.pointerEvents = 'none';
}); // allow-raw-playwright: neutralise cookie banner

async function editExistingRow() {
  const row = page.locator('table tbody tr').filter({ hasText: 'Wisent Polska' }).first();
  await row.locator('button[aria-label="overflow-options"]').first().dispatchEvent('click'); // allow-raw-playwright: open row menu
  await humanIdlePause('deliberate');
  await page.getByRole('menuitem', { name: 'Edytuj', exact: true }).first().dispatchEvent('click'); // allow-raw-playwright: edit row
  await humanIdlePause('long');
}

await editExistingRow();
await page.waitForSelector('input, textarea');

if (process.env.DIAG) {
  const input = page.locator('input[name$="miejsce_wdrozenia_wynikow_projektu"]').first();
  if (await input.count() > 0) {
    await humanClickLocator(page, input);
    await humanIdlePause('deliberate');
  }
  const dump = await page.evaluate(() => ({
    fields: Array.from(document.querySelectorAll('input, textarea')).map((el) => ({
      tag: el.tagName,
      type: el.getAttribute('type') || null,
      name: el.getAttribute('name') || null,
      role: el.getAttribute('role') || null,
      value: (el.value || '').slice(0, 80),
      max: el.getAttribute('maxlength') || null,
    })).filter((f) => f.name),
    options: Array.from(document.querySelectorAll("[role='listbox'] [role='option']")).map((o) => o.textContent.trim()).slice(0, 20),
    buttons: Array.from(document.querySelectorAll('button')).map((b) => b.innerText.trim()).filter(Boolean),
  }));
  console.log(JSON.stringify(dump, null, 2));
  process.exit(0);
}

async function pickPlace(search) {
  const input = page.locator('input[name$="miejsce_wdrozenia_wynikow_projektu"]').first();
  await humanClickLocator(page, input);
  await humanFill(page, input, search);
  await humanIdlePause('deliberate');
  const opt = page.locator("[role='listbox'] [role='option']").first();
  if (await opt.count() === 0) throw new Error(`no place option for ${search}`);
  const text = (await opt.textContent())?.trim();
  await opt.dispatchEvent('click'); // allow-raw-playwright: pick place option
  await humanIdlePause('short');
  return text;
}

const picked = [];
picked.push(await pickPlace('na terenie RP'));
picked.push(await pickPlace('na terenie innego'));
await humanIdlePause('deliberate');
await humanIdlePause('deliberate');
let saveResult = 'saved';
try {
  const saves = page.getByRole('button', { name: 'Zapisz', exact: true }).filter({ visible: true });
  const saveCount = await saves.count();
  if (!saveCount) throw new Error('no enabled Zapisz');
  await humanClickLocator(page, saves.nth(saveCount - 1));
  await humanIdlePause('long');
} catch (e) {
  saveResult = `NOT SAVED: ${String(e?.message || e).slice(0, 80)}`;
}

const readback = await page.evaluate(() => {
  const table = document.querySelector('table');
  return { text: (table?.innerText || '').replace(/\s+/g, ' ').slice(0, 1200) };
});
console.log(JSON.stringify({ saveResult, picked, readback }, null, 2));
process.exit(0);
