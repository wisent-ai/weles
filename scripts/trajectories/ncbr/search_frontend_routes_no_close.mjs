import { chromium } from 'playwright';

const endpoint = process.env.NCBR_BROWSER_ENDPOINT || 'http://127.0.0.1:9223';
const browser = await chromium.connectOverCDP(endpoint);
const context = browser.contexts()[0] || await browser.newContext();
const page = context.pages()[0] || await context.newPage();

const result = await page.evaluate(async () => {
  const scripts = Array.from(document.scripts)
    .map((s) => s.src)
    .filter((src) => src.includes('/js/') && src.endsWith('.js'));
  const terms = [
    'collection-objects',
    'registries-values',
    'project-registries',
    'GetProjectListRegistryValuesQuery',
    'koszty_posrednie',
    'rodzaj_metody_uproszczonej',
  ];
  const hits = [];
  for (const src of scripts) {
    const res = await fetch(src, { credentials: 'include' });
    const text = await res.text();
    const entry = { src, length: text.length, hits: [] };
    for (const term of terms) {
      const low = text.toLowerCase();
      let pos = low.indexOf(term.toLowerCase());
      let count = 0;
      while (pos >= 0 && count < 20) {
        const start = Math.max(0, pos - 700);
        const end = Math.min(text.length, pos + term.length + 1200);
        entry.hits.push({
          term,
          pos,
          snippet: text.slice(start, end).replace(/\s+/g, ' ').slice(0, 2200),
        });
        count += 1;
        pos = low.indexOf(term.toLowerCase(), pos + term.length);
      }
    }
    if (entry.hits.length) hits.push(entry);
  }
  return { href: location.href, scripts, hits };
});

console.log(JSON.stringify(result, null, 2));
process.exit(0);
