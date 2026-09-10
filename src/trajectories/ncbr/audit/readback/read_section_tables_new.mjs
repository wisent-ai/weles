// Read-only table dump for a NEW NCBR section. SECTION_URL env required.

import { chromium } from 'playwright';
import { humanIdlePause } from '../../../../../dist/human/mouse.js';

const endpoint = process.env.NCBR_CDP_ENDPOINT || 'http://127.0.0.1:9223';
const url = process.env.SECTION_URL;
if (!url) throw new Error('SECTION_URL required');

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) { console.log(JSON.stringify({ error: 'NO_PAGE' })); process.exit(0); }

await page.goto(url, { waitUntil: 'domcontentloaded' });
await humanIdlePause('long');
if (process.env.NAV_LABEL) {
  await page.getByText(process.env.NAV_LABEL, { exact: true }).filter({ visible: true }).first().click();
  await humanIdlePause('long');
}
if (process.env.ROW_NEEDLE) {
  const table = page.locator('table').nth(Number(process.env.ROW_TABLE_INDEX || 0));
  await table.locator('tbody tr').first().waitFor({ state: 'visible' });
  // Cells are separate elements, so a needle spanning cells (a first and last name) must match the row's visible text.
  const rowTexts = await table.locator('tbody tr').evaluateAll((nodes) => nodes.map((node) => node.innerText.replace(/\s+/g, ' ').trim())); // allow-raw-playwright: read-only row texts
  const needle = process.env.ROW_NEEDLE.replace(/\s+/g, ' ').trim();
  const indexes = rowTexts.map((text, index) => (text.includes(needle) ? index : -1)).filter((index) => index >= 0);
  if (indexes.length !== 1) {
    throw new Error(`Expected one row matching ${needle}, matched ${indexes.length} of ${rowTexts.length}: ${JSON.stringify(rowTexts.map((text) => text.slice(0, 160)))}`);
  }
  const row = table.locator('tbody tr').nth(indexes[0]);
  await row.locator('button[aria-label*="overflow-options"]').dispatchEvent('click');
  const edit = page.getByRole('menuitem', { name: 'Edytuj', exact: true }).filter({ visible: true });
  await edit.waitFor({ state: 'visible' });
  await edit.dispatchEvent('click');
  await humanIdlePause('long');
}
const bodyLimit = Number(process.env.BODY_LIMIT || 2500);
const rowLimit = Number(process.env.ROW_LIMIT || 220);
const includeHtml = Boolean(process.env.HTML);
const out = await page.evaluate(({ limit, rowLimit, includeHtml }) => ({
  url: location.href,
  body: (document.body.innerText || '').slice(0, limit),
  fields: Array.from(document.querySelectorAll('textarea[name], input[name]:not([type="password"]):not([type="hidden"]), select[name]'))
    .filter((el) => el.name !== 'table_search')
    .map((el) => ({
      name: el.name,
      type: el.getAttribute('type'),
      value: el.value || '',
      checked: el.matches('input[type="checkbox"], input[type="radio"]') ? el.checked : undefined,
      muiChecked: el.matches('input[type="radio"]') ? el.closest('.MuiRadio-root')?.classList.contains('Mui-checked') : undefined,
    })),
  tables: Array.from(document.querySelectorAll('table')).map((table, i) => ({
    i,
    rows: table.querySelectorAll('tbody tr').length,
    text: Array.from(table.querySelectorAll('tbody tr')).map((r) => r.innerText.trim().replace(/\s+/g, ' ').slice(0, rowLimit)),
    html: includeHtml ? Array.from(table.querySelectorAll('tbody tr')).map((r) => r.outerHTML.slice(0, 1200)) : undefined,
  })),
}), { limit: bodyLimit, rowLimit, includeHtml });
if (process.env.SCREENSHOT_PATH) {
  await page.screenshot({ path: process.env.SCREENSHOT_PATH, fullPage: true });
}
console.log(JSON.stringify(out, null, 2));
if (process.env.ROW_NEEDLE) {
  await page.getByRole('button', { name: 'close side drawer', exact: true }).filter({ visible: true }).last().click();
}
process.exit(0);
