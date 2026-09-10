// Read-only inspector for replacement NCBR draft Dokumenty tab. Never uploads or submits.

import { chromium } from 'playwright';
import { humanClickLocator, humanIdlePause } from '../../../dist/human/mouse.js';
import { writeFileSync } from 'node:fs';

const endpoint = process.env.NCBR_CDP_ENDPOINT || 'http://127.0.0.1:9223';
const projectId = process.env.NCBR_PROJECT_ID || '7ee80d9a-67dd-4d99-becd-8dda407221c1';
const projectUrl = `https://lsi2.ncbr.gov.pl/projekt/${projectId}`;

const browser = await chromium.connectOverCDP(endpoint);
const context = browser.contexts()[0];
const page = context?.pages().find((candidate) => candidate.url().startsWith('https://lsi2.ncbr.gov.pl/'))
  || (context ? await context.newPage() : null);
if (!page) {
  console.log(JSON.stringify({ error: 'NO_PAGE' }, null, 2));
  process.exit(1);
}
page.setDefaultTimeout(15000);

if (!process.env.CURRENT_VIEW) {
await page.goto(projectUrl, { waitUntil: 'domcontentloaded' }); // allow-raw-playwright: read-only navigation
await humanIdlePause('long');

const viewLabel = process.env.VIEW_LABEL || 'Dokumenty';
const documents = page.getByText(viewLabel, { exact: true }).filter({ visible: true }).first();
if (await documents.count() === 0) throw new Error(`${viewLabel} control not found at ${page.url()}`);
await documents.click(); // allow-raw-playwright: read-only project-view navigation with hit testing
await humanIdlePause('long');
if (process.env.OPEN_PROJECT_MENU || process.env.OPEN_PDF_VERSIONS) {
  await page.locator('#overflow-button').click();
  await humanIdlePause('short');
  if (process.env.OPEN_PDF_VERSIONS) {
    await page.getByText('PDF i wersje wniosku', { exact: true }).click();
    await humanIdlePause('long');
    if (process.env.DOWNLOAD_CURRENT_PDF) {
      const row = page.getByText('Wersja B (najnowsza)', { exact: true })
        .locator('xpath=ancestor::*[.//a[normalize-space()="Pobierz PDF"]][1]');
      if (await row.count() !== 1 || await row.getByText('Pobierz PDF', { exact: true }).count() !== 1) throw new Error('The latest application version was not uniquely identified');
      await row.getByText('Pobierz PDF', { exact: true }).click();
    }
  }
}

if (process.env.OPEN_FIRST_ROW_MENU) {
  const menu = page.locator('button[aria-label*="overflow-options"], [role="button"][aria-label*="overflow-options"]').first();
  if (await menu.count() === 0) throw new Error('no row overflow menu found');
  await humanClickLocator(page, menu);
  await humanIdlePause('deliberate');
  if (process.env.OPEN_EDIT) {
    const item = page.locator('li, button, [role="menuitem"]').filter({ hasText: /edytuj|szczegó|podgląd|otwórz/i }).first();
    if (await item.count() === 0) throw new Error('no edit/detail menu item found');
    await humanClickLocator(page, item);
    await humanIdlePause('long');
  }
}
}
if (process.env.TEXT_PATH) {
  writeFileSync(process.env.TEXT_PATH, await page.locator('body').innerText());
}
if (process.env.DOWNLOAD_CURRENT_PDF) {
  // The in-app viewer renders the whole application before its download button appears; the download itself
  // starts only after the server has assembled the PDF, so both waits get a minute rather than the page default.
  const button = page.getByRole('button', { name: 'Pobierz PDF', exact: true }).filter({ visible: true });
  await button.waitFor({ state: 'visible', timeout: 60_000 });
  const pending = page.waitForEvent('download', { timeout: 60_000 });
  await button.click();
  const download = await pending;
  await download.saveAs(process.env.DOWNLOAD_CURRENT_PDF);
  const failure = await download.failure();
  if (failure) throw new Error(`Current application PDF download failed: ${failure}`);
  console.error(`Saved latest application PDF: ${process.env.DOWNLOAD_CURRENT_PDF}`);
}

const out = await page.evaluate(() => {
  const visibleText = (document.body.innerText || '').slice(0, 16000);
  const buttons = Array.from(document.querySelectorAll('button, [role="button"], a')).map((e) => ({
    text: (e.textContent || e.getAttribute('aria-label') || e.getAttribute('title') || '').trim().replace(/\s+/g, ' ').slice(0, 180),
    tag: e.tagName,
    href: e.href || e.getAttribute('href') || null,
    disabled: Boolean(e.disabled || e.getAttribute('aria-disabled') === 'true'),
  })).filter((e) => e.text || e.href).slice(0, 160);
  const inputs = Array.from(document.querySelectorAll('input, textarea, select')).map((e) => {
    const label = e.id ? document.querySelector(`label[for="${CSS.escape(e.id)}"]`)?.textContent?.trim() : null;
    const wrap = e.closest('label, .MuiFormControl-root, .MuiBox-root, .MuiCard-root, section, form');
    return {
      tag: e.tagName,
      type: e.type || null,
      name: e.name || null,
      accept: e.accept || null,
      multiple: Boolean(e.multiple),
      value: (e.value || '').slice(0, 120),
      label,
      nearby: wrap ? wrap.textContent.trim().replace(/\s+/g, ' ').slice(0, 500) : null,
    };
  }).filter((e) => e.name || e.type === 'file' || e.label || e.nearby).slice(0, 120);
  const links = Array.from(document.querySelectorAll('a[href]')).map((a) => ({ text: a.textContent.trim().replace(/\s+/g, ' ').slice(0, 160), href: a.href })).slice(0, 80);
  return { url: location.href, visibleText, buttons, inputs, links };
}); // allow-raw-playwright: read-only DOM inspection
if (process.env.SCREENSHOT_PATH) {
  await page.screenshot({ path: process.env.SCREENSHOT_PATH, fullPage: true });
}

console.log(JSON.stringify(out, null, 2));
process.exit(0);
