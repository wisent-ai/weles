// Inspect current NCBR login form state without printing credentials and without closing the browser.
import { chromium } from 'playwright';

const endpoint = process.env.NCBR_BROWSER_ENDPOINT || 'http://127.0.0.1:9223';
const browser = await chromium.connectOverCDP(endpoint);
const context = browser.contexts()[0];
const page = context?.pages()[0];

if (!page) {
  console.log(JSON.stringify({ error: 'NO_PAGE' }, null, 2));
  process.exit(0);
}

const result = await page.evaluate(() => {
  const fields = Array.from(document.querySelectorAll('input, textarea, select')).map((el) => ({
    tag: el.tagName.toLowerCase(),
    type: el.getAttribute('type'),
    name: el.getAttribute('name'),
    id: el.id || null,
    checked: el instanceof HTMLInputElement && ['checkbox', 'radio'].includes(el.type) ? el.checked : undefined,
    valueLength: 'value' in el ? String(el.value || '').length : null,
    disabled: el.disabled === true,
    ariaInvalid: el.getAttribute('aria-invalid'),
  }));
  const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"]')).map((el) => ({
    tag: el.tagName.toLowerCase(),
    type: el.getAttribute('type'),
    text: (el.innerText || el.value || '').trim(),
    disabled: el.disabled === true,
    ariaDisabled: el.getAttribute('aria-disabled'),
    id: el.id || null,
    className: el.className || null,
  }));
  return {
    href: location.href,
    title: document.title,
    fields,
    buttons,
    bodyText: (document.body?.innerText || '').slice(0, 1600),
  };
});

console.log(JSON.stringify(result, null, 2));
process.exit(0);
