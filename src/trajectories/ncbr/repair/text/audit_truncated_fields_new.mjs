// Read-only audit of fields that look mechanically truncated in the replacement NCBR draft.
// Never writes or submits.

import { chromium } from 'playwright';
import { pageSettled } from '../../../_shared/page/settled.mjs';

const endpoint = (await import('#ncbr-settings')).cdpEndpoint();
const projectId = (await import('#ncbr-settings')).projectId();
const projectUrl = ['https://', `lsi2.ncbr.gov.pl/projekt/${projectId}`].join('');

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) {
  console.log(JSON.stringify({ error: 'NO_PAGE' }, null, 2));
  process.exit(1);
}


await page.goto(projectUrl, { waitUntil: 'domcontentloaded' }); // allow-raw-playwright: read-only navigation
await pageSettled(page);

const urls = await page.evaluate(() => {
  const out = new Set();
  for (const a of document.querySelectorAll('a[href*="/projekt_step/"], [href*="/projekt_step/"]')) {
    const href = a.href || a.getAttribute('href');
    if (href) out.add(new URL(href, location.href).href);
  }
  return Array.from(out);
}); // allow-raw-playwright: read visible section links only

if (!urls.length) {
  throw new Error(`${projectUrl} lists no projekt_step links: the audit reads the sections the project page shows and assumes none`);
}
const directUrls = urls;

function looksComplete(value) {
  const v = (value || '').trim();
  if (!v) return true;
  return /[.!?…:;)"”\]]$/.test(v);
}

const nearLimit = [];
const scanned = [];
for (const url of directUrls) {
  await page.goto(url, { waitUntil: 'domcontentloaded' }); // allow-raw-playwright: read-only section navigation
  await page.locator('input:not([name="table_search"]), textarea').filter({ visible: true }).first().waitFor({ state: 'visible' });
  await pageSettled(page);
  const fields = await page.evaluate(() => {
    const labelFor = (el) => {
      if (el.id) {
        const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lab) return lab.textContent.trim();
      }
      // The nearest label within the field's own group; a label above the first
      // ancestor holding another field names that field, not this one.
      for (let node = el.parentElement; node; node = node.parentElement) {
        const lab = node.querySelector('label, .MuiFormLabel-root, legend');
        if (lab?.textContent) return lab.textContent.trim();
        if (Array.from(node.querySelectorAll('input, textarea, select')).some((f) => f !== el)) break;
      }
      return '';
    };
    return Array.from(document.querySelectorAll('input, textarea')).map((el) => {
      const name = el.getAttribute('name') || '';
      const value = el.value || '';
      const max = Number(el.getAttribute('maxlength')) || null;
      return {
        tag: el.tagName,
        name,
        label: labelFor(el),
        max,
        len: value.length,
        suffix: value.slice(-260),
        value,
      };
    }).filter((f) => f.name && f.name !== 'table_search' && f.len > 0);
  }); // allow-raw-playwright: read field values only
  scanned.push({ url, fieldCount: fields.length });
  for (const f of fields) {
    const ratio = f.max ? f.len / f.max : 0;
    const near = f.max && (f.len >= f.max - 20 || ratio >= 0.97);
    const incomplete = !looksComplete(f.value);
    if (near || incomplete) {
      nearLimit.push({
        url,
        name: f.name,
        label: f.label,
        len: f.len,
        max: f.max,
        near,
        incomplete,
        suffix: f.suffix,
      });
    }
  }
}

console.log(JSON.stringify({ scanned, findings: nearLimit }, null, 2));
process.exit(0);
