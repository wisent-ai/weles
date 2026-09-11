// The 10.4 table, bound to the page: reading it, opening a row by its needles or the
// outdated one, opening a row menu, deleting a row and adding a new one.
import { humanClickLocator, humanIdlePause } from '../../../../../../dist/human/mouse.js';

export function legalActsTable({ page }) {
async function tableState() {
  return page.evaluate(() => ({
    url: location.href,
    tables: Array.from(document.querySelectorAll('table')).map((table, index) => ({
      index,
      rows: Array.from(table.querySelectorAll('tbody tr')).map((row, rowIndex) => ({
        rowIndex,
        text: row.innerText.trim().replace(/\s+/g, ' ').slice(0, 1400),
        buttons: Array.from(row.querySelectorAll('button, [role="button"]')).map((button) => ({
          text: (button.textContent || '').trim(),
          aria: button.getAttribute('aria-label') || '',
        })),
      })),
    })),
  })); // allow-raw-playwright: read 10.4 table state only
}

async function openOutdatedRow() {
  const rows = page.locator('table tbody tr');
  let targetRow = null;
  for (let index = 0; index < await rows.count(); index += 1) {
    const candidate = rows.nth(index);
    if (/2010\/75|emisji przemys|BAT|efektywno/i.test(await candidate.innerText().catch(() => ''))) {
      targetRow = candidate;
      break;
    }
  }
  if (!targetRow) {
    const rowTexts = await rows.allTextContents();
    throw new Error(JSON.stringify({ opened: false, reason: 'target row not found', rows: rowTexts.map((text) => text.trim().replace(/\s+/g, ' ').slice(0, 300)) }));
  }
  const button = targetRow.locator('button[aria-label="overflow-options"], button, [role="button"]').first();
  if (await button.count() === 0) throw new Error(JSON.stringify({ opened: false, reason: 'row menu not found', row: (await targetRow.innerText()).trim().replace(/\s+/g, ' ') }));
  const row = (await targetRow.innerText()).trim().replace(/\s+/g, ' ').slice(0, 600);
  await humanClickLocator(page, button);
  await humanIdlePause('deliberate');
  const edit = page.getByRole('menuitem', { name: 'Edytuj', exact: true }).first();
  if (await edit.count() === 0) {
    const menu = await page.evaluate(() => Array.from(document.querySelectorAll('[role="menuitem"], li, button')).map((e) => (e.textContent || '').trim()).filter(Boolean).slice(0, 30)); // allow-raw-playwright: read visible menu labels
    throw new Error(`edit menu item not found: ${menu.join(' | ')}`);
  }
  await humanClickLocator(page, edit);
  await humanIdlePause('long');
  return { opened: true, row };
}

async function openRowByNeedle(needles) {
  const items = Array.isArray(needles) ? needles : [needles];
  const rows = page.locator('table tbody tr');
  let targetRow = null;
  for (let index = 0; index < await rows.count(); index += 1) {
    const candidate = rows.nth(index);
    const text = await candidate.innerText().catch(() => '');
    if (items.some((needle) => text.includes(needle))) {
      targetRow = candidate;
      break;
    }
  }
  if (!targetRow) {
    const rowTexts = await rows.allTextContents();
    throw new Error(JSON.stringify({ opened: false, reason: 'target row not found', needles: items, rows: rowTexts.map((text) => text.trim().replace(/\s+/g, ' ').slice(0, 300)) }));
  }
  const button = targetRow.locator('button[aria-label="overflow-options"], button, [role="button"]').first();
  if (await button.count() === 0) throw new Error(JSON.stringify({ opened: false, reason: 'row menu not found', row: (await targetRow.innerText()).trim().replace(/\s+/g, ' ') }));
  const row = (await targetRow.innerText()).trim().replace(/\s+/g, ' ').slice(0, 600);
  await humanClickLocator(page, button);
  await humanIdlePause('deliberate');
  await humanClickLocator(page, page.getByRole('menuitem', { name: 'Edytuj', exact: true }).first());
  await humanIdlePause('long');
  return { opened: true, row };
}

async function openMenuByNeedle(needles) {
  const items = Array.isArray(needles) ? needles : [needles];
  const rows = page.locator('table tbody tr');
  for (let index = 0; index < await rows.count(); index += 1) {
    const row = rows.nth(index);
    const text = await row.innerText().catch(() => '');
    if (!items.some((needle) => text.includes(needle))) continue;
    const button = row.locator('button[aria-label="overflow-options"], button, [role="button"]').first();
    if (await button.count() === 0) {
      return { opened: false, reason: 'row menu not found', row: text.trim().replace(/\s+/g, ' ') };
    }
    await humanClickLocator(page, button);
    await humanIdlePause('deliberate');
    return { opened: true, row: text.trim().replace(/\s+/g, ' ').slice(0, 600) };
  }
  return { opened: false, reason: 'target row not found', needles: items };
}

async function deleteRowByNeedle(needles) {
  const opened = await openMenuByNeedle(needles);
  if (!opened.opened) return { skipped: opened };
  const labels = await page.evaluate(() => Array.from(document.querySelectorAll('[role="menuitem"], li, button'))
    .map((el) => (el.textContent || '').trim())
    .filter(Boolean)
    .slice(0, 40)); // allow-raw-playwright: read visible menu labels
  const del = page.getByRole('menuitem', { name: /usuń|usun/i }).first();
  if (await del.count() === 0) return { opened, error: `delete menu item not found: ${labels.join(' | ')}` };
  await humanClickLocator(page, del);
  await humanIdlePause('deliberate');
  const buttons = page.getByRole('button', { name: /^(Usuń|Usun|Tak|Potwierdź|Potwierdz)$/i })
    .filter({ visible: true });
  const count = await buttons.count();
  const confirmed = count > 0
    ? { confirmed: true, label: (await buttons.nth(count - 1).innerText()).trim() }
    : { confirmed: false, labels: await page.locator('button').filter({ visible: true }).allTextContents() };
  if (count > 0) await humanClickLocator(page, buttons.nth(count - 1));
  await humanIdlePause('long');
  return { opened, labels, confirmed };
}

async function clickAdd() {
  const button = page.getByRole('button', { name: 'Dodaj', exact: true }).filter({ visible: true }).first();
  if (await button.count() === 0) throw new Error('enabled Dodaj not found');
  await humanClickLocator(page, button);
  await humanIdlePause('long');
}
  return { tableState, openOutdatedRow, openRowByNeedle, openMenuByNeedle, deleteRowByNeedle, clickAdd };
}
