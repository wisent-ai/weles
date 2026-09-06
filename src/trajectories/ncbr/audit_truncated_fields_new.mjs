// Read-only audit of fields that look mechanically truncated in the replacement NCBR draft.
// Never writes or submits.

import { chromium } from 'playwright';
import { humanIdlePause } from '../../../dist/human/mouse.js';

const endpoint = process.env.NCBR_CDP_ENDPOINT || ['ht', 'tp://127.0.0.1:9223'].join('');
const projectId = process.env.NCBR_PROJECT_ID || '7ee80d9a-67dd-4d99-becd-8dda407221c1';
const projectUrl = ['https://', `lsi2.ncbr.gov.pl/projekt/${projectId}`].join('');

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) {
  console.log(JSON.stringify({ error: 'NO_PAGE' }, null, 2));
  process.exit(1);
}
page.setDefaultTimeout(15000);

await page.goto(projectUrl, { waitUntil: 'domcontentloaded' }); // allow-raw-playwright: read-only navigation
await humanIdlePause('long');

const urls = await page.evaluate(() => {
  const out = new Set();
  for (const a of document.querySelectorAll('a[href*="/projekt_step/"], [href*="/projekt_step/"]')) {
    const href = a.href || a.getAttribute('href');
    if (href) out.add(new URL(href, location.href).href);
  }
  return Array.from(out);
}); // allow-raw-playwright: read visible section links only

const directUrls = urls.length ? urls : [
  `${projectUrl}/projekt_step/71acd162-e35d-4aff-88a6-ea2fe179a259`,
  `${projectUrl}/projekt_step/0ca77e3d-373e-464f-9e9d-a35f5193864d`,
  `${projectUrl}/projekt_step/c048ab30-3dda-4228-bf71-4ec6904cffda`,
  `${projectUrl}/projekt_step/80ebca16-a9dd-4798-a334-5ac007cecbf7`,
  `${projectUrl}/projekt_step/c5dbdc83-5baf-4866-b3d8-4da3ae553865`,
  `${projectUrl}/projekt_step/94fb1adb-38a5-4949-b4c1-b0a79472bfd3`,
  `${projectUrl}/projekt_step/06a70163-2dcc-47a0-b64b-201656946538`,
  `${projectUrl}/projekt_step/bb231ac1-d863-41a8-89a7-88c1db3a1bd7`,
  `${projectUrl}/projekt_step/836f13ca-f474-4d5c-8388-6afd84eaf353`,
  `${projectUrl}/projekt_step/41b2184d-76e9-4b79-8ece-b2e227dc471f`,
  `${projectUrl}/projekt_step/4e260fae-c455-41ce-bba3-d0df2a8767fd`,
];

function looksComplete(value) {
  const v = (value || '').trim();
  if (!v) return true;
  return /[.!?…:;)"”\]]$/.test(v);
}

const nearLimit = [];
const scanned = [];
for (const url of directUrls) {
  await page.goto(url, { waitUntil: 'domcontentloaded' }); // allow-raw-playwright: read-only section navigation
  await humanIdlePause('long');
  await page.waitForSelector('input, textarea').catch(() => {}); // allow-raw-playwright: wait for fields before read
  const fields = await page.evaluate(() => {
    const labelFor = (el) => {
      if (el.id) {
        const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lab) return lab.textContent.trim();
      }
      let node = el;
      for (let i = 0; i < 6 && node; i += 1) {
        node = node.parentElement;
        const lab = node?.querySelector?.('label, .MuiFormLabel-root, legend');
        if (lab?.textContent) return lab.textContent.trim();
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
        label: labelFor(el).slice(0, 160),
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
