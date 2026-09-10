// Read-only row count for NEW NCBR section 4.1. Does not close page.

import { chromium } from 'playwright';
import { humanIdlePause } from '../../../dist/human/mouse.js';

const endpoint = process.env.NCBR_CDP_ENDPOINT || 'http://127.0.0.1:9223';
const SECTION_URL = 'https://lsi2.ncbr.gov.pl/projekt/7ee80d9a-67dd-4d99-becd-8dda407221c1/projekt_step/5af236aa-03b2-4650-b5a2-95c299dfeeaf';

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) { console.log(JSON.stringify({ error: 'NO_PAGE' })); process.exit(0); }

await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
await humanIdlePause('long');
const out = await page.evaluate(() => {
  const body = document.body.innerText || '';
  const tables = Array.from(document.querySelectorAll('table')).map((table, i) => ({
    i,
    rows: table.querySelectorAll('tbody tr').length,
    text: Array.from(table.querySelectorAll('tbody tr')).map((r) => r.innerText.trim().replace(/\s+/g, ' ').slice(0, 160)),
  }));
  return {
    url: location.href,
    tables,
    names: {
      linh: body.includes('Linh Le'),
      lb: body.includes('Łukasz Bartoszcze'),
      szpruch: body.includes('Łukasz Szpruch'),
      pernak: body.includes('Weronika Pernak'),
      zuza: body.includes('Zuzanna Bartoszcze'),
    },
  };
});
console.log(JSON.stringify(out, null, 2));
process.exit(0);
