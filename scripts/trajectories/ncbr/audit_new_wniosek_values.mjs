// Read-only audit for replacement NCBR draft field values. Never writes or submits.

import { chromium } from 'playwright';
import { humanIdlePause } from '../../../dist/human/mouse.js';

const endpoint = process.env.NCBR_CDP_ENDPOINT || 'http://127.0.0.1:9223';
const projectId = process.env.NCBR_PROJECT_ID || '7ee80d9a-67dd-4d99-becd-8dda407221c1';
const projectUrl = `https://lsi2.ncbr.gov.pl/projekt/${projectId}`;
const artifactRe = process.env.MARKDOWN_ARTIFACTS
  ? /(\*\*|^#{1,6}\s|\|---|<!--)/im
  : /\(?\s*limit\s*[\d ]*(?:znak[oó]w)?\)?/i;

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) {
  console.log(JSON.stringify({ error: 'NO_PAGE' }, null, 2));
  process.exit(1);
}
page.setDefaultTimeout(15000);

await page.goto(projectUrl, { waitUntil: 'domcontentloaded' }); // allow-raw-playwright: read-only navigation in authenticated LSI draft
await humanIdlePause('long');

const urls = await page.evaluate(() => {
  const out = new Set();
  for (const a of document.querySelectorAll('a[href*="/projekt_step/"], [href*="/projekt_step/"]')) {
    const href = a.href || a.getAttribute('href');
    if (href) out.add(new URL(href, location.href).href);
  }
  if (!out.size) {
    for (const node of document.querySelectorAll('[role="button"], button, a')) {
      const href = node.href || node.getAttribute?.('href');
      if (href && href.includes('/projekt_step/')) out.add(new URL(href, location.href).href);
    }
  }
  return Array.from(out);
}); // allow-raw-playwright: read visible project-step links

const directUrls = urls.length ? urls : [
  `${projectUrl}/projekt_step/71acd162-e35d-4aff-88a6-ea2fe179a259`,
  `${projectUrl}/projekt_step/0ca77e3d-373e-464f-9e9d-a35f5193864d`,
  `${projectUrl}/projekt_step/c048ab30-3dda-4228-bf71-4ec6904cffda`,
  `${projectUrl}/projekt_step/80ebca16-a9dd-4798-a334-5ac007cecbf7`,
  `${projectUrl}/projekt_step/c5dbdc83-5baf-4866-b3d8-4da3ae553865`,
  `${projectUrl}/projekt_step/94fb1adb-38a5-4949-b4c1-b0a79472bfd3`,
  `${projectUrl}/projekt_step/574f07ed-d631-4536-bfd0-e1f7e469415c`,
  `${projectUrl}/projekt_step/06a70163-2dcc-47a0-b64b-201656946538`,
  `${projectUrl}/projekt_step/bb231ac1-d863-41a8-89a7-88c1db3a1bd7`,
  `${projectUrl}/projekt_step/836f13ca-f474-4d5c-8388-6afd84eaf353`,
  `${projectUrl}/projekt_step/41b2184d-76e9-4b79-8ece-b2e227dc471f`,
  `${projectUrl}/projekt_step/23f89b24-922b-40a1-bc68-9193ce781210`,
  `${projectUrl}/projekt_step/95a9b43d-b789-479a-a60d-159b975af74d`,
  `${projectUrl}/projekt_step/77be8643-1e31-4619-b266-d156a5388cf6`,
  `${projectUrl}/projekt_step/4e260fae-c455-41ce-bba3-d0df2a8767fd`,
];

const hits = [];
const scanned = [];
let summary = null;
for (const url of directUrls) {
  await page.goto(url, { waitUntil: 'domcontentloaded' }); // allow-raw-playwright: read-only section navigation
  await humanIdlePause('long');
  await page.waitForSelector('input, textarea').catch(() => {}); // allow-raw-playwright: wait for read-only field audit
  const data = await page.evaluate((artifactSource) => {
    const re = new RegExp(artifactSource, 'i');
    const values = [];
    for (const el of document.querySelectorAll('input, textarea')) {
      const name = el.getAttribute('name') || '';
      if (name === 'table_search') continue;
      const value = el.value || '';
      if (!value) continue;
      const match = value.match(re);
      const matchIndex = match ? match.index ?? -1 : -1;
      values.push({
        name,
        len: value.length,
        prefix: value.slice(0, 220),
        artifact: Boolean(match),
        artifactSnippet: match ? value.slice(Math.max(0, matchIndex - 120), matchIndex + 220) : null,
      });
    }
    const summaryEl = Array.from(document.querySelectorAll('textarea')).find((e) => (e.name || '').endsWith('streszczenie_projektu'));
    return {
      values,
      fieldCount: values.length,
      url: location.href,
      summary: summaryEl ? {
        len: summaryEl.value.length,
        prefix: summaryEl.value.slice(0, 260),
        artifact: re.test(summaryEl.value),
      } : null,
    };
  }, artifactRe.source); // allow-raw-playwright: read field values only
  scanned.push({ url: data.url, fieldCount: data.fieldCount });
  for (const value of data.values.filter((v) => v.artifact)) hits.push({ url, ...value });
  if (data.summary) summary = { url, ...data.summary };
}

console.log(JSON.stringify({
  sectionCount: directUrls.length,
  scanned,
  summary,
  artifactHits: hits,
}, null, 2));
process.exit(0);
