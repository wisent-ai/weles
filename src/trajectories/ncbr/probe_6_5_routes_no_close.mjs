import { chromium } from 'playwright';

const endpoint = process.env.NCBR_BROWSER_ENDPOINT || 'http://127.0.0.1:9223';
const browser = await chromium.connectOverCDP(endpoint);
const context = browser.contexts()[0] || await browser.newContext();
const page = context.pages()[0] || await context.newPage();

const BASE = 'https://lsi2.ncbr.gov.pl';
const VERSION_ID = 'a11cf7c9-9306-4ac6-a43a-7048789ce0ff';
const SECTION_ID = 'bdb2c7b3-92d9-4778-9ecc-b4c5bda7d32b';
const COLLECTION = 'koszty_posrednie_kolekcja';
const prefix = `${BASE}/api/beneficiary/project-versions/${VERSION_ID}/project-sections/${SECTION_ID}`;
const reg = `${prefix}/registries-values`;

const urls = [
  reg,
  `${reg}?pagination=false`,
  `${reg}/${COLLECTION}`,
  `${reg}/${COLLECTION}?pagination=false`,
  `${reg}/${COLLECTION}/collection-objects`,
  `${reg}/${COLLECTION}/collection-objects/`,
  `${reg}/${COLLECTION}/collection-objects?pagination=false`,
  `${reg}/${COLLECTION}/collection-objects?itemsPerPage=200&page=1`,
  `${reg}/${COLLECTION}/collection-objects.json`,
  `${reg}/${COLLECTION}/collection-objects/list`,
  `${prefix}/collection-objects/${COLLECTION}`,
  `${prefix}/collection-objects/${COLLECTION}?pagination=false`,
  `${BASE}/api/beneficiary/project-versions/${VERSION_ID}/registries-values/${COLLECTION}/collection-objects`,
  `${BASE}/api/beneficiary/project-versions/${VERSION_ID}/project-registries/${SECTION_ID}/${COLLECTION}`,
  `${BASE}/api/beneficiary/project-versions/${VERSION_ID}/project-registries/${SECTION_ID}/${COLLECTION}/collection-objects`,
];

const results = [];
for (const url of urls) {
  for (const method of ['OPTIONS', 'HEAD', 'GET']) {
    const res = await page.evaluate(async ({ url, method }) => {
      try {
        const r = await fetch(url, {
          method,
          credentials: 'include',
          headers: { Accept: 'application/json' },
        });
        const text = method === 'HEAD' ? '' : await r.text();
        return {
          method,
          url,
          status: r.status,
          statusText: r.statusText,
          allow: r.headers.get('allow'),
          contentType: r.headers.get('content-type'),
          text: text.slice(0, 1500),
        };
      } catch (error) {
        return { method, url, error: String(error?.message || error) };
      }
    }, { url, method });
    results.push(res);
  }
}

console.log(JSON.stringify(results, null, 2));
process.exit(0);
