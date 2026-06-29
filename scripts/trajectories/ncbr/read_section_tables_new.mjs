// Read-only table dump for a NEW NCBR section. SECTION_URL env required.

import { chromium } from 'playwright';
import { humanIdlePause } from '../../../dist/human/mouse.js';

const endpoint = process.env.NCBR_CDP_ENDPOINT || 'http://127.0.0.1:9223';
const url = process.env.SECTION_URL;
if (!url) throw new Error('SECTION_URL required');

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) { console.log(JSON.stringify({ error: 'NO_PAGE' })); process.exit(0); }

await page.goto(url, { waitUntil: 'domcontentloaded' });
await humanIdlePause('long');
const bodyLimit = Number(process.env.BODY_LIMIT || 2500);
const rowLimit = Number(process.env.ROW_LIMIT || 220);
const includeHtml = Boolean(process.env.HTML);
const out = await page.evaluate(({ limit, rowLimit, includeHtml }) => ({
  url: location.href,
  body: (document.body.innerText || '').slice(0, limit),
  tables: Array.from(document.querySelectorAll('table')).map((table, i) => ({
    i,
    rows: table.querySelectorAll('tbody tr').length,
    text: Array.from(table.querySelectorAll('tbody tr')).map((r) => r.innerText.trim().replace(/\s+/g, ' ').slice(0, rowLimit)),
    html: includeHtml ? Array.from(table.querySelectorAll('tbody tr')).map((r) => r.outerHTML.slice(0, 1200)) : undefined,
  })),
}), { limit: bodyLimit, rowLimit, includeHtml });
console.log(JSON.stringify(out, null, 2));
process.exit(0);
