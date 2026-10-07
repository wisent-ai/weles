// Read-only audit for replacement NCBR draft field values. Never writes or submits.

import { chromium } from 'playwright';
import { pageSettled } from '../../_shared/page/settled.mjs';

const endpoint = (await import('#ncbr-settings')).cdpEndpoint();
const projectId = (await import('#ncbr-settings')).projectId();
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


await page.goto(projectUrl, { waitUntil: 'domcontentloaded' }); // allow-raw-playwright: read-only navigation in authenticated LSI draft
await pageSettled(page);

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

if (!urls.length) {
  throw new Error(`${projectUrl} lists no projekt_step links: the audit reads the sections the project page shows and assumes none`);
}
const directUrls = urls;

const hits = [];
const scanned = [];
let summary = null;
for (const url of directUrls) {
  await page.goto(url, { waitUntil: 'domcontentloaded' }); // allow-raw-playwright: read-only section navigation
  await page.locator('input:not([name="table_search"]), textarea').filter({ visible: true }).first().waitFor({ state: 'visible' });
  await pageSettled(page);
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
        prefix: value,
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
        prefix: summaryEl.value,
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
