// Read-only inspector for replacement NCBR draft Dokumenty tab. Never uploads or submits.

import { chromium } from 'playwright';
import { humanIdlePause } from '../../../dist/human/mouse.js';

const endpoint = process.env.NCBR_CDP_ENDPOINT || 'http://127.0.0.1:9223';
const projectId = process.env.NCBR_PROJECT_ID || '7ee80d9a-67dd-4d99-becd-8dda407221c1';
const projectUrl = `https://lsi2.ncbr.gov.pl/projekt/${projectId}`;

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) {
  console.log(JSON.stringify({ error: 'NO_PAGE' }, null, 2));
  process.exit(1);
}
page.setDefaultTimeout(15000);

await page.goto(projectUrl, { waitUntil: 'domcontentloaded' }); // allow-raw-playwright: read-only navigation
await humanIdlePause('long');
await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll('div')).find((d) => (d.innerText || '').includes('pliki cookies'));
  if (b) b.style.pointerEvents = 'none';
}); // allow-raw-playwright: neutralise cookie overlay for read-only inspection

await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('button, a, [role="button"]')).find((e) => (e.textContent || '').trim() === 'Dokumenty');
  if (!btn) throw new Error('Dokumenty control not found');
  btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
}); // allow-raw-playwright: open Dokumenty tab for read-only inspection
await humanIdlePause('long');

if (process.env.OPEN_FIRST_ROW_MENU) {
  await page.evaluate(() => {
    const menu = Array.from(document.querySelectorAll('button, [role="button"]')).find((e) =>
      (e.textContent || e.getAttribute('aria-label') || '').trim().includes('overflow-options')
    );
    if (!menu) throw new Error('no row overflow menu found');
    menu.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }); // allow-raw-playwright: open saved document-row menu for inspection
  await humanIdlePause('deliberate');
  if (process.env.OPEN_EDIT) {
    await page.evaluate(() => {
      const item = Array.from(document.querySelectorAll('li, button, [role="menuitem"]')).find((e) =>
        /edytuj|szczegó|podgląd|otwórz/i.test((e.textContent || '').trim())
      );
      if (!item) throw new Error('no edit/detail menu item found');
      item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    }); // allow-raw-playwright: open saved document-row details for inspection
    await humanIdlePause('long');
  }
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

console.log(JSON.stringify(out, null, 2));
process.exit(0);
